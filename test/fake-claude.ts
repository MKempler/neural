// A scripted stand-in for Claude Code. It starts the MCP server named in --mcp-config the way Claude Code
// would, receives channel events, and reacts to a few keywords so tests can drive each delivery path.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// `claude agents --json`: Claude Code's list of running sessions, here whatever the test put in the file.
if (process.argv[2] === 'agents') {
  const file = process.env.NEURAL_TEST_AGENTS
  process.stdout.write(file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]')
  process.exit(0)
}

const argv = process.argv.slice(2)
const arg = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
const name = arg('--name')
const sessionId = arg('--resume') ?? crypto.randomUUID()
const settings = JSON.parse(fs.readFileSync(arg('--settings')!, 'utf8'))
const mcpConfig = JSON.parse(fs.readFileSync(arg('--mcp-config')!, 'utf8')).mcpServers.neural

const hook = async (event: string, extra: Record<string, unknown> = {}) => {
  const url = settings.hooks?.[event]?.[0]?.hooks?.[0]?.url
  if (!url) return
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Like Claude Code, turn-end hooks carry the effort level.
    body: JSON.stringify({ session_id: sessionId, transcript_path: `/tmp/fake/${sessionId}.jsonl`, hook_event_name: event,
      ...(event === 'Stop' ? { effort: { level: 'high' } } : {}), ...extra }),
  }).catch(() => {})
}

// Split a chunk of terminal input into keys, the way a real TUI does.
function keysOf(chunk: string): string[] {
  return chunk.match(/\x1b\[200~|\x1b\[201~|\x1b[\[O][A-D]|[\s\S]/g) ?? []
}
const isDown = (k: string) => k === '\x1b[B' || k === '\x1bOB'
const isUp = (k: string) => k === '\x1b[A' || k === '\x1bOA'

process.stdin.setRawMode(true)

// Optional startup dialog, to exercise the spawner's dialog handling.
if (name?.startsWith('dlg') && !arg('--resume')) {
  const options = ['Exit', 'I am using this for local development']
  let selected = 0
  const draw = () => {
    console.clear()
    console.log('WARNING: Loading development channels\n')
    options.forEach((o, i) => console.log(`${i === selected ? '❯' : ' '} ${i + 1}. ${o}`))
  }
  draw()
  const choice: number = await new Promise(resolve => {
    process.stdin.on('data', d => {
      for (const k of keysOf(String(d))) {
        if (isDown(k)) selected = Math.min(selected + 1, options.length - 1)
        else if (isUp(k)) selected = Math.max(selected - 1, 0)
        else if (k === '\r') return resolve(selected)
        else if (/^[1-9]$/.test(k)) return resolve(Number(k) - 1)
        draw()
      }
    })
  })
  process.stdin.removeAllListeners('data')
  if (choice !== 1) process.exit(0)
  console.clear()
}

console.log(`fake claude "${name}" ${arg('--resume') ? 'resumed' : 'started'} ${sessionId}`)

const client = new Client({ name: 'fake-claude', version: '0' }, { capabilities: {} })
// Like Claude Code, announce each tool call to the PreToolUse hook first.
const call = async (tool: string, args: Record<string, unknown>) => {
  await hook('PreToolUse', { tool_name: `mcp__neural__${tool}`, tool_input: args })
  return client.callTool({ name: tool, arguments: args })
}
let interruptible: (() => void) | null = null

client.fallbackNotificationHandler = async (n: any) => {
  if (n.method === 'notifications/claude/channel/permission') {
    await call('reply', { text: `verdict: ${n.params.behavior}` })
    await hook('Stop', { last_assistant_message: 'Replied.' })
    return
  }
  if (n.method !== 'notifications/claude/channel') return
  const body: string = n.params.content
  const { msg_id, from } = n.params.meta
  console.log(`← hub: ${body}`)
  if (body.startsWith('silent')) return // as if the event had been dropped
  if (body.startsWith('slow')) {
    // A long turn that only ends when Esc is pressed in the terminal.
    await hook('UserPromptSubmit', { prompt: body })
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Running the test suite' } })
    interruptible = () => void hook('Stop', { last_assistant_message: 'Interrupted.' })
    return
  }
  await hook('UserPromptSubmit', { prompt: `<channel source="neural" from="${from}" msg_id="${msg_id}">\n${body}\n</channel>` })
  if (body.startsWith('echo:')) return hook('Stop', { last_assistant_message: 'Noted.' }) // don't ping-pong between sessions
  if (body.startsWith('noreply')) return hook('Stop', { last_assistant_message: `terminal answer to ${msg_id}` })
  if (body.startsWith('usage ')) {
    // Run the status line the way Claude Code does, with a reading as JSON on stdin, and report what it printed.
    const out = execFileSync('/bin/sh', ['-c', settings.statusLine.command], { input: body.slice(6) }).toString().trim()
    await call('reply', { text: `status line: ${out}`, in_reply_to: msg_id })
    return hook('Stop', { last_assistant_message: 'Replied.' })
  }
  if (body.startsWith('perm')) {
    return client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' },
    } as any)
  }
  if (body.startsWith('tell ')) {
    const [, to, ...rest] = body.split(' ')
    const r: any = await call('send_message', { to, text: rest.join(' ') })
    console.log(r.content[0].text)
    return hook('Stop', { last_assistant_message: 'Sent.' })
  }
  if (body.startsWith('tool ')) {
    const [, tool, json] = body.match(/^tool (\S+) (.*)$/s)!
    const r: any = await call(tool, JSON.parse(json))
    await call('reply', { text: (r.isError ? 'ERROR ' : '') + r.content[0].text, in_reply_to: msg_id })
    return hook('Stop', { last_assistant_message: 'Replied.' })
  }
  // The user and Neural itself are answered with reply; another session with send_message.
  const toUser = !from.startsWith('session:')
  await call(toUser ? 'reply' : 'send_message', {
    ...(toUser ? {} : { to: from.replace(/^session:/, '') }),
    text: `echo: ${body}`,
    in_reply_to: msg_id,
  })
  await hook('Stop', { last_assistant_message: 'Replied.' })
}

await client.connect(new StdioClientTransport({ command: mcpConfig.command, args: mcpConfig.args, env: { ...process.env, ...mcpConfig.env } }))
await hook('SessionStart', { source: arg('--resume') ? 'resume' : 'startup' })

// Text typed or pasted into the terminal is a prompt, submitted with Enter. Like Claude Code, this asks the
// terminal for bracketed paste, so newlines inside a paste do not submit it.
process.stdout.write('\x1b[?2004h')
let typed = ''
let pasting = false
process.stdin.on('data', async d => {
  for (const k of keysOf(String(d))) {
    if (k === '\x1b[200~') pasting = true
    else if (k === '\x1b[201~') pasting = false
    else if (k === '\x03') process.exit(130)
    else if (k === '\x1b' && interruptible) {
      const stop = interruptible
      interruptible = null
      stop()
    }
    else if (k === '\r' && !pasting) {
      const text = typed.trim()
      typed = ''
      if (!text) continue
      console.log(`> ${text}`)
      await hook('UserPromptSubmit', { prompt: text })
      await call('reply', { text: `pasted: ${text.replace(/\s+/g, ' ')}` })
      await hook('Stop', { last_assistant_message: 'Replied.' })
    } else typed += k === '\r' ? '\n' : k
  }
})
