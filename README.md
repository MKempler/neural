# Neural

A command center for Claude Code: run several sessions on this Mac and talk to all of them from a browser or
phone.

- One session, `main`, is the **orchestrator**. It has tools to start, message, inspect and stop the others.
- Messages you type in the web UI are **pushed** into the session through a Claude Code
  [channel](https://code.claude.com/docs/en/channels-reference), so the session never polls for them.
- Sessions can message each other, and every message is stored in a SQLite database.
- Every Claude Code transcript on the machine is archived into the same database, so history stays
  searchable after Claude Code's 30-day cleanup. Sessions search it with the `search_history` tool.

## Requirements

Node 22.18 or newer, tmux (`brew install tmux`), and Claude Code signed in with a claude.ai account.
Run `bin/neural doctor` to check.

## Start

```sh
npm install
bin/neural start        # web UI on http://127.0.0.1:7777
```

The first start launches `main` in `~/.local/share/neural/orchestrator`. Each session runs in its own
tmux window on a dedicated tmux server, so closing your terminal does not stop it.

```sh
bin/neural status           # sessions and their state
bin/neural attach main      # open a session's terminal; detach with Ctrl+B then D
```

Sessions are launched with `--dangerously-load-development-channels server:neural`, because custom channels are
not on the research-preview allowlist. Claude Code shows a confirmation dialog for that flag on every launch;
the hub answers it, along with the folder-trust dialog. If a session shows **Needs attention**, open its
terminal view in the UI and answer whatever it is waiting for.

## The web app

- **Home** greets you and shows what needs you (approvals, stuck sessions, unread replies), a card per
  session with its state and last message, recent activity across sessions, and a box to message `main`.
- **Session** has three tabs: the conversation, the live terminal, and an activity log of what the session
  did. On a wide screen the conversation and terminal can sit side by side.
- **Timeline** lists every message, filterable by session. **Search** matches by keyword and by meaning.
- **⌘K** (Ctrl+K) opens a palette to jump to a session, run an action or search history.
- On a phone it uses a bottom tab bar, and can be added to the Home Screen as an app.

The greeting name comes from `displayName` in `~/.local/share/neural/config.json`, or from your Tailscale
identity. The UI is Preact with htm, loaded straight from `node_modules` with an import map, so there is no
build step and the page makes no requests outside its own address.

## Moving from Claude Hub

An install from before the rename can be moved over with `bin/neural migrate`. It stops the old service and
sessions, moves `~/.local/share/claude-hub` to `~/.local/share/neural`, installs the Neural login service and
lets it resume the sessions with their conversations.

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
session on its command line from files in `~/.local/share/neural/run`.

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
`~/.local/share/neural/config.json` (`{"allowedLogins": ["you@example.com"]}`) or in `NEURAL_ALLOWED_LOGINS`.
Do not expose the port to the public internet: anyone who can reach the UI can type into your sessions.

### Notifications

Open the UI and choose **Turn on notifications**. The hub then sends a push when a session answers, needs an
approval, or stops unexpectedly, unless a hub tab is open and in front. On an iPhone, first add the page to
the Home Screen (Share, then Add to Home Screen) and open it from there; iOS only allows push for installed
web apps. Notification text is encrypted for the receiving device.

## Run at login

```sh
bin/neural install-service     # starts the hub at login and restarts it if it stops
bin/neural uninstall-service
```

The service log is `~/Library/Logs/neural.log`. To load new hub code, restart the service with
`launchctl kickstart -k gui/$(id -u)/com.neural.server`; sessions keep running and reconnect.

## Terminal, search and backups

- **Terminal**: the Terminal button opens a live view of the session's terminal in the browser (a real tmux
  client), so you can answer any prompt from the phone. **History** shows the scrollback.
- **Search** matches by keyword and by meaning. Meaning-based search uses a small embedding model that runs
  locally (downloaded once, about 23 MB, into `~/.local/share/neural/models`); nothing is sent anywhere.
- **Backups**: one database snapshot a day in `~/.local/share/neural/backups`, keeping seven. `bin/neural backup`
  makes one now. Set `NEURAL_BACKUP_DIR` to a synced folder to protect against losing the disk.
- **Sleep**: while any session is working, the hub keeps the Mac from idle-sleeping (`caffeinate`).

## Configuration

Environment variables, all optional (the older `HUB_` names still work):

| Variable | Default | Meaning |
| :- | :- | :- |
| `NEURAL_PORT` | `7777` | Port for the UI and API |
| `NEURAL_DATA_DIR` | `~/.local/share/neural` | Database, secret and per-session run files |
| `NEURAL_ORCHESTRATOR_CWD` | `<data dir>/orchestrator` | Working directory of `main` |
| `NEURAL_CLAUDE_BIN` | `claude` | Path to the Claude Code binary |
| `NEURAL_ALLOWED_LOGINS` | empty | Comma-separated Tailscale logins allowed to use the UI |
| `NEURAL_AUTOSTART` | on | Set to `0` to stop Neural starting `main` and restarting dead sessions |
| `NEURAL_DISPLAY_NAME` | from `config.json` | Name in the greeting |
| `NEURAL_ACK_TIMEOUT` | `90` | Seconds before an unread push falls back to a paste |
| `NEURAL_TRANSCRIPTS_DIR` | `~/.claude/projects` | Transcripts to archive |
| `NEURAL_EMBEDDINGS` | on | Set to `off` for keyword-only search |
| `NEURAL_BACKUP_DIR` | `<data dir>/backups` | Where daily snapshots go |
| `NEURAL_BACKUP_KEEP` | `7` | How many snapshots to keep |
| `NEURAL_KEEP_AWAKE` | on | Set to `off` to let the Mac sleep while sessions work |

## Tests

```sh
npm test
```

The suite runs the real server, tmux and channel server against `test/fake-claude.ts`, a scripted stand-in for
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
channel/neural-channel.ts  the channel MCP server Claude Code runs in each session
web/src, web/styles      the web app
orchestrator/CLAUDE.md  instructions copied into the orchestrator's directory
db/migrations/          schema
```
