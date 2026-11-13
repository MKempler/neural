// Keep secrets out of the permanent archive. Tokens, keys and passwords pasted into a chat or printed in a
// session would otherwise sit in the database (and its backups) forever, searchable. Each is replaced with
// "[redacted <kind>]" before it's stored. Only clear formats are matched, so ordinary text and code are left
// alone; that means an unusual secret can still get through, and rotating a leaked one remains the real fix.

interface Rule { kind: string; re: RegExp; keep?: number } // keep: how many leading groups to leave in place

const RULES: Rule[] = [
  { kind: 'private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { kind: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Stripe key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}/g },
  { kind: 'AWS key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // user:password@host in a URL: only the password goes.
  { kind: 'password', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'\\]+:)([^\s@/"'\\]{6,})(?=@)/g, keep: 1 },
  { kind: 'token', re: /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g, keep: 1 },
  // password=…, "api_key": "…", TOKEN: … with a long value of letters and digits (not code like process.env.X).
  {
    kind: 'secret',
    re: /(\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?secret)[\w-]*\\?["']?\s*[:=]\s*\\?["']?)((?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{16,}={0,2})/gi,
    keep: 1,
  },
]

/** Replace the secrets in `text`; `found` lists the kind of each one. */
export function redact(text: string): { text: string; found: string[] } {
  const found: string[] = []
  if (!text) return { text, found }
  let out = text
  for (const r of RULES) {
    out = out.replace(r.re, (match, ...groups) => {
      // Already redacted (a value that is itself a placeholder) or a run of one character: leave it.
      if (match.includes('[redacted')) return match
      found.push(r.kind)
      const kept = r.keep ? groups.slice(0, r.keep).join('') : ''
      return `${kept}[redacted ${r.kind}]`
    })
  }
  return { text: out, found }
}

/** Just the redacted text. */
export const clean = (text: string) => redact(text).text
