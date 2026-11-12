# Claude Hub

Run several Claude Code sessions on this Mac and talk to all of them from a browser or phone.

- One session, `main`, is the **orchestrator**. It has tools to start, message, inspect and stop the others.
- Messages you type in the web UI are **pushed** into the session through a Claude Code
  [channel](https://code.claude.com/docs/en/channels-reference), so the session never polls for them.
- Sessions can message each other, and every message is stored in a SQLite database.
- Every Claude Code transcript on the machine is archived into the same database, so history stays
  searchable after Claude Code's 30-day cleanup. Sessions search it with the `search_history` tool.

## Requirements

Node 22.18 or newer, tmux (`brew install tmux`), and Claude Code signed in with a claude.ai account.
Run `bin/hub doctor` to check.

## Start

```sh
npm install
bin/hub start        # web UI on http://127.0.0.1:7777
```

The first start launches `main` in `~/.local/share/claude-hub/orchestrator`. Each session runs in its own
tmux window on a dedicated tmux server, so closing your terminal does not stop it.

```sh
bin/hub status           # sessions and their state
bin/hub attach main      # open a session's terminal; detach with Ctrl+B then D
```

Sessions are launched with `--dangerously-load-development-channels server:hub`, because custom channels are
not on the research-preview allowlist. Claude Code shows a confirmation dialog for that flag on every launch;
the hub answers it, along with the folder-trust dialog. If a session shows **Needs attention**, open its
terminal view in the UI and answer whatever it is waiting for.

## How a message travels

| Path | Normally | If that fails |
| :- | :- | :- |
| You to a session | Pushed as a channel event | Stays queued while the session is down. If a push shows no sign of being read, it is pasted into the terminal. |
| Session to you | The `reply` tool | The final text of the turn is captured by a `Stop` hook and shown, marked "from the terminal". |
| Session to session | The `send_message` tool, routed through the hub | Queued until the other session is ready. |
| Permission prompts | Allow / Deny card in the UI | Answer in the terminal view. |

Session state (working, idle, waiting for approval) comes from Claude Code hooks that post to the hub. A
session that crashes, or that was running before a reboot, is restarted with `claude --resume`, up to five
times with a growing delay. A session you stop stays stopped.

Nothing is added to your global Claude Code settings: the channel server and hooks are passed to each
session on its command line from files in `~/.local/share/claude-hub/run`.

## Tools a session gets

All sessions: `reply`, `send_message`, `list_sessions`, `search_history`, `get_thread`.
Orchestrator only: `spawn_session`, `stop_session`, `restart_session`, `read_screen`, `wait_for`.

## Phone access

The hub listens on localhost only. To reach it from a phone, install Tailscale on the Mac and the phone and
publish the port to your tailnet:

```sh
tailscale serve --bg 7777
```

Serve has to be enabled once for the tailnet; the command prints a link if it is not. The UI is then at
`https://<machine>.<tailnet>.ts.net`.

To refuse anyone else on the tailnet, list the Tailscale logins that may use the UI in
`~/.local/share/claude-hub/config.json` (`{"allowedLogins": ["you@example.com"]}`) or in `HUB_ALLOWED_LOGINS`.
Do not expose the port to the public internet: anyone who can reach the UI can type into your sessions.

### Notifications

Open the UI and choose **Turn on notifications**. The hub then sends a push when a session answers, needs an
approval, or stops unexpectedly, unless a hub tab is open and in front. On an iPhone, first add the page to
the Home Screen (Share, then Add to Home Screen) and open it from there; iOS only allows push for installed
web apps. Notification text is encrypted for the receiving device.

## Run at login

```sh
bin/hub install-service     # starts the hub at login and restarts it if it stops
bin/hub uninstall-service
```

The service log is `~/Library/Logs/claude-hub.log`. To load new hub code, restart the service with
`launchctl kickstart -k gui/$(id -u)/com.claudehub.server`; sessions keep running and reconnect.

## Terminal, search and backups

- **Terminal**: the Terminal button opens a live view of the session's terminal in the browser (a real tmux
  client), so you can answer any prompt from the phone. **History** shows the scrollback.
- **Search** matches by keyword and by meaning. Meaning-based search uses a small embedding model that runs
  locally (downloaded once, about 23 MB, into `~/.local/share/claude-hub/models`); nothing is sent anywhere.
- **Backups**: one database snapshot a day in `~/.local/share/claude-hub/backups`, keeping seven. `bin/hub backup`
  makes one now. Set `HUB_BACKUP_DIR` to a synced folder to protect against losing the disk.
- **Sleep**: while any session is working, the hub keeps the Mac from idle-sleeping (`caffeinate`).

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| :- | :- | :- |
| `HUB_PORT` | `7777` | Port for the UI and API |
| `HUB_DATA_DIR` | `~/.local/share/claude-hub` | Database, secret and per-session run files |
| `HUB_ORCHESTRATOR_CWD` | `<data dir>/orchestrator` | Working directory of `main` |
| `HUB_CLAUDE_BIN` | `claude` | Path to the Claude Code binary |
| `HUB_ALLOWED_LOGINS` | empty | Comma-separated Tailscale logins allowed to use the UI |
| `HUB_AUTOSTART` | on | Set to `0` to stop the hub starting `main` and restarting dead sessions |
| `HUB_ACK_TIMEOUT` | `90` | Seconds before an unread push falls back to a paste |
| `HUB_TRANSCRIPTS_DIR` | `~/.claude/projects` | Transcripts to archive |
| `HUB_EMBEDDINGS` | on | Set to `off` for keyword-only search |
| `HUB_BACKUP_DIR` | `<data dir>/backups` | Where daily snapshots go |
| `HUB_BACKUP_KEEP` | `7` | How many snapshots to keep |
| `HUB_KEEP_AWAKE` | on | Set to `off` to let the Mac sleep while sessions work |

## Tests

```sh
npm test
```

The suite runs the real hub, tmux and channel server against `test/fake-claude.ts`, a scripted stand-in for
Claude Code that speaks MCP and posts hooks. It covers push and reply, delivery acknowledgement, the
lost-reply safety net, orchestrator tools, session-to-session messages, keyword and meaning-based search,
permission relay, the paste fallback, crash recovery, startup dialogs, the transcript archive, the live
terminal, push notifications and backups.

## Layout

```
server/src/index.ts     HTTP, WebSockets, hooks endpoint
server/src/router.ts    store-then-deliver, acknowledgements, fallbacks, tools
server/src/spawner.ts   launching sessions, startup dialogs, restart loop
server/src/ingest.ts    transcript archive
server/src/embed.ts     semantic search
server/src/push.ts      Web Push notifications
server/src/terminal.ts  live terminal
server/src/backup.ts    daily snapshots
server/src/mux/         terminal multiplexer interface and the tmux adapter
channel/hub-channel.ts  the channel MCP server Claude Code runs in each session
web/                    the UI
orchestrator/CLAUDE.md  instructions copied into the orchestrator's directory
db/migrations/          schema
```
