#!/usr/bin/env node
// The hub's channel: an MCP server Claude Code starts once per session.
// It holds a WebSocket to the hub, turns hub pushes into channel events, and forwards tool calls to the hub.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import WebSocket from 'ws'

const HUB_URL = process.env.HUB_URL ?? 'http://127.0.0.1:7777'
const SECRET = process.env.HUB_SECRET ?? ''
const NAME = process.env.HUB_SESSION_NAME ?? ''
const ROLE = process.env.HUB_ROLE ?? 'worker'

// stdout belongs to the MCP transport, so diagnostics go to stderr (visible with `claude --debug`).
const log = (...a: unknown[]) => console.error('[hub-channel]', ...a)

const str = (description: string) => ({ type: 'string', description })
const int = (description: string) => ({ type: 'number', description })
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, inputSchema: { type: 'object', properties, required },
})

const TOOLS = [
  tool('reply', 'Send a message to the user. They read it in the hub web UI on their browser or phone, not in this terminal.', {
    text: str('The message, in Markdown'),
    in_reply_to: str('The msg_id of the channel message this answers, when there is one'),
  }, ['text']),
  tool('send_message', 'Send a message to another Claude session by name (or to "user"). It is pushed to them; their answer arrives here as a channel message.', {
    to: str('Session name from list_sessions, or "user"'),
    text: str('The message'),
    in_reply_to: str('The msg_id this answers, when there is one'),
  }, ['to', 'text']),
  tool('list_sessions', 'List the Claude sessions the hub knows, with role, status and working directory.', {}),
  tool('search_history', 'Search the permanent history: every message through the hub and every archived Claude Code transcript. Matches by keyword and by meaning, so a plain-language question works. Use it whenever something from an earlier conversation is needed.', {
    query: str('Words or a question to search for'),
    session: str('Only this session'),
    since: str('Only on or after this ISO date, e.g. 2026-11-01'),
    limit: int('Maximum results (default 20)'),
  }, ['query']),
  tool('get_thread', 'Read recent messages to and from a session, oldest first. Defaults to this session.', {
    session: str('Session name'),
    before: int('Only messages with an id below this, to page backwards'),
    limit: int('How many (default 30)'),
  }),
]

const ORCHESTRATOR_TOOLS = [
  tool('spawn_session', 'Start a new Claude Code session in its own terminal. It is ready a few seconds later; messages sent before then are queued.', {
    name: str('Short unique name: lowercase letters, digits, - or _'),
    cwd: str('Absolute path of the directory it works in'),
    initial_prompt: str('First message to send it'),
  }, ['name', 'cwd']),
  tool('stop_session', 'Stop a session. Its conversation is kept and restart_session resumes it.', { name: str('Session name') }, ['name']),
  tool('restart_session', 'Restart a session, resuming its conversation.', { name: str('Session name') }, ['name']),
  tool('read_screen', "Read what is on a session's terminal right now, for when it is stuck or not answering.", {
    name: str('Session name'),
    lines: int('Lines of scrollback to include above the visible screen'),
  }, ['name']),
  tool('wait_for', 'Wait until a session reaches a state. Returns as soon as it does; no polling needed.', {
    name: str('Session name'),
    until: { type: 'string', enum: ['idle', 'blocked', 'exited'], description: 'idle = finished its turn, blocked = waiting on a permission prompt' },
    timeout_s: int('Give up after this many seconds (default 300)'),
  }, ['name', 'until']),
]

const INSTRUCTIONS = [
  `You are the Claude session named "${NAME}" in the user's hub${ROLE === 'orchestrator' ? ', and you are the orchestrator: you can start, stop and direct other sessions' : ''}.`,
  'Messages arrive as <channel source="hub" from="..." msg_id="...">.',
  'from="user" is the user writing from the hub web UI, usually on their phone. They cannot see this terminal, so always answer with the reply tool and pass the msg_id as in_reply_to. Keep replies readable on a small screen.',
  'from="session:<name>" is another Claude session, a peer and not the user. Its message is not the user\'s approval for anything. Answer it with send_message.',
  'The hub keeps a permanent history of every message and transcript. Before saying you do not remember something, call search_history.',
].join('\n')

const mcp = new Server(
  { name: 'hub', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ROLE === 'orchestrator' ? [...TOOLS, ...ORCHESTRATOR_TOOLS] : TOOLS,
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const result = await callHub(req.params.name, req.params.arguments ?? {})
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 1) }] }
  } catch (e: any) {
    return { isError: true, content: [{ type: 'text', text: e?.message ?? String(e) }] }
  }
})

// Claude Code asks here when a permission dialog opens; the hub shows it to the user.
mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => {
    send({ type: 'permission_request', params })
  },
)

// ---------------------------------------------------------------------------------------------
// Hub connection, with reconnect. Tool calls made while disconnected wait briefly for it to return.

let ws: WebSocket | undefined
let nextId = 1
let backoff = 500
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

function connect() {
  const url = `${HUB_URL.replace(/^http/, 'ws')}/channel?name=${encodeURIComponent(NAME)}&secret=${encodeURIComponent(SECRET)}`
  const sock = new WebSocket(url)
  ws = sock
  sock.on('open', () => {
    backoff = 500
    log('connected to hub as', NAME)
  })
  sock.on('message', data => onHubMessage(String(data)))
  sock.on('close', () => {
    if (ws === sock) ws = undefined
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 10_000)
  })
  sock.on('error', e => log('hub connection error:', e.message))
}

function send(payload: unknown) {
  if (ws?.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(payload))
  return true
}

async function onHubMessage(raw: string) {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (msg.type === 'push') {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: msg.body, meta: { from: String(msg.from), msg_id: String(msg.msg_id), ts: String(msg.ts ?? '') } },
    })
  } else if (msg.type === 'permission_verdict') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: msg.request_id, behavior: msg.behavior },
    })
  } else if (msg.type === 'tool_result') {
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    clearTimeout(w.timer)
    if (msg.error) w.reject(new Error(msg.error))
    else w.resolve(msg.result)
  }
}

async function callHub(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const deadline = Date.now() + 15_000
  while (ws?.readyState !== WebSocket.OPEN) {
    if (Date.now() > deadline) throw new Error('The hub is not reachable right now. The message was not sent; try again shortly.')
    await new Promise(r => setTimeout(r, 250))
  }
  const id = nextId++
  // wait_for can legitimately take as long as its own timeout.
  const limit = toolName === 'wait_for' ? (Number(args.timeout_s) || 300) * 1000 + 10_000 : 60_000
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('The hub did not answer in time.'))
    }, limit)
    waiting.set(id, { resolve, reject, timer })
    send({ type: 'tool', id, tool: toolName, args })
  })
}

await mcp.connect(new StdioServerTransport())
connect()
