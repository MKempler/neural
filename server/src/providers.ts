import { execFile } from 'node:child_process'

// Model providers a session can run Claude Code on. 'anthropic' is Claude Code's own login and the default.
// Others are Anthropic-compatible endpoints: Claude Code talks to them through ANTHROPIC_BASE_URL, with a key that
// is read from the macOS Keychain inside the session's own shell at launch, so it never passes through Neural (not
// its database, logs, files, the tmux command line or the terminal). They have no Channels, so messages are typed
// into the terminal instead, and their spend is metered from transcript token counts at list prices.

export interface Price { input: number; cached: number; output: number } // $ per 1M tokens

export interface Provider {
  name: string
  baseUrl: string
  /** Keychain service holding the key (`security add-generic-password -s <keychain> -a "$USER" -w`). */
  keychain: string
  /** How the model id is spelled in full; a short name ("deepseek-v4p1-flash") gets this prefix. */
  modelPrefix: string
  defaultModel: string
  prices: Record<string, Price> // by short model name
}

export const PROVIDERS: Record<string, Provider> = {
  fireworks: {
    name: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference',
    keychain: 'neural-fireworks',
    modelPrefix: 'accounts/fireworks/models/',
    defaultModel: 'deepseek-v4p1-flash',
    // fireworks.ai/pricing, read 2026-11-25.
    prices: {
      'kimi-k3p1-pro': { input: 2.0, cached: 0.2, output: 10.0 },
      'glm-5p3': { input: 1.4, cached: 0.26, output: 4.4 },
      'glm-5p3-flash': { input: 0.15, cached: 0.03, output: 0.5 },
      'deepseek-v4p1-flash': { input: 0.3, cached: 0.006, output: 1.2 },
    },
  },
}

export const NAMES = ['anthropic', ...Object.keys(PROVIDERS)]

/** The provider a session runs on, or null for Anthropic. */
export function of(provider: string | null | undefined): Provider | null {
  return provider ? PROVIDERS[provider] ?? null : null
}

const SHORT = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** The full model id for a provider's model, given in short or full form. Throws on anything else. */
export function fullModel(p: Provider, model: string | null | undefined): string {
  const m = model || p.defaultModel
  const short = m.startsWith(p.modelPrefix) ? m.slice(p.modelPrefix.length) : m
  if (!SHORT.test(short)) throw new Error(`model for ${p.name} must be a model name like ${p.defaultModel} or ${p.modelPrefix}${p.defaultModel}`)
  return p.modelPrefix + short
}

/** Environment for a Claude Code process on this provider. The key is not in it: see launchCommand. */
export function env(p: Provider, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    ENABLE_TOOL_SEARCH: 'true',
  }
}

/** Wrap a launch argv so the shell tmux runs reads the key from the Keychain into the process's environment.
 *  Only the lookup command is on the command line; a failed lookup ends the launch with a message. */
export function wrap(p: Provider, argv: string[]): string[] {
  // Tests stand in a command of their own (NEURAL_KEY_COMMAND) for the Keychain lookup.
  const read = process.env.NEURAL_KEY_COMMAND || `security find-generic-password -s ${p.keychain} -w`
  const script = `k=$(${read} 2>/dev/null) || { echo "No ${p.name} key in the Keychain (service ${p.keychain})."; exit 78; }; ANTHROPIC_AUTH_TOKEN=$k; export ANTHROPIC_AUTH_TOKEN; unset k; exec "$@"`
  return ['/bin/sh', '-c', script, 'neural-launch', ...argv]
}

/** Is the provider's key in the Keychain? Checks without reading the key. */
export function hasKey(p: Provider): Promise<boolean> {
  if (process.env.NEURAL_KEY_COMMAND) return Promise.resolve(true)
  return new Promise(resolve => execFile('security', ['find-generic-password', '-s', p.keychain], err => resolve(!err)))
}

/** List-price cost of one reply's usage. These endpoints count cached tokens inside input_tokens. */
export function costOf(p: Provider, model: string, u: any) {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const short = model.startsWith(p.modelPrefix) ? model.slice(p.modelPrefix.length) : model
  const price = p.prices[short] ?? p.prices[p.defaultModel]
  const cached = n(u?.cache_read_input_tokens)
  const total = n(u?.input_tokens)
  const fresh = (total >= cached ? total - cached : total) + n(u?.cache_creation_input_tokens)
  const output = n(u?.output_tokens)
  return { input: fresh, cached, output, cost: (fresh * price.input + cached * price.cached + output * price.output) / 1e6 }
}
