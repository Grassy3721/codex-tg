# codex-tg

A deliberately small Telegram bridge for Codex CLI. Its default backend is the
long-lived Codex App Server; `codex exec --json` remains available as a fallback.

## What it does

Send text, photos, or supported documents → Codex runs in your workspace → tool
calls, prose, approval requests, and generated files stream back through
Telegram. Threads persist per chat (and per forum topic).

Text arriving during an active App Server turn steers that turn. Assistant
message candidates are held until the turn finishes and committed once after a
short response grace period; a boundary-racing user message supersedes the
unseen candidate and produces one self-contained revised reply.

## Approval forwarding

With `CODEX_BACKEND=app-server`, command execution, file changes, permission
requests, MCP elicitations, and supported tool questions are rendered as
Telegram inline keyboards. Decisions are returned over the same App Server
connection, so the paused turn resumes in place. Buttons are scoped to the
originating Telegram user/chat and expire after `APPROVAL_TIMEOUT_MS`.

The assistant may also add one reaction to the current message. The conservative
default set can be replaced with a comma-separated
`TELEGRAM_REACTION_EMOJIS` value containing reactions supported by your chat.

## Setup

```bash
npm install
cp .env.example .env && $EDITOR .env   # token + your user ID at minimum
npm start
```

To let the bridge start skills on its own, copy `skills.example.json` to
`skills.json`, list the skills it may route to, and point `SKILL_CATALOG_FILE`
at it. Without a catalog, automatic routing stays off and skills are reachable
only through an explicit `$skill-name` message.

Requires `codex` on PATH and already logged in (`codex login`).

Run it under systemd or tmux so it survives your SSH session:

```ini
# /etc/systemd/system/codex-tg.service
[Unit]
Description=codex-tg
After=network.target

[Service]
WorkingDirectory=/opt/codex-tg
ExecStart=/usr/bin/node src/bot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Commands

| | |
|---|---|
| *(any text)* | send to Codex |
| `/new` | save the current thread and start with its last 10 user turns as one-shot continuity context |
| `/new clean` | save the current thread and start without recent continuity context |
| `/threads` | list previous resumable threads |
| `/resume <number>` | reopen a thread listed by `/threads` |
| `/cd <path>` | switch workspace (starts fresh) |
| `/model [model-id\|default]` | view or change the model for this chat/topic |
| `/effort [level\|default]` | view or change reasoning effort |
| `/compact` | compact the current thread context |
| `/usage` | session token usage, current context, and account limits |
| `/memory` | view evolving long-term memory and pending review count |
| `/memory refresh` | run the hidden memory reviewer now |
| `/memory forget <n>` | delete one evolving memory item |
| `/skill` | show the active skill episode, or the routable catalog |
| `/skill <name>` | start a skill episode explicitly |
| `/skill off` | end the episode and carry a summary back |
| `/status` | workspace, thread id, turn count |
| `/stop` | kill the running turn |
| `/restart` | gracefully restart the bot through PM2 and load current code |

## Skill episodes

A skill episode runs one Codex skill in its own forked thread, so a long
specialised task does not leave its instructions sitting in the main
conversation forever. Starting an episode forks the current thread — the worker
inherits the full history — and ending it asks the worker for a handoff summary,
injects that summary into the parent thread, and archives the worker. The main
thread therefore sees the outcome, never the episode's transcript.

Episodes start three ways:

- **explicitly**, with `$skill-name` at the start of a message, or `/skill <name>`;
- **by alias**, if the catalog gives the skill one (`$cr` for `code-review`);
- **automatically**, when the hidden router decides the message is asking for
  that skill's behaviour.

The router is a cheap, separate classifier turn with structured output. It reads
the current message, the active episode name, the catalog, and up to
`SKILL_ROUTER_HISTORY_TURNS` of the user's own recent messages — assistant
replies are deliberately excluded, and anything older than
`SKILL_ROUTER_HISTORY_WINDOW_MS` is dropped, so a finished topic cannot keep
pulling later messages into the wrong skill. Decisions below a confidence
threshold fall back to the safe choice: stay in the main thread when no episode
is running, keep the current episode when one is.

Automatic starts and automatic ends both announce themselves in the chat, so a
silent fork never happens.

## Telegram attachments

- Photos and image documents are downloaded into a per-turn temporary inbox and
  passed to both the prompt metadata and `codex exec --image`. JPEG, PNG, and
  WebP are accepted and verified by file signature.
- Generic inbound documents are deliberately limited to `.md`, `.txt`, `.json`,
  and `.zip`. Their paths are labelled as untrusted user uploads in the prompt.
- Every turn has a private temporary outbox. Codex is told to place only intended
  deliverables there; those files are uploaded as Telegram documents when the
  turn completes. Ordinary workspace edits are never uploaded automatically.
- Long prose is split across Telegram messages. Long responses containing
  substantial code are sent as `.md` documents instead.
- Temporary turn directories are removed after a configurable grace period.
  A periodic startup-safe sweep handles directories whose original cleanup timer
  was interrupted by a restart. File count, per-file size, and aggregate
  input/output limits are configurable through the variables documented in
  `.env.example`.

## Bridge-only portrait and memory

The Telegram bridge reads the explicit `PROFILE_FILES` allow list on every new
thread and injects those hand-maintained files through App Server
`developerInstructions`. It loads `MEMORY_FILE` into the same stable instruction
prefix when a thread starts, then freezes that evolving-memory version for the
current context window. A completed manual or automatic compaction causes the
latest version to be loaded for the next window. Background memory reviews do
not re-inject changed snapshots into an already-live window because the source
conversation is already present there. Nothing is installed into the global
Codex `~/.codex/AGENTS.md`, so the portrait applies only to this bridge.

Every `MEMORY_REVIEW_INTERVAL` user messages, a hidden ephemeral reviewer thread
receives the unprocessed conversation plus the old MEMORY.md. Structured output
limits it to add/replace/delete operations. Node validates exact old-text
matches, single-line content, duplicates, injection-like content, operation
count, and the `MEMORY_MAX_CHARS` final limit before updating the file with an
fsynced same-directory temporary file and atomic rename. Failed reviews never
block chat and leave both MEMORY.md and pending events untouched.

`/new` also stores a bounded, one-shot excerpt from the immediately previous
thread. The new thread receives up to `RECENT_THREAD_CONTEXT_TURNS` user turns
and their assistant replies on its first turn, capped by
`RECENT_THREAD_CONTEXT_MAX_CHARS`. This short-term continuity layer is separate
from evolving long-term memory, is consumed only after a successful injection,
and is cleared by `/new clean`, `/cd`, or `/resume`.

## Daily journal collector

The optional daily collector reviews the previous local 03:00-to-03:00 window
and extracts grounded, deduplicated journal events. It is disabled by default
because writing those events requires an MCP server that exposes Memory
Gateway's `append_journal` tool. Configure that server and set
`JOURNAL_COLLECTOR_ENABLED=true` to enable it.

## Autonomous wake-ups

With `PROACTIVE_WAKE_ENABLED=true`, the bridge gives the existing private chat
thread hidden, agent-paced contact turns. Every completed wake sends one natural
message, leaves a concise `did` causal baton, and autonomously chooses its next
flexible return window. Scheduling has three levels: exact appointments,
flexible windows, and the ordinary default rhythm.
The local `sinusRhythm.schedule_proactive_wake` MCP tool remains available on
ordinary conversation turns and can create exact or window plans. A `release`
can replace an exact appointment with a new window only when the agreement was
explicitly cancelled, completed early, or invalidated by shared new context.
Without a selected window, `PROACTIVE_WAKE_FALLBACK_MINUTES` is the failure and
interruption fallback cadence.
Exact appointments outrank windows and may run outside ordinary waking hours.

Each ordinary conversation turn receives a compact read-only snapshot of the
persisted next wake time, mode, and reason. Window placement is randomly sampled
with an early, center, or late distribution; the selected exact timestamp is
aligned to the next allowed waking period before it is stored, and is not redrawn
after restart. Exact appointments remain unaligned exceptions.

Wake turns never show typing or status messages before the resulting Telegram message.
SQLite leases prevent duplicate concurrent wakes and recover after a crashed
worker. Every accepted rhythm mutation advances a generation so stale scheduled
work cannot overwrite a newer plan. While a wake owns a live lease, conversation
activity and scheduling tools do not compete with it. A real user message never
defers an exact appointment, leaves a window available for conversational
rescheduling, and only pushes a too-near default wake beyond
`PROACTIVE_WAKE_USER_QUIET_MINUTES`.

`PROACTIVE_WAKE_CHAT_ID` defaults to the first `ALLOWED_USER_IDS` entry, which
matches the chat id for a normal private Telegram conversation.

## Backends

`CODEX_BACKEND=app-server` is the default and supports interactive approvals,
true turn interruption, and a warm MCP connection. Set `CODEX_BACKEND=exec` to
temporarily return to the older one-process-per-turn behavior.

## Known limits

- **Long threads degrade.** Resume replays history, so a thread that runs for
  hundreds of turns will eventually approach the context ceiling. Use `/compact`
  to summarize the current thread in place, or `/new` to start with only a bounded
  recent excerpt while keeping the old thread available through `/threads`.
- **One turn at a time per chat.** Concurrent messages are rejected, not queued.
