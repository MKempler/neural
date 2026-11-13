# Neural

**A command center for Claude Code.** Run several Claude Code sessions on your own computer, let one of them
direct the others, and talk to all of them from your browser or your phone, with a permanent, searchable
memory of everything that was said.

**Neural is free and open source under the [MIT licence](LICENSE).** Anyone can use it, change it, self-host
it or build on it, for personal or commercial work, with no sign-up, no account and no telemetry. It runs
entirely on your own machine.

![Neural on a laptop: the Home dashboard with three sessions, an approval waiting, and recent activity](docs/screenshots/home.png)

![Neural on a phone: Home, a conversation with the orchestrator, and a session at work with its live activity line](docs/screenshots/phone.png)

## Why Neural

Claude Code is at its best when you give it focused jobs, but juggling several terminals gets old quickly,
and stepping away from the desk means losing touch with all of them. Neural turns those sessions into one
place you can work from anywhere:

- **One orchestrator, many workers.** A session called `main` can start new sessions in any folder, hand
  them work, read their terminals, wait for them to finish and report back to you.
- **Messages are pushed, never polled.** What you type in Neural arrives in the session straight away
  through Claude Code [channels](https://code.claude.com/docs/en/channels-reference). Sessions can message
  each other the same way.
- **Your phone is a first-class client.** Neural installs as a home-screen app, with push notifications,
  approve/deny buttons for permission prompts, photos and videos, and a live terminal you can type into.
- **Nothing is forgotten.** Every message, and every Claude Code transcript on the machine, goes into a
  local database. Sessions can search it by keyword or by meaning when they need something from last week.
- **It keeps itself running.** Crashed sessions resume their conversations, undelivered messages are
  retried, the server starts at login, and the database is backed up daily.

## Open source, for anyone

- **Licence:** [MIT](LICENSE). Use it at home or at work, fork it, sell something built on it. The only
  condition is keeping the copyright and licence notice with copies of the code.
- **Your machine, your data:** the server listens on your computer only. Conversations, uploads, search
  indexes and backups live in `~/.local/share/neural`. Neural itself sends nothing anywhere; your sessions
  talk to Anthropic exactly as Claude Code always does.
- **No build step:** the web app is plain JavaScript modules (Preact and htm) loaded straight from
  `node_modules`, and the server runs TypeScript directly on Node. Reading or changing the code needs no
  toolchain.
- **Contributions welcome:** issues, ideas and pull requests are all appreciated. See
  [Contributing](#contributing).

Neural is an independent project. It is not affiliated with or endorsed by Anthropic. Claude and Claude Code
are trademarks of Anthropic.

## What it looks like

| Conversation | Search and command palette |
| :-: | :-: |
| ![A conversation: the orchestrator delegates to two sessions and summarises their findings](docs/screenshots/conversation.png) | ![The Cmd+K palette searching history for "currency"](docs/screenshots/search.png) |

- **Home:** what needs you (approvals, stuck sessions, unread replies), a card per session with its state
  and last message, recent activity across sessions, and a box to message `main`. Bars show how much of
  your 5-hour and weekly usage limits is used and when each resets.
- **Session:** the conversation, the live terminal, the session's changes and an activity log of what it did.
  On a wide screen the conversation and terminal can sit side by side.
- **Changes:** the branch and whether it's pushed, uncommitted files and recent commits, each with a diff that
  reads on a phone. Under each reply, a line such as "2 commits · 5 files · +180 −42 · 2 not pushed" says what
  that turn changed; tap it to see the diffs. Neural only reads the repository; pushing is left to the session.
- **On the phone:**
  - chat-style messages, with copy and quote on tap
  - a composer with + for camera, photos and files, and Send that turns into Stop while the session works
  - a live line showing what the session is doing ("Running the full test suite · 0:33")
  - drafts kept per session, and messages that queue while you're offline
  - quick replies above the message box when a session is waiting for you ("Continue", "Go ahead", "Push
    when tests pass"): tap to send, hold to edit first. Edit the list with the pencil; it suggests what you
    often send, and it's the same on every device. Home's unread cards have them too.
- **New session in two taps:** pick a folder from `~/Projects` (with its branch and the sessions already in
  it), start a new project there (a folder with git, and a private GitHub repository if you tick the box), or
  clone one of your GitHub repositories. `main` can do the same: "start a new project called recipes".
- **Questions and plans:** when Claude asks a question (multiple choice, pick-any, or your own words) or
  presents a plan for approval, it shows as a card in the conversation and under "Needs you", with a
  notification. Your answer is typed into the dialog in the session's terminal, checking the screen before
  each step; if the dialog has gone or looks different, the card says so and offers the terminal.
- **Timeline** of every message, **Search** across all history, and a **⌘K** palette to jump anywhere.
- **Slash commands from the chat:** a message starting with `/` (`/model sonnet`, `/effort max`, `/compact`)
  runs in the session's terminal, as if typed into Claude Code. Start with `//` to send it to Claude as text.
- **Model and effort** are shown on every session ("Fable 5.2 · high"); tap them to change.
- **Context:** each session shows how full its context window is ("context 41%"), in amber from 80%, when
  Claude Code is about to compact the conversation. When 90% of a usage limit is used, the composer says how
  much is left and when it resets.

## How it works

```mermaid
flowchart LR
  phone["Phone or browser"] -- "HTTPS over Tailscale<br/>(optional)" --> server
  subgraph mac["Your computer"]
    server["Neural server<br/>web app · message router · SQLite"]
    server <-- "WebSocket" --> c1["channel"] <-- "MCP" --> s1["claude · main<br/>(orchestrator)"]
    server <-- "WebSocket" --> c2["channel"] <-- "MCP" --> s2["claude · shop-api"]
    server <-- "WebSocket" --> c3["channel"] <-- "MCP" --> s3["claude · shop-web"]
    s1 & s2 & s3 -. "hooks: started, working, finished" .-> server
    tmux["tmux"] --- s1 & s2 & s3
  end
```

- Each session is an ordinary interactive `claude` process in its own tmux window, so closing your terminal
  doesn't stop it and you can always attach to it.
- Neural starts each session with a small MCP server, the **channel**, which pushes your messages into the
  session and gives Claude its tools (`reply`, `send_message`, `search_history` and so on).
- Claude Code **hooks** report each session's state back: working, waiting for approval, finished, or what
  tool it is using right now.
- Nothing is added to your global Claude Code settings. The channel and hooks are passed to each session on
  its command line.

### How a message travels

| Path | Normally | If that fails |
| :- | :- | :- |
| You to a session | Pushed through the channel | Queued while the session is down. If a push shows no sign of being read, it is typed into the terminal instead. |
| Session to you | The `reply` tool | The final text of the turn is captured by a hook and shown, marked "from the terminal". |
| Session to session | `send_message`, routed through Neural | Queued until the other session is ready. |
| Permission prompts | Allow / Deny in the app | Answer in the terminal view. |

A session that crashes, or that was running before a reboot, is resumed with `claude --resume` and keeps its
conversation. A session you stop stays stopped.

### Tools a session gets

- **Every session:** `reply`, `send_message`, `list_sessions`, `search_history`, `get_thread`.
- **The orchestrator also gets:** `spawn_session`, `stop_session`, `restart_session`, `read_screen`,
  `wait_for`.

## Get started

### Requirements

- **macOS.** Neural is built and tested on macOS. The core should work on Linux too, but the login service
  (launchd), photo conversion (`sips`) and keep-awake (`caffeinate`) are Mac-specific. Linux support is a
  welcome contribution.
- **Node 22.18 or newer.**
- **tmux:** `brew install tmux`.
- **Claude Code**, signed in with a claude.ai account or a Console API key. Channels need one of these.
- **Optional:**
  - ffmpeg, to send videos to sessions as still frames (`brew install ffmpeg`)
  - Tailscale, for phone access

### Install and run

```sh
git clone https://github.com/MKempler/neural.git
cd neural
npm install
bin/neural doctor     # checks everything is in place
bin/neural start      # web app on http://127.0.0.1:7777
```

The first start launches `main` in `~/.local/share/neural/orchestrator`. Open http://127.0.0.1:7777 and say
hello.

```sh
bin/neural status            # sessions and their state
bin/neural attach main       # open a session's terminal; detach with Ctrl+B then D
bin/neural install-service   # start Neural at login and keep it running
bin/neural backup            # write a database snapshot now
bin/neural restart           # restart the login service (rarely needed, see below)
```

When Neural runs as the login service it picks up changes to its own code by itself. A server change is
loaded in a test process first and, if it loads, Neural restarts within a couple of seconds; your sessions
keep running and reconnect. A broken change is logged and the running version stays up. Open pages and the
phone app reload when the web app changes, waiting until you're not typing. Set `NEURAL_AUTO_RELOAD=off` to
turn this off.

To show your name in the greeting, add `"displayName": "Your name"` to `~/.local/share/neural/config.json`.

### Use it from your phone

Neural only listens on your computer. The easiest safe way to reach it from a phone is
[Tailscale](https://tailscale.com), a private network between your own devices:

1. Install Tailscale on your computer and your phone, and sign in on both with the same account.
2. Publish Neural to your private network: `tailscale serve --bg 7777`. The first time, the command prints a
   link to enable this for your network.
3. On the phone, open `https://<your-computer>.<your-tailnet>.ts.net` in Safari, then tap Share, **Add to
   Home Screen**. Keep **Open as Web App** switched on.
4. Open Neural from the Home Screen and tap **Turn on** on the notifications card.

To keep other people on your Tailscale network out, list the logins allowed to use Neural in
`~/.local/share/neural/config.json`: `{"allowedLogins": ["you@example.com"]}`.

Neural answers only to `localhost` and Tailscale (`*.ts.net`) names, so a web page can't reach it by pointing
its own domain at your computer. If you put another host name in front of it, add it as
`{"allowedHosts": ["neural.example.com"]}`.

**Do not expose Neural to the public internet.** Anyone who can reach it can type into your Claude sessions,
which can run commands on your computer.

## Things to know

- **Channels are a research preview.** Custom channels aren't on Anthropic's allowlist yet, so sessions start
  with Claude Code's `--dangerously-load-development-channels` flag. Claude Code shows a confirmation for it
  on every launch, and Neural answers it for you. If a future Claude Code version changes that prompt, a
  session shows **Needs attention** and you can answer it from the terminal view.
- **Sessions use auto mode.** Spawned sessions run with `--permission-mode auto`. Anything auto mode
  escalates shows up as an Allow/Deny card.
- **Usage adds up.** Every session uses your Claude plan or API key independently, so start only what you
  need.
- **Usage limits are handled.** When a session hits your plan's limit, it shows **usage limit** with the reset
  time, you get a message and a notification, and messages you send wait instead of being retried against the
  limit. When the limit resets, a session whose turn was cut off is told to carry on with its task, one session
  a minute with `main` first, and you get a notification. Weekly limits are left for you to restart.
- **The status line is Neural's.** Usage and context come from Claude Code's status line, so sessions started
  by Neural use one that reports to the hub and shows "context 41% · 5-hour 62% (resets 20:20) · week 41%"
  in the terminal. A status line you set up yourself (in your user or project settings) still shows instead.
  The numbers appear after a session's first reply, and the limits only on a claude.ai plan.
- **Sessions pick up Neural's updates by themselves.** A session started before Neural's hooks, status line or
  channel server changed is restarted once it has been idle for 3 minutes, with nothing waiting to be
  delivered, no question open and nobody in its terminal. Its conversation is resumed.
- **Transcripts are archived.** Neural copies every Claude Code transcript on the machine into its
  database, so they stay searchable after Claude Code's own cleanup.
- **Secrets are kept out of the archive.** Tokens and keys in known formats (Anthropic, OpenAI, GitHub,
  GitLab, Hugging Face, AWS, Google, Slack, Stripe, npm), private keys, JWTs, passwords in URLs and long
  `password=` / `api_key:` style values are replaced with "[redacted …]" in stored messages, archived
  transcripts, search and logs. A session you send a token to still receives it as written. What was stored
  before is cleaned once at startup. Backups made earlier keep the old content until they age out, Claude
  Code's own transcripts in `~/.claude/projects` are untouched, and an unusual secret can still get through,
  so rotate anything you've pasted.

## Configuration

Everything is optional. Environment variables override `~/.local/share/neural/config.json`, and the older
`HUB_` names still work.

| Variable | Default | Meaning |
| :- | :- | :- |
| `NEURAL_PORT` | `7777` | Port for the web app and API |
| `NEURAL_DATA_DIR` | `~/.local/share/neural` | Database, uploads, backups and per-session files |
| `NEURAL_ORCHESTRATOR_CWD` | `<data dir>/orchestrator` | Working folder of `main` |
| `NEURAL_PROJECTS_ROOT` | `~/Projects` | Where new projects are created and cloned, and whose folders New session lists (or `"projectsRoot"` in `config.json`) |
| `NEURAL_CLAUDE_BIN` | `claude` | Path to the Claude Code binary |
| `NEURAL_DISPLAY_NAME` | from `config.json` | Name in the greeting |
| `NEURAL_ALLOWED_LOGINS` | from `config.json` | Comma-separated Tailscale logins allowed to use the app |
| `NEURAL_AUTOSTART` | on | `0` stops Neural starting `main` and restarting dead sessions |
| `NEURAL_MAX_UPLOAD_MB` | `1024` | Largest file you can attach |
| `NEURAL_EMBEDDINGS` | on | `off` for keyword-only search |
| `NEURAL_BACKUP_DIR` | `<data dir>/backups` | Where daily snapshots go; point it at a synced folder for off-machine copies |
| `NEURAL_BACKUP_KEEP` | `7` | How many snapshots to keep |
| `NEURAL_KEEP_AWAKE` | on | `off` lets the Mac sleep while sessions work |
| `NEURAL_TRANSCRIPTS_DIR` | `~/.claude/projects` | Transcripts to archive |
| `NEURAL_AUTO_RELOAD` | on | `off` stops restarting on code changes and reloading open pages |
| `NEURAL_ACK_TIMEOUT` | `90` | Seconds before an unread push is typed into the terminal instead |
| `NEURAL_AUTO_CONTINUE` | on | `off` stops Neural telling sessions to carry on after a usage limit resets (or `"autoContinue": false` in `config.json`) |
| `NEURAL_AUTO_REFRESH` | on | `off` stops Neural restarting sessions started with an older setup once they've been idle for 3 minutes (or `"autoRefresh": false` in `config.json`) |

Moving from an install made before the rename to Neural? Run `bin/neural migrate` once. It moves
`~/.local/share/claude-hub` and the login service over, and resumes your sessions.

## Contributing

Pull requests, bug reports and ideas are welcome. Open an issue first for anything large, so we can agree on
the approach.

```sh
npm install
npm test
```

The test suite runs the real server, tmux and channel against `test/fake-claude.ts`, a scripted stand-in
for Claude Code that speaks MCP and posts hooks. So you can test everything without spending any Claude
usage.

Ideas that would make good contributions:

- Linux support: a systemd service, and a `sips` replacement for photo conversion.
- Voice notes recorded in the app and transcribed locally.
- A herdr or Zellij backend behind the `Mux` interface in `server/src/mux/`.
- Wider tests for the web app.

### Project layout

```
server/src/index.ts       HTTP, WebSockets, hook endpoint, static files
server/src/router.ts      store-then-deliver, acknowledgements, fallbacks, session tools
server/src/spawner.ts     launching sessions, startup prompts, crash recovery
server/src/ingest.ts      transcript archive
server/src/git.ts         a session's changes: branch, commits, diffs and turn recaps (read-only)
server/src/usage.ts       usage limits and context, from each session's status line
server/src/projects.ts    project folders: list, create (git, GitHub) and clone
server/src/dialogs.ts     answering Claude Code's question and plan dialogs by keys
server/src/redact.ts      keeping secrets out of the archive (and scrub.ts, the one-off clean-up)
server/src/embed.ts       meaning-based search (local model + sqlite-vec)
server/src/files.ts       attachments: storage, photo conversion, video stills
server/src/push.ts        Web Push notifications
server/src/terminal.ts    live terminal in the browser
server/src/mux/           terminal multiplexer interface and the tmux backend
channel/neural-channel.ts the channel MCP server Claude Code runs in each session
channel/statusline.sh     the status line each session runs, which reports to the hub
web/src, web/styles       the web app
orchestrator/CLAUDE.md    instructions given to the orchestrator
db/migrations/            database schema
bin/neural                command line
```

## Licence

MIT. See [LICENSE](LICENSE). Free for anyone to use, modify and share.
