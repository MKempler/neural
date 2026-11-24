import { prefs } from './db.ts'
import { launchFields, mergeServers } from './spawner.ts'

// Role templates: named presets for spawn_session (model, effort, MCP servers, priority, handoff threshold and a
// starting-instructions snippet), so the orchestrator says template "qa" instead of repeating the settings.
// Kept in prefs; the seeds below apply until the first edit.

export interface Template {
  description?: string
  model?: string
  effort?: string
  mcp_servers?: Record<string, unknown>
  priority?: 'high' | 'normal' | 'low'
  fresh_context?: boolean
  fresh_at_percent?: number
  fresh_at_tokens?: number
  instructions?: string
}

const KEY = 'roleTemplates'

export const SEEDS: Record<string, Template> = {
  builder: { description: 'Writes and changes code', model: 'opus', effort: 'medium' },
  qa: { description: 'Reviews and tests work for bugs', model: 'opus', effort: 'high' },
  research: { description: 'Researches and writes reports; work that can wait', model: 'opus', effort: 'high', priority: 'low' },
}

export function all(): Record<string, Template> {
  return prefs.get<Record<string, Template>>(KEY) ?? structuredClone(SEEDS)
}

export function get(name: string): Template {
  const t = all()[name]
  if (!t) throw new Error(`no template "${name}" (have: ${Object.keys(all()).join(', ') || 'none'})`)
  return t
}

const FIELDS = ['description', 'model', 'effort', 'mcp_servers', 'priority', 'fresh_context', 'fresh_at_percent', 'fresh_at_tokens', 'instructions'] as const

/** Check a template's fields, throwing on anything spawn_session would refuse. */
function check(t: Record<string, unknown>): Template {
  for (const k of Object.keys(t)) if (!(FIELDS as readonly string[]).includes(k)) throw new Error(`unknown template field "${k}" (fields: ${FIELDS.join(', ')})`)
  launchFields({ model: t.model, effort: t.effort })
  if (t.mcp_servers !== undefined) mergeServers(null, t.mcp_servers)
  if (t.priority !== undefined && !['high', 'normal', 'low'].includes(String(t.priority))) throw new Error('priority must be high, normal or low')
  if (t.fresh_context !== undefined && typeof t.fresh_context !== 'boolean') throw new Error('fresh_context must be true or false')
  if (t.fresh_at_percent !== undefined && !(Number(t.fresh_at_percent) >= 5 && Number(t.fresh_at_percent) <= 95)) throw new Error('fresh_at_percent must be between 5 and 95')
  if (t.fresh_at_tokens !== undefined && !(Number(t.fresh_at_tokens) >= 20_000)) throw new Error('fresh_at_tokens must be at least 20000')
  for (const k of ['description', 'instructions', 'model', 'effort'] as const) if (t[k] !== undefined && typeof t[k] !== 'string') throw new Error(`${k} must be text`)
  return t as Template
}

/** Add or edit a template: fields are merged into what it has, a null field is removed; null removes the template. */
export function set(name: string, fields: Record<string, unknown> | null, replace = false): Template | null {
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error('template name must be lowercase letters, digits, - or _ (up to 32 characters)')
  const list = all()
  if (fields === null) {
    if (!list[name]) throw new Error(`no template "${name}"`)
    delete list[name]
    prefs.set(KEY, list)
    return null
  }
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be an object')
  const next: Record<string, unknown> = replace ? {} : { ...list[name] }
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) delete next[k]
    else next[k] = v
  }
  list[name] = check(next)
  prefs.set(KEY, list)
  return list[name]
}

/** spawn_session's arguments with a template's settings filled in where the call left them out. */
export function apply(args: Record<string, any>): Record<string, any> {
  if (!args.template) return args
  const t = get(String(args.template))
  const out = { ...args }
  for (const k of ['model', 'effort', 'mcp_servers', 'priority', 'fresh_context'] as const) {
    if (out[k] === undefined && t[k] !== undefined) out[k] = t[k]
  }
  if (t.fresh_at_percent !== undefined || t.fresh_at_tokens !== undefined) {
    out.fresh_at = { percent: t.fresh_at_percent, tokens: t.fresh_at_tokens }
    if (out.fresh_context === undefined) out.fresh_context = true
  }
  if (t.instructions) out.initial_prompt = out.initial_prompt ? `${t.instructions}\n\n${out.initial_prompt}` : t.instructions
  return out
}
