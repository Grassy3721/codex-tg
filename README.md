# codex-tg

[中文版](README.zh-CN.md)

A lightweight Telegram bridge for [Codex CLI](https://github.com/openai/codex).
Send messages, photos, or documents to your Telegram bot — Codex runs in your
workspace and streams results back through the chat.

## Features

- **Interactive approvals** — command execution, file changes, and permission
  requests appear as inline Telegram keyboards; decisions resume the paused turn
  in place.
- **Skill episodes** — under App Server, every turn that triggers a skill
  re-injects its full instructions into the context window. Long-running skills
  can fill up the context fast. Skill episodes solve this by forking the task
  into a separate thread: the skill runs there in isolation, and only a handoff
  summary is injected back into the main conversation when it finishes.
  Episodes start explicitly (`$skill-name` / `/skill <name>`) or automatically
  via a hidden semantic router.
- **Attachments** — send photos (JPEG / PNG / WebP) or documents
  (`.md` / `.txt` / `.json` / `.zip`) in; Codex-generated deliverables come
  back as Telegram documents. Long prose is split across messages; long code
  responses are sent as `.md` files.
- **Persistent threads** — conversation threads persist per chat and per forum
  topic. `/new` starts fresh with optional short-term continuity context;
  `/resume` reopens an earlier thread.
- **Portrait & memory** — a hand-maintained portrait file and an evolving
  long-term memory file are injected into every new thread. A periodic hidden
  reviewer extracts memory updates from the conversation; manual review is
  available via `/memory`.
- **Daily journal** — an optional end-of-day collector extracts grounded events
  and writes them to Memory Gateway's journal. Disabled by default.
- **Autonomous wake-ups** — the bot can initiate contact on its own rhythm,
  with flexible scheduling windows and exact appointments. Scheduling respects
  waking hours and yields to real conversation.
- **Rich formatting** — assistant responses are rendered with Telegram
  MarkdownV2 (bold, italic, code blocks, links).
- **Reactions** — the assistant can react to messages with emoji. The allowed
  set is configurable via `TELEGRAM_REACTION_EMOJIS`.
- **Dual backend** — `app-server` (default) supports interactive approvals and
  warm MCP connections; `exec` is a compatibility fallback.

## Setup

```bash
npm install
cp .env.example .env && $EDITOR .env   # token + your user ID at minimum
npm start
```

Requires `codex` on PATH and already logged in (`codex login`).

To enable automatic skill routing, copy `skills.example.json` to
`skills.json`, list the skills the router may start, and point
`SKILL_CATALOG_FILE` at it.

Run under systemd or tmux so it survives your SSH session:

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
| `/new` | start a new thread (keeps last 10 user turns as continuity context) |
| `/new clean` | start a new thread without continuity context |
| `/threads` | list previous resumable threads |
| `/resume <number>` | reopen a thread listed by `/threads` |
| `/cd <path>` | switch workspace (starts fresh) |
| `/model [model-id\|default]` | view or change the model for this chat/topic |
| `/effort [level\|default]` | view or change reasoning effort |
| `/compact` | compact the current thread context |
| `/usage` | session token usage, current context, and account limits |
| `/memory` | view long-term memory and pending review count |
| `/memory refresh` | run the memory reviewer now |
| `/memory forget <n>` | delete one memory item |
| `/skill` | show the active skill episode or routable catalog |
| `/skill <name>` | start a skill episode |
| `/skill off` | end the episode and carry a summary back |
| `/status` | workspace, thread id, turn count |
| `/stop` | kill the running turn |
| `/restart` | gracefully restart the bot and load current code |

## Known limits

- **Long threads degrade.** History replay grows with the thread. Use `/compact`
  to summarize in place, or `/new` to start fresh while keeping the old thread
  available through `/threads`.
- **One turn at a time per chat.** Concurrent messages are rejected, not queued.
