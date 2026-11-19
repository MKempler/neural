# Efficiency plan (2026-11-19)

The goal is less plan quota per unit of work, and better results. This plan draws on main's analysis
(`neural-efficiency-analysis-2026-11-19.md`), section 6 of research brief 1 (`2026-11-17-context-usage-burn.md`)
and a read of the hub: routing (`router.ts`), handoffs (`handoff.ts`), usage (`usage.ts`), the spawner and the
channel's instructions.

Gains are rough. A "turn" means one full-context request by the session that receives it. When main is around
150K tokens, one turn costs about as much as a few hundred lines of worker output. The binding constraint is the
weekly limit (69% to 92% in 12 hours on 11-18).

## What the code shows

- Every message to a session is pushed at once and starts a turn if the session is idle (`flush`,
  `beginTurnIfIdle`). Nothing tells an ack or a notice apart from real work.
- Messages to main in the two days to 11-19: user 174, roblox 52, youtube 40, neural health notices 35,
  roblox-qa 33, handoff prompts 22, research 15, neural-dev 12, wait_for results 10, jobs about 10.
- Of the 35 health notices, most are "X needs attention: rate_limit" followed later by "X is healthy again".
  When the limit is hit, every session sends both, so main pays 2 turns per session for news it can't act on.
- Workers often answer main with "Got it, I'll ..." or "Noted". Each one costs main a turn. neural-dev did this
  too (msgs 1206 and 1271).
- Usage readings exist only on the hub: the 5-hour and weekly %, their reset times, and each session's share.
  list_sessions shows the shares but not the %, the reset times or the pace.
- Neural already resumes sessions after a 5-hour reset (`limitReset`, `resumeInterrupted`), but it tells only
  the user, not main.
- Handoff thresholds default to a percent of the window: 60% for main and 30% for workers. With a 1M window,
  that is 600K and 300K tokens. Token thresholds exist (`at_tokens`), but only per session. Handoffs are on by
  default only for the orchestrator.
- Sessions launch with no compaction cap and with every claude.ai connector (Gmail, Drive, Docs, Calendar). Each
  one adds tool names and server instructions to every request.

## Ranked plan

| # | Change | Gain | Effort | Risk |
|---|--------|------|--------|------|
| 1 | Token handoff thresholds by default: main 150K, workers 90K (percent stays as an "or") | Large: main's average context drops from about 300K to about 90K, so each turn costs about 3x less | S | More restarts. Each one only works if STATE.md or the handoff note is complete |
| 2 | Quiet messages wait for the next real one: pure acks ("Noted", "Got it"), rate-limit "needs attention" and "healthy again" notices, and the new `fyi` flag on send_message. All of them stay visible in the UI at once | Large for main: about 10 to 30 turns a day | M | A quiet message reaches the session late. Only content that needs no action is marked quiet |
| 3 | Hub instructions: don't send acks, put progress in set_status, mark no-answer reports `fyi` | Medium: fewer worker turns and fewer main turns | S | Workers may not follow it; #2 catches the plain cases |
| 4 | Usage in list_sessions: 5-hour and weekly %, reset times, and the pace ("at this rate the weekly limit is hit Sat 3 pm") | Medium: main stops spending read_screen calls and footer-reading turns on it, and can plan | S | None |
| 5 | Window-reset notice to main: sent when a 5-hour window resets after reaching 80% or after stopping a session. It lists the stopped sessions and the ones Neural is resuming | Saves main's one-off resume jobs and the guesswork about who was stopped | S | One more turn per reset, but only for a window that got tight |
| 6 | Compaction backstop at 300K (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) | Caps the worst case: a missed handoff compacts at 300K, not near 1M | S | The context % the status line reports may become relative to 300K; check after deploy |
| 7 | `ENABLE_CLAUDEAI_MCP_SERVERS=false` for workers | Small per request, but it applies to every worker request: a few K tokens of prefix | S | A worker that needs Drive or Gmail loses them; add them back per session if one does |
| 8 | Handoff prompt: report the size of STATE.md, and above 8K tokens ask main to move logs to an archive file and keep current state on top | Medium: the restart prefix stays small (STATE.md reached 37K tokens) | S | None |
| 9 | Smaller tool outputs: search_history default limit 20 -> 5; list_sessions drops defaults and nulls | Small to medium for main | S | Main may need a second call with a bigger limit |
| 10 | Cold-cache fresh start: a message for a session idle over 55 min with over 100K context starts it fresh from its state file instead of rewriting a stale cache | Medium for sessions Max comes back to | M | Detail lost if the state file is weak. Needs #11 to measure |
| 11 | Cache telemetry per session from the status line (cache reads and writes) | Lets every change here be measured | S | None |
| 12 | Handoffs on by default for workers (now opt-in) | Medium: workers get the same 2x | S | A worker restarts between tasks; needs a good handoff note |
| 13 | Per-session tool-cost attribution from transcripts (which tool's output is biggest) | Points at waste such as Studio screenshots | M | None; analysis only |
| 14 | Debounce the user's bursts (merge messages within about 15 s) | Small | S | A slight delay on the first message |
| 15 | Task records with acceptance criteria (main's item 5) | Possibly fewer QA loops, but process rules already cover most of it | L | Overhead if it isn't kept cheap; hold until the rest is measured |
| 16 | Sidebar dot states and stale notes; the phone design items | Quality for Max, no quota saved | M | Low; after Tue Nov 24 |

## Order of work

Done now, one commit each: #1, #2 with #3, #4, #5, #6 and #7. After those, #8 and #9 if the budget allows.
After the weekly reset: #11 first (to measure), then #10, #12 and #13, then the UI (#16). #14 and #15 only if
the measurements call for them.
