// Claude's questions (AskUserQuestion) and plans waiting for approval (ExitPlanMode), answered from the app.
// The hub types the answer into the dialog in the session's terminal; if that dialog has gone or looks
// different, the card says so and the terminal is one tap away.
import { useState } from 'preact/hooks'
import { html, markdown } from '../lib.js'
import { Icon } from '../icons.js'
import { Dot, Link } from './parts.js'
import { answer, navigate, sessionPath, sessions } from '../store.js'

/** Open questions worth showing: the session is still running. */
export const live = (list, name) => list.filter(q => (!name || q.session === name) && !['stopped', 'exited'].includes(sessions.value[q.session]?.status))

export function QuestionCard({ q, showSession = false }) {
  return q.kind === 'plan' ? html`<${PlanCard} q=${q} showSession=${showSession} />` : html`<${AskCard} q=${q} showSession=${showSession} />`
}

function useSubmit(q) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async body => {
    setBusy(true)
    setError('')
    try {
      await answer(q.id, body)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

function Head({ q, showSession, label }) {
  return html`<div class="ask-head">
    <${Dot} status="blocked" />
    ${showSession && html`<${Link} href=${sessionPath(q.session)} class="who">${q.session}</${Link}>`}
    <span class="what">${label}</span>
  </div>`
}

function Failure({ q, error }) {
  if (!error) return null
  return html`<div class="ask-error">
    <span>${error}</span>
    <button type="button" class="btn sm" onClick=${() => navigate(sessionPath(q.session, 'terminal'))}><${Icon} name="terminal" />Terminal</button>
  </div>`
}

function AskCard({ q, showSession }) {
  const qs = q.payload.questions ?? []
  const [picks, setPicks] = useState(() => qs.map(() => []))
  const [texts, setTexts] = useState(() => qs.map(() => ''))
  const { busy, error, submit } = useSubmit(q)
  // One single-choice question: a tap answers it, as in the terminal.
  const instant = qs.length === 1 && !qs[0].multiSelect

  const pick = (i, k) => {
    const one = qs[i].multiSelect ? (picks[i].includes(k) ? picks[i].filter(x => x !== k) : [...picks[i], k]) : [k]
    const next = picks.map((p, j) => (j === i ? one : p))
    setPicks(next)
    if (!qs[i].multiSelect) setTexts(texts.map((t, j) => (j === i ? '' : t)))
    if (instant) submit({ answers: [{ choose: [k] }] })
  }
  const type = (i, value) => {
    setTexts(texts.map((t, j) => (j === i ? value : t)))
    if (value && !qs[i].multiSelect) setPicks(picks.map((p, j) => (j === i ? [] : p)))
  }
  const complete = qs.every((qq, i) => (qq.multiSelect ? picks[i].length > 0 : picks[i].length === 1 || texts[i].trim()))
  const send = e => {
    e?.preventDefault()
    if (!complete || busy) return
    submit({ answers: qs.map((qq, i) => (texts[i].trim() && !qq.multiSelect ? { text: texts[i].trim() } : { choose: picks[i] })) })
  }

  return html`<form class="ask" onSubmit=${send}>
    <${Head} q=${q} showSession=${showSession} label=${qs.length > 1 ? `asks ${qs.length} questions` : 'asks'} />
    ${qs.map((qq, i) => html`<div class="ask-q" key=${i}>
      <div class="ask-text">${qq.header && html`<span class="tag">${qq.header}</span>`}<span>${qq.question}</span></div>
      ${qq.multiSelect && html`<div class="hint">Pick any</div>`}
      <div class="ask-options">
        ${qq.options.map((o, k) => html`<button type="button" key=${k} disabled=${busy}
          class=${`ask-option ${picks[i].includes(k) ? 'on' : ''}`} aria-pressed=${picks[i].includes(k)} onClick=${() => pick(i, k)}>
          <span class="opt-label">${qq.multiSelect && html`<span class="box">${picks[i].includes(k) ? '✓' : ''}</span>`}${o.label}</span>
          ${o.description && o.description !== o.label && html`<span class="desc">${o.description}</span>`}
        </button>`)}
      </div>
      ${!qq.multiSelect && html`<div class="ask-other">
        <input class="input" placeholder="Or type your own answer" value=${texts[i]} disabled=${busy} maxLength="2000"
          onInput=${e => type(i, e.currentTarget.value)} />
        ${instant && html`<button class="btn sm" disabled=${!texts[0].trim() || busy}>Send</button>`}
      </div>`}
    </div>`)}
    ${!instant && html`<div class="ask-foot"><button class="btn primary sm" disabled=${!complete || busy}>${busy ? 'Answering…' : 'Send answers'}</button></div>`}
    ${instant && busy && html`<div class="hint">Answering…</div>`}
    <${Failure} q=${q} error=${error} />
  </form>`
}

function PlanCard({ q, showSession }) {
  const [changes, setChanges] = useState('')
  const [open, setOpen] = useState(!showSession)
  const { busy, error, submit } = useSubmit(q)
  return html`<div class="ask plan">
    <${Head} q=${q} showSession=${showSession} label="has a plan for you to approve" />
    <div class=${`plan-body ${open ? 'open' : ''}`}>
      <div class="md" dangerouslySetInnerHTML=${{ __html: markdown(q.payload.plan || '(empty plan)') }} />
    </div>
    ${!open && html`<button type="button" class="btn ghost sm" onClick=${() => setOpen(true)}>Show the whole plan</button>`}
    <div class="ask-foot">
      <button type="button" class="btn primary sm" disabled=${busy} onClick=${() => submit({ approve: true })}>Approve</button>
      <button type="button" class="btn sm" disabled=${busy} title="Approve, but ask before each edit" onClick=${() => submit({ approve: true, manual: true })}>Approve, review edits</button>
    </div>
    <form class="ask-other" onSubmit=${e => { e.preventDefault(); changes.trim() && submit({ approve: false, feedback: changes.trim() }) }}>
      <input class="input" placeholder="Or say what to change" value=${changes} disabled=${busy} maxLength="2000" onInput=${e => setChanges(e.currentTarget.value)} />
      <button class="btn sm" disabled=${!changes.trim() || busy}>Send</button>
    </form>
    <${Failure} q=${q} error=${error} />
  </div>`
}
