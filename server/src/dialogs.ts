// Answering Claude Code's question and plan-approval dialogs from the app. The answer is typed into the dialog
// in the session's terminal, one key at a time, the way a person would. Nothing is guessed: before each step the
// screen is read again, and if the expected dialog isn't there the answer stops with an error, leaving the
// terminal for the user.
//
// What the dialogs look like (Claude Code 2.1):
//   AskUserQuestion   "Which color?" then "❯ 1. Red", "2. Green", … "N. Type something.", "N+1. Chat about this".
//                     A number picks an option (single choice) or ticks it (multiple choice; then "Submit" below
//                     the list). "Type something." takes typed text and Enter. With several questions, a review
//                     screen ("Ready to submit your answers?" "1. Submit answers") comes last.
//   ExitPlanMode      the plan, then "Would you like to proceed?" "❯ 1. Yes, and use auto mode",
//                     "2. Yes, manually approve edits", "3. Tell Claude what to change" (takes typed text).
import type { Mux } from './mux/mux.ts'

export interface Choice { n: string; label: string; line: number; cursor: boolean }

const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** The numbered options of a dialog, from the first line matching `after` on (or the whole screen). */
export function dialogOptions(screen: string, after?: RegExp | string): Choice[] {
  const lines = screen.split('\n')
  let from = 0
  if (after !== undefined) {
    from = typeof after === 'string' ? anchorLine(lines, after) : lines.findLastIndex(l => after.test(l))
    if (from === -1) return []
  }
  const out: Choice[] = []
  for (let i = from; i < lines.length; i++) {
    const m = /^\s*(❯|>)?\s*(\d+)\.\s+(?:\[[^\]]*\]\s+)?(.*?)\s*$/.exec(lines[i])
    if (m) out.push({ n: m[2], label: m[3], line: i, cursor: Boolean(m[1]) })
  }
  return out
}

/** The last line where `text` (a question, possibly wrapped over several lines) starts. */
function anchorLine(lines: string[], text: string): number {
  const want = flat(text).slice(0, 40)
  for (let i = lines.length - 1; i >= 0; i--) {
    // Join this line with the next two, for a question wrapped by the terminal.
    if (flat(lines.slice(i, i + 3).join(' ')).startsWith(want)) return i
  }
  return -1
}

export const showsQuestion = (screen: string, question: string) =>
  anchorLine(screen.split('\n'), question) !== -1 && /esc to cancel/i.test(screen)
export const showsPlan = (screen: string) => /would you like to proceed\?/i.test(screen)

export type QuestionAnswer = { choose?: number[]; text?: string }
export type PlanAnswer = { approve: true; manual?: boolean } | { approve: false; feedback: string }

interface Question { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

/** Check answers against the questions before touching the terminal. */
export function checkAnswers(qs: Question[], answers: QuestionAnswer[]) {
  if (!Array.isArray(answers) || answers.length !== qs.length) throw new Error('answer every question')
  answers.forEach((a, i) => {
    const q = qs[i]
    const choose = a?.choose ?? []
    const text = String(a?.text ?? '').trim()
    if (!Array.isArray(choose) || choose.some(c => !Number.isInteger(c) || c < 0 || c >= q.options.length)) throw new Error(`no such option in "${q.question}"`)
    if (q.multiSelect) {
      if (text) throw new Error('typed answers are only for single-choice questions')
      if (!choose.length) throw new Error(`pick at least one option for "${q.question}"`)
    } else if ((choose.length === 1) === Boolean(text) || choose.length > 1) {
      throw new Error(`pick one option, or type an answer, for "${q.question}"`)
    }
    if (text.length > 2000) throw new Error('that answer is too long')
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class Driver {
  private mux: Mux
  private name: string
  constructor(mux: Mux, name: string) {
    this.mux = mux
    this.name = name
  }

  private async key(k: string) {
    await this.mux.sendKeys(this.name, [k])
    await sleep(180)
  }

  /** Read the screen until `ok` holds, for up to `ms`. */
  private async waitFor(ok: (screen: string) => boolean, ms = 4000): Promise<string | null> {
    const end = Date.now() + ms
    for (;;) {
      const screen = await this.mux.capture(this.name)
      if (ok(screen)) return screen
      if (Date.now() > end) return null
      await sleep(250)
    }
  }

  async answerQuestions(qs: Question[], answers: QuestionAnswer[]) {
    checkAnswers(qs, answers)
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i]
      const a = answers[i]
      const screen = await this.waitFor(s => showsQuestion(s, q.question))
      if (!screen) throw new Error(`"${q.question}" isn't showing in the terminal any more`)
      const opts = dialogOptions(screen, q.question)
      const find = (label: string) => opts.find(o => flat(o.label) === flat(label)) ?? opts.find(o => flat(o.label).startsWith(flat(label)))
      if (a.text?.trim()) {
        const other = opts.find(o => /^type something/i.test(o.label)) ?? opts[q.options.length]
        if (!other) throw new Error('the dialog has no place to type an answer')
        await this.key(other.n)
        await this.mux.type(this.name, a.text.trim().replace(/\s*\n\s*/g, ' '))
        await sleep(250)
        await this.key('Enter')
      } else if (!q.multiSelect) {
        const o = find(q.options[a.choose![0]].label)
        if (!o) throw new Error(`can't find "${q.options[a.choose![0]].label}" in the dialog`)
        await this.key(o.n)
      } else {
        for (const c of a.choose!) {
          const o = find(q.options[c].label)
          if (!o) throw new Error(`can't find "${q.options[c].label}" in the dialog`)
          await this.key(o.n)
        }
        // Then down to "Submit" (or "Next") under the list, checking where the cursor is at each step.
        let done = false
        for (let step = 0; step < q.options.length + 4 && !done; step++) {
          const now = await this.mux.capture(this.name)
          const cursor = now.split('\n').find(l => /^\s*❯/.test(l)) ?? ''
          if (/^\s*❯\s*(submit|next)\b/i.test(cursor)) {
            await this.key('Enter')
            done = true
          } else await this.key('Down')
        }
        if (!done) throw new Error(`couldn't find Submit under "${q.question}"`)
      }
      await sleep(350)
    }
    if (qs.length > 1) {
      const review = await this.waitFor(s => /ready to submit your answers/i.test(s))
      if (!review) throw new Error("the answers' review screen didn't appear")
      const submit = dialogOptions(review, /ready to submit your answers/i).find(o => /^submit/i.test(o.label))
      if (!submit) throw new Error('no Submit option on the review screen')
      await this.key(submit.n)
    }
  }

  async answerPlan(answer: PlanAnswer) {
    const screen = await this.waitFor(showsPlan)
    if (!screen) throw new Error("the plan approval isn't showing in the terminal any more")
    const opts = dialogOptions(screen, /would you like to proceed\?/i)
    if (answer.approve) {
      const yes = opts.filter(o => /^yes\b/i.test(o.label))
      const o = (answer.manual ? yes.find(o => /manual/i.test(o.label)) : yes.find(o => !/manual/i.test(o.label))) ?? yes[0]
      if (!o) throw new Error('no approve option in the dialog')
      await this.key(o.n)
    } else {
      const feedback = String(answer.feedback ?? '').trim()
      if (!feedback) throw new Error('say what to change')
      const o = opts.find(o => /tell claude|keep planning|^no\b/i.test(o.label))
      if (!o) throw new Error('no option to ask for changes in the dialog')
      await this.key(o.n)
      await this.mux.type(this.name, feedback.replace(/\s*\n\s*/g, ' '))
      await sleep(250)
      await this.key('Enter')
    }
  }
}
