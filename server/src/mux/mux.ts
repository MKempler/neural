// The small set of things the hub needs from a terminal multiplexer.
// tmux implements it today; another host (herdr, a pty pool) can be added behind the same interface.
export interface Mux {
  /** Start `argv` in a detached terminal named `name`. */
  spawn(name: string, cwd: string, argv: string[], env: Record<string, string>): Promise<void>
  /** True while the process started by spawn is still running. */
  alive(name: string): Promise<boolean>
  /** The visible screen plus up to `history` lines of scrollback, as plain text. */
  capture(name: string, history?: number): Promise<string>
  /** Send named keys (Enter, Escape, Up, C-c, …) or literal characters. */
  sendKeys(name: string, keys: string[]): Promise<void>
  /** Type text literally, without pressing Enter. */
  type(name: string, text: string): Promise<void>
  /** Paste text as if the user pasted it, then press Enter. */
  paste(name: string, text: string): Promise<void>
  /** Kill the terminal and its process. */
  kill(name: string): Promise<void>
  /** Names of terminals this mux currently holds. */
  list(): Promise<string[]>
}
