import 'dotenv/config'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { normalizeTelegramReactionEmojis } from './telegramReaction.js'

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

export function resolveRepositoryPath(value) {
  const configured = String(value || '').trim()
  if (!configured) return path.join(REPOSITORY_ROOT, 'data', 'sessions.db')
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(REPOSITORY_ROOT, configured)
}

function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function bool(v, fallback) {
  if (v == null || v === '') return fallback
  return /^(1|true|yes|on)$/i.test(v.trim())
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

function effort(v) {
  const value = String(v || '').trim().toLowerCase()
  if (!value) return ''
  if (!EFFORTS.has(value)) {
    throw new Error(`Invalid CODEX_REASONING_EFFORT: ${value}`)
  }
  return value
}

function paths(v, fallback = []) {
  const value = String(v || '').trim()
  if (!value) return fallback
  return value
    .split(',')
    .map((item) => path.resolve(item.trim().replace(/^~/, os.homedir())))
    .filter(Boolean)
}

function appServerArgs(disabledSkills) {
  const args = ['app-server']
  if (!disabledSkills.length) return args
  const value = `skills.config=[${disabledSkills
    .map((skillPath) => `{path=${JSON.stringify(skillPath)},enabled=false}`)
    .join(',')}]`
  return [...args, '-c', value]
}

function timeZone(v) {
  const value = String(v || 'UTC').trim()
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
  } catch {
    throw new Error(`Invalid USER_TIMEZONE: ${value}`)
  }
  return value
}

export const config = {
  botToken: required('TELEGRAM_BOT_TOKEN'),

  // Only these Telegram user IDs may talk to the bot. Comma-separated.
  // This is the ONLY thing standing between a stranger and shell access on your VPS.
  allowedUsers: (required('ALLOWED_USER_IDS'))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),

  // Where `codex exec` runs by default. Change per-chat with /cd.
  defaultWorkspace: process.env.DEFAULT_WORKSPACE || path.join(os.homedir(), 'projects'),

  // Root that /cd is confined to. Prevents "/cd /" style accidents.
  workspaceRoot: process.env.WORKSPACE_ROOT || os.homedir(),

  // read-only | workspace-write | danger-full-access
  sandbox: process.env.CODEX_SANDBOX || 'workspace-write',

  // Optional: pin a model. Leave empty to use whatever Codex defaults to.
  model: process.env.CODEX_MODEL || '',

  // Optional default. Individual chats/topics can override it with /effort.
  reasoningEffort: effort(process.env.CODEX_REASONING_EFFORT),

  codexBin: process.env.CODEX_BIN || 'codex',

  // App-server-only Skill suppression. This leaves standalone Codex CLI
  // sessions untouched while preventing Skill instructions and hidden workers
  // from fragmenting the long-lived Telegram relationship thread.
  appServerArgs: appServerArgs(paths(process.env.CODEX_APP_SERVER_DISABLED_SKILLS)),

  // app-server enables interactive approvals and keeps Codex/MCP warm between
  // turns. Set to "exec" as an emergency compatibility fallback.
  backend: /^(exec|app-server)$/.test(process.env.CODEX_BACKEND || '')
    ? process.env.CODEX_BACKEND
    : 'app-server',

  // Tool calls are collapsed into ONE self-updating status message that is
  // deleted when the turn ends. Set true to get a separate message per tool
  // call instead — noisy, but useful when debugging what the agent actually ran.
  showToolCalls: bool(process.env.SHOW_TOOL_CALLS, false),

  // User-facing timestamps injected into every Telegram turn.
  userTimezone: timeZone(process.env.USER_TIMEZONE),

  // Comma-separated standard Telegram reactions exposed to the assistant.
  telegramReactionEmojis: normalizeTelegramReactionEmojis(
    process.env.TELEGRAM_REACTION_EMOJIS
  ),

  dbPath: resolveRepositoryPath(process.env.DB_PATH),

  // Kill a turn that runs longer than this. Codex tasks can legitimately be slow,
  // so keep it generous; this is a runaway guard, not a latency target.
  turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS || 15 * 60 * 1000),
  turnCancellationGraceMs: Math.max(
    1_000,
    Number(process.env.TURN_CANCELLATION_GRACE_MS || 5_000)
  ),
  eventQueueMaxItems: Math.max(
    16,
    Number(process.env.EVENT_QUEUE_MAX_ITEMS || 256)
  ),
  backgroundQueueLimit: Math.max(
    1,
    Number(process.env.BACKGROUND_QUEUE_LIMIT || 4)
  ),
  appServerMonitorIntervalMs: Math.max(
    5_000,
    Number(process.env.APP_SERVER_MONITOR_INTERVAL_MS || 30_000)
  ),
  appServerRpcTimeoutMs: Math.max(
    1_000,
    Number(process.env.APP_SERVER_RPC_TIMEOUT_MS || 30_000)
  ),
  appServerIdleMs: Math.max(
    60_000,
    Number(process.env.APP_SERVER_IDLE_MS || 10 * 60 * 1000)
  ),
  appServerMaxTurns: Math.max(
    1,
    Number(process.env.APP_SERVER_MAX_TURNS || 40)
  ),
  appServerMaxRssBytes: Math.max(
    256 * 1024 * 1024,
    Number(process.env.APP_SERVER_MAX_RSS_MB || 1024) * 1024 * 1024
  ),

  // Telegram approval buttons expire so an abandoned turn cannot wait forever.
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 5 * 60 * 1000),

  // Bridge-only portrait injection. These files are never written by the
  // bridge; MEMORY_FILE is the sole automatically maintained profile.
  profileFiles: paths(process.env.PROFILE_FILES, [
    path.join(os.homedir(), '.codex-tg', 'AGENTS.md'),
  ]),
  memoryFile: path.resolve(
    (process.env.MEMORY_FILE || path.join(os.homedir(), '.codex-tg', 'MEMORY.md')).replace(
      /^~/,
      os.homedir()
    )
  ),
  memoryReviewInterval: Number(process.env.MEMORY_REVIEW_INTERVAL || 10),
  memoryMaxChars: Number(process.env.MEMORY_MAX_CHARS || 2000),
  memoryReviewModel: process.env.MEMORY_REVIEW_MODEL || '',
  memoryReviewEffort: effort(process.env.MEMORY_REVIEW_EFFORT || 'low'),
  memoryReviewWorkspace:
    process.env.MEMORY_REVIEW_WORKSPACE || process.env.DEFAULT_WORKSPACE || process.cwd(),

  // A fresh /new thread receives a bounded, one-shot excerpt from the
  // immediately previous thread. This preserves short-term conversational
  // continuity without turning transient details into long-term memory.
  recentThreadContextEnabled: bool(process.env.RECENT_THREAD_CONTEXT_ENABLED, true),
  recentThreadContextTurns: Math.max(
    1,
    Math.min(20, Number(process.env.RECENT_THREAD_CONTEXT_TURNS || 10))
  ),
  recentThreadContextMaxChars: Math.max(
    4_000,
    Math.min(80_000, Number(process.env.RECENT_THREAD_CONTEXT_MAX_CHARS || 24_000))
  ),

  // Automatic Skill episodes are selected by a hidden semantic classifier.
  // Character names and phrase matches must never fork a conversation by
  // themselves; explicit $skill invocations bypass this router.
  // JSON catalog of skills the automatic router may start. Without it the
  // router stays off and only explicit `$skill-name` invocations work.
  skillCatalogFile: String(process.env.SKILL_CATALOG_FILE || '').trim(),

  // Names used to label the two sides of a transcript in hidden prompts. They
  // are cosmetic; set them if the assistant has a name in your setup.
  userDisplayName: String(process.env.USER_DISPLAY_NAME || 'User').trim() || 'User',
  assistantDisplayName:
    String(process.env.ASSISTANT_DISPLAY_NAME || 'Assistant').trim() || 'Assistant',
  skillRouterEnabled: bool(process.env.SKILL_ROUTER_ENABLED, true),
  skillRouterModel: process.env.SKILL_ROUTER_MODEL || '',
  skillRouterEffort: effort(process.env.SKILL_ROUTER_EFFORT || 'low'),
  skillRouterTimeoutMs: Math.max(1_000, Number(process.env.SKILL_ROUTER_TIMEOUT_MS || 15_000)),
  // How many of the user's own earlier messages the router may see. 0 routes
  // on the current message alone.
  skillRouterHistoryTurns: Math.max(
    0,
    Math.min(20, Number(process.env.SKILL_ROUTER_HISTORY_TURNS ?? 3) || 0)
  ),
  // Earlier messages older than this are dropped, so an overnight gap cannot
  // leave last night's scene in the routing window. 0 disables the cutoff.
  skillRouterHistoryWindowMs: Math.max(
    0,
    Number(process.env.SKILL_ROUTER_HISTORY_WINDOW_MS ?? 30 * 60_000) || 0
  ),

  // A private 03:03 local-time reviewer extracts the just-finished
  // 03:00-to-03:00 day into journal events.
  journalCollectorEnabled: bool(process.env.JOURNAL_COLLECTOR_ENABLED, false),
  journalCollectorTaskName:
    process.env.JOURNAL_COLLECTOR_TASK_NAME || 'daily-journal-event-collector',
  journalCollectorTimezone: timeZone(
    process.env.JOURNAL_COLLECTOR_TIMEZONE || process.env.USER_TIMEZONE
  ),
  journalCollectorModel: process.env.JOURNAL_COLLECTOR_MODEL || '',
  journalCollectorEffort: effort(process.env.JOURNAL_COLLECTOR_EFFORT || 'low'),
  journalCollectorWorkspace:
    process.env.JOURNAL_COLLECTOR_WORKSPACE ||
    process.env.MEMORY_REVIEW_WORKSPACE ||
    process.env.DEFAULT_WORKSPACE ||
    process.cwd(),
  journalCollectorBatchChars: Math.max(
    20_000,
    Number(process.env.JOURNAL_COLLECTOR_BATCH_CHARS || 120_000)
  ),

  // Hidden, agent-paced opportunities for the assistant to decide whether to
  // initiate a message. The bridge enforces quiet hours and interval bounds, while each
  // successful wake chooses the next interval and leaves a causal baton.
  proactiveWakeEnabled: bool(process.env.PROACTIVE_WAKE_ENABLED, false),
  proactiveWakeChatId: Number(
    process.env.PROACTIVE_WAKE_CHAT_ID ||
      (required('ALLOWED_USER_IDS').split(',')[0] || '').trim()
  ),
  proactiveWakeTopicId: Number(process.env.PROACTIVE_WAKE_TOPIC_ID || 0) || null,
  proactiveWakeTimezone: timeZone(
    process.env.PROACTIVE_WAKE_TIMEZONE || process.env.USER_TIMEZONE
  ),
  proactiveWakeStartHour: Number(process.env.PROACTIVE_WAKE_START_HOUR || 10),
  proactiveWakeEndHour: Number(process.env.PROACTIVE_WAKE_END_HOUR || 22),
  proactiveWakeMinMinutes: Math.max(
    2,
    Number(process.env.PROACTIVE_WAKE_MIN_MINUTES || 10)
  ),
  proactiveWakeMaxMinutes: Math.max(
    10,
    Number(process.env.PROACTIVE_WAKE_MAX_MINUTES || 24 * 60)
  ),
  proactiveWakeFallbackMinutes: Math.max(
    10,
    Number(process.env.PROACTIVE_WAKE_FALLBACK_MINUTES || 120)
  ),
  proactiveWakeBootstrapMinutes: Math.max(
    2,
    Number(process.env.PROACTIVE_WAKE_BOOTSTRAP_MINUTES || 60)
  ),
  proactiveWakeUserQuietMinutes: Math.max(
    0,
    Number(process.env.PROACTIVE_WAKE_USER_QUIET_MINUTES || 15)
  ),
  // Every completed wake leaves a small recovery interval before the next
  // flexible window. Agent-selected windows may stretch this, but never
  // shorten it below this floor.
  proactiveWakeCooldownMinutes: Math.max(
    2,
    Number(process.env.PROACTIVE_WAKE_COOLDOWN_MINUTES || 30)
  ),
  proactiveWakeLeaseMs: Math.max(
    60_000,
    Number(process.env.PROACTIVE_WAKE_LEASE_MS || 20 * 60_000)
  ),
  // Per-turn Telegram transport limits. Attachments live in a private temporary
  // inbox/outbox and are removed after this grace period.
  maxAttachmentFiles: Number(process.env.MAX_ATTACHMENT_FILES || 5),
  maxAttachmentBytes: Number(process.env.MAX_ATTACHMENT_BYTES || 20 * 1024 * 1024),
  maxAttachmentTotalBytes: Number(process.env.MAX_ATTACHMENT_TOTAL_BYTES || 40 * 1024 * 1024),
  maxOutputFiles: Number(process.env.MAX_OUTPUT_FILES || 5),
  maxOutputFileBytes: Number(process.env.MAX_OUTPUT_FILE_BYTES || 45 * 1024 * 1024),
  maxOutputTotalBytes: Number(process.env.MAX_OUTPUT_TOTAL_BYTES || 90 * 1024 * 1024),
  attachmentRetentionMs: Number(process.env.ATTACHMENT_RETENTION_MS || 15 * 60 * 1000),
  codeAsFileMinChars: Number(process.env.CODE_AS_FILE_MIN_CHARS || 3000),
  responseCommitGraceMs: Math.max(
    0,
    Math.min(5000, Number(process.env.RESPONSE_COMMIT_GRACE_MS || 800))
  ),
}
