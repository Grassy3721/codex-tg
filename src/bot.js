import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Telegraf } from 'telegraf'
import { config } from './config.js'
import {
  sessionKey,
  getSession,
  recordTurn,
  setWorkspace,
  resetThread,
  archiveCurrentThread,
  listThreadHistory,
  resumeThread,
  setModel,
  setEffort,
  queueRestartNotification,
  getRestartNotifications,
  deleteRestartNotification,
  addMemoryEvent,
  addConversationMessage,
  assignConversationMessageTurn,
  countPendingMemoryUserMessages,
  clearThreadMemoryHash,
  getThreadMemoryHash,
  setThreadMemoryHash,
  getSkillEpisode,
  saveSkillEpisode,
  touchSkillEpisode,
  markSkillEpisodeReload,
  markAllSkillEpisodesReload,
  deleteSkillEpisode,
  listRecentUserMessages,
  listCurrentThreadTail,
  saveThreadCarryover,
  getThreadCarryover,
  clearThreadCarryover,
  getInnerBatonRecord,
  getThreadInnerBatonVersion,
  setThreadInnerBatonVersion,
  clearThreadInnerBatonVersion,
} from './db.js'
import {
  buildPrompt,
  buildRecentThreadContext,
  buildTelegramMessageContext,
} from './context.js'
import { loadThreadBaseline } from './threadBaseline.js'
import {
  readThreadUsage,
  USAGE_CONTEXT_WINDOW,
  formatInteger,
  contextPercent,
  cacheHitPercent,
  formatAccountLimit,
} from './usage.js'
import { readAccountLimits, readAvailableModels } from './backends/codexAccount.js'
import { compactThread } from './backends/codexCompact.js'
import {
  AttachmentError,
  buildTransferContext,
  collectOutboxFiles,
  createTurnDirectory,
  downloadTelegramAttachments,
  scheduleTurnCleanup,
  shouldSendMarkdown,
  sweepStaleTurnDirectories,
} from './attachments.js'
import {
  buildEvolvingMemorySnapshot,
  buildFixedProfileDeveloperInstructions,
  ensureMemoryFile,
  forgetMemoryItem,
  readMemory,
} from './memoryStore.js'
import {
  maybeReviewMemory,
  memoryReviewRunning,
  reviewMemory,
} from './memoryReviewer.js'
import * as render from './render.js'
import { settleCosmeticRequest } from './cosmeticRequest.js'
import {
  createTelegramReactionHandler,
  createTelegramReactionTool,
} from './telegramReaction.js'
import {
  createDynamicToolRouter,
  createInnerBatonHandler,
  innerBatonTool,
  isQuietInnerBatonItem,
  renderInnerBatonSnapshot,
} from './innerBaton.js'
import {
  completePhaseResponse,
  createPhaseResponseRouter,
  createTurnControl,
  resolveTurnMessages,
  telegramClientUserMessageId,
} from './steering.js'
import { startDailyJournalCollector } from './journalCollector.js'
import {
  buildProactiveScheduleState,
  noteProactiveUserActivity,
  startProactiveWakeScheduler,
} from './proactiveWake.js'
import {
  automaticSkillEndedNotice,
  automaticSkillStartedNotice,
  episodeDeveloperInstructions,
  episodeSummaryItem,
  episodeSummaryPrompt,
  findEnabledSkill,
  parseSkillInvocation,
} from './skillEpisodes.js'
import {
  decideSkillRoute,
  skillRouterSchema,
} from './skillRouter.js'
import { loadSkillCatalog } from './skillCatalog.js'
import { paginateThreads, threadPageKeyboard } from './threadPagination.js'

import execBackend from './backends/codexExec.js'
import appServerBackend from './backends/appServer.js'

const backend = config.backend === 'exec' ? execBackend : appServerBackend
const telegramReactionTool = createTelegramReactionTool(config.telegramReactionEmojis)

if (config.backend === 'app-server') {
  appServerBackend.onSkillsChanged(() => {
    const count = markAllSkillEpisodesReload()
    if (count) console.log(`[skills] marked ${count} active episode(s) for reload`)
  })
}

const bot = new Telegraf(config.botToken)

/** sessionKey -> running operation. One turn per chat at a time. */
const active = new Map()
const mediaGroups = new Map()
/** sessionKey -> text messages that could not be steered and must run next. */
const queuedFollowups = new Map()
const pendingApprovals = new Map()
/** Telegram session key -> MCP tools approved for the rest of this bot session. */
const sessionMcpApprovals = new Map()
let restarting = false

// Skills the automatic router may start. An empty catalog leaves routing off
// and only explicit `$skill-name` invocations work.
let skillCatalog = { skills: [], aliases: new Map() }
try {
  skillCatalog = loadSkillCatalog(config.skillCatalogFile)
} catch (error) {
  console.warn('[skills] skill catalog ignored:', error.message)
}
let stopJournalCollector = () => {}
let stopProactiveWakeScheduler = () => {}

// ---------------------------------------------------------------- auth

bot.use(async (ctx, next) => {
  const id = ctx.from?.id
  if (!id || !config.allowedUsers.includes(id)) {
    console.warn(`[auth] rejected user ${id} (@${ctx.from?.username})`)
    return
  }
  return next()
})

// ---------------------------------------------------------------- helpers

function keyOf(ctx) {
  return sessionKey(
    ctx.chat.id,
    ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id
  )
}

function recordTelegramUserMessage(
  ctx,
  key,
  message = ctx.message,
  conversationTurnId = null
) {
  if (
    !config.journalCollectorEnabled &&
    !config.recentThreadContextEnabled &&
    !config.proactiveWakeEnabled
  ) return null
  const content = String(message?.text || message?.caption || '').trim()
  if (!content || message?.message_id == null) return null
  const sourceId = `telegram:${ctx.chat.id}:${message.message_id}`
  const inserted = addConversationMessage({
    sourceId,
    sessionKey: key,
    chatId: ctx.chat.id,
    topicId: message.message_thread_id ?? null,
    telegramMessageId: message.message_id,
    conversationTurnId,
    role: 'user',
    content,
    sentAt: Number(message.date) * 1000,
  })
  if (inserted) {
    noteProactiveUserActivity({
      sessionKey: key,
      chatId: ctx.chat.id,
      topicId: message.message_thread_id ?? null,
      at: Number(message.date) * 1000,
    })
  }
  if (conversationTurnId) assignConversationMessageTurn(sourceId, conversationTurnId)
  return inserted
}

function recordTelegramAssistantMessage(
  ctx,
  key,
  message,
  content,
  conversationTurnId = null
) {
  if (!config.journalCollectorEnabled && !config.recentThreadContextEnabled) return null
  if (!message?.message_id || !String(content || '').trim()) return null
  return addConversationMessage({
    sourceId: `telegram:${ctx.chat.id}:${message.message_id}`,
    sessionKey: key,
    chatId: ctx.chat.id,
    topicId: ctx.message?.message_thread_id ?? null,
    telegramMessageId: message.message_id,
    conversationTurnId,
    role: 'assistant',
    content,
    sentAt: Number(message.date) * 1000,
  })
}

function replyOpts(ctx, extra = {}) {
  const topic = ctx.message?.message_thread_id
  return { ...extra, ...(topic ? { message_thread_id: topic } : {}) }
}

async function say(ctx, html) {
  const parts = render.chunk(html)
  let last
  for (const part of parts) {
    try {
      last = await ctx.reply(part, replyOpts(ctx, { parse_mode: 'HTML' }))
    } catch {
      // A chunk boundary can land inside a tag, and Telegram 400s on unparseable
      // HTML. Dropping the formatting costs less than dropping the message.
      last = await ctx.reply(render.stripHtml(part), replyOpts(ctx))
    }
  }
  return last
}

/** Render agent Markdown into Telegram's deliberately small, safe HTML subset. */
async function sayFormatted(ctx, text) {
  let last
  for (const part of render.telegramMarkdownChunks(text)) {
    try {
      last = await ctx.reply(part, replyOpts(ctx, { parse_mode: 'HTML' }))
    } catch {
      // Formatting must never make the answer disappear if Telegram rejects
      // an unexpected construct.
      last = await ctx.reply(render.stripHtml(part), replyOpts(ctx))
    }
  }
  return last
}

async function sayAgent(ctx, text, turn, sequence) {
  if (!shouldSendMarkdown(text)) return sayFormatted(ctx, text)

  const filename = `codex-response-${sequence}.md`
  const target = path.join(turn.root, filename)
  await fs.promises.writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
  return ctx.replyWithDocument(
    { source: target, filename },
    replyOpts(ctx, { caption: '📝 较长的代码回答已作为 Markdown 文件发送。' })
  )
}

async function sendOutbox(ctx, outbox) {
  const { accepted, rejected } = await collectOutboxFiles(outbox)
  for (const file of accepted) {
    try {
      await ctx.replyWithDocument(
        { source: file.absolute, filename: path.basename(file.relative) },
        replyOpts(ctx, { caption: `📎 ${file.relative}`.slice(0, 1000) })
      )
    } catch (error) {
      rejected.push(`${file.relative}（Telegram 上传失败：${error.message}）`)
    }
  }
  if (rejected.length) {
    await say(
      ctx,
      `⚠️ 以下输出文件未发送：\n${rejected
        .map((item) => `• <code>${render.escapeHtml(item)}</code>`)
        .join('\n')}`
    )
  }
}

// ---------------------------------------------------------------- status line

const STATUS_MIN_INTERVAL_MS = 1200
const STATUS_INITIAL_DELAY_MS = 1200
const STATUS_REQUEST_TIMEOUT_MS = 4_000

/**
 * A single self-updating message showing what the agent is doing right now.
 *
 * Every tool call used to get its own Telegram message, which buried the actual
 * answer under a wall of bubbles. This collapses them into one line that is
 * edited in place and deleted when the turn ends — you still see the turn is
 * alive, without the transcript.
 *
 * Intermediate frames are dropped rather than queued when we're inside the
 * throttle window: the line is ephemeral, so a stale frame costs nothing, and
 * dropping keeps us clear of Telegram's edit rate limit with no timers to leak.
 * Nothing here is allowed to throw — a cosmetic message must never kill a turn.
 */
class StatusLine {
  constructor(ctx) {
    this.ctx = ctx
    this.msgId = null
    this.shown = ''
    this.want = ''
    this.lastEdit = 0
    this.busy = false
    this.initialTimer = null
    this.generation = 0
  }

  async set(text) {
    if (!text) return
    this.want = text
    if (this.busy) return
    if (this.msgId === null) {
      if (this.initialTimer === null) {
        this.initialTimer = setTimeout(() => {
          this.initialTimer = null
          this.flush().catch(() => {})
        }, STATUS_INITIAL_DELAY_MS)
        this.initialTimer.unref()
      }
      return
    }
    if (this.msgId !== null && Date.now() - this.lastEdit < STATUS_MIN_INTERVAL_MS) return
    await this.flush()
  }

  async flush() {
    if (this.busy || this.want === this.shown) return
    this.busy = true
    const text = this.want
    const generation = this.generation
    try {
      if (this.msgId === null) {
        const m = await settleCosmeticRequest(
          this.ctx.reply(text, replyOpts(this.ctx, { parse_mode: 'HTML' })),
          {
            timeoutMs: STATUS_REQUEST_TIMEOUT_MS,
            onLate: (late) => {
              const lateId = late?.message_id
              if (lateId == null) return
              return settleCosmeticRequest(
                this.ctx.telegram.deleteMessage(this.ctx.chat.id, lateId),
                { timeoutMs: STATUS_REQUEST_TIMEOUT_MS }
              )
            },
          }
        )
        const id = m?.message_id ?? null
        if (generation !== this.generation) {
          if (id !== null) {
            await settleCosmeticRequest(
              this.ctx.telegram.deleteMessage(this.ctx.chat.id, id),
              { timeoutMs: STATUS_REQUEST_TIMEOUT_MS }
            )
          }
          return
        }
        this.msgId = id
      } else {
        await settleCosmeticRequest(
          this.ctx.telegram.editMessageText(this.ctx.chat.id, this.msgId, undefined, text, {
            parse_mode: 'HTML',
          }),
          { timeoutMs: STATUS_REQUEST_TIMEOUT_MS }
        )
      }
      this.shown = text
      this.lastEdit = Date.now()
    } catch {
      // Rate limited, message deleted by the user, or identical content.
    } finally {
      this.busy = false
    }
  }

  /** Remove it so the next set() posts fresh — keeps the line *below* agent prose. */
  async drop() {
    this.generation += 1
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    const id = this.msgId
    this.msgId = null
    this.shown = ''
    this.want = ''
    this.lastEdit = 0
    if (id === null) return
    await settleCosmeticRequest(
      this.ctx.telegram.deleteMessage(this.ctx.chat.id, id),
      { timeoutMs: STATUS_REQUEST_TIMEOUT_MS }
    )
  }
}

function resolveWorkspace(input) {
  const abs = path.resolve(input.startsWith('~') ? input.replace('~', process.env.HOME) : input)
  const root = path.resolve(config.workspaceRoot)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Outside WORKSPACE_ROOT (${root})`)
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`)
  }
  const portraitRoots = new Set([
    path.dirname(config.memoryFile),
    ...config.profileFiles.map((file) => path.dirname(file)),
  ])
  for (const portraitRoot of portraitRoots) {
    if (abs === portraitRoot || abs.startsWith(`${portraitRoot}${path.sep}`)) {
      throw new Error(`Reserved bridge portrait directory: ${portraitRoot}`)
    }
  }
  return abs
}

function approvalButtons(token, approval) {
  const rows = []
  const add = (label, action) => rows.push([{ text: label, callback_data: `ap:${token}:${action}` }])
  const decisions = approval.params.availableDecisions || []
  const allowsSession = !decisions.length || decisions.includes('acceptForSession')

  if (approval.kind === 'user_input') {
    const options = approval.params.questions?.[0]?.options || []
    return options.slice(0, 6).map((option, index) => [
      { text: option.label.slice(0, 40), callback_data: `ap:${token}:opt${index}` },
    ])
  }
  if (approval.kind === 'mcp_elicitation') {
    if (approval.params.mode === 'url') {
      rows.push([{ text: '🌐 打开授权页面', url: approval.params.url }])
      add('✅ 已完成', 'once')
    } else {
      add('✅ 允许', 'once')
      add('🔓 始终允许', 'always')
    }
    add('❌ 拒绝', 'deny')
    return rows
  }

  add('✅ 仅允许本次', 'once')
  if (allowsSession) add('🔓 始终允许', 'session')
  add('❌ 拒绝', 'deny')
  add('🛑 取消任务', 'cancel')
  return rows
}

function approvalText(approval) {
  const p = approval.params
  const lines = ['🔐 <b>Codex 请求授权</b>']
  if (approval.kind === 'command') {
    lines.push('类型：执行命令')
    if (p.command) lines.push(`<pre>${render.escapeHtml(render.truncateMiddle(p.command, 1200))}</pre>`)
    if (p.cwd) lines.push(`目录：<code>${render.escapeHtml(p.cwd)}</code>`)
  } else if (approval.kind === 'file_change') {
    lines.push('类型：修改文件')
    if (p.reason) lines.push(`原因：${render.escapeHtml(p.reason)}`)
    if (p.grantRoot) lines.push(`目录：<code>${render.escapeHtml(p.grantRoot)}</code>`)
  } else if (approval.kind === 'permissions') {
    lines.push('类型：扩展文件系统或网络权限')
    if (p.reason) lines.push(`原因：${render.escapeHtml(p.reason)}`)
    lines.push(`<pre>${render.escapeHtml(JSON.stringify(p.permissions, null, 2).slice(0, 1500))}</pre>`)
  } else if (approval.kind === 'mcp_elicitation') {
    lines.push(`MCP：<code>${render.escapeHtml(p.serverName || '?')}</code>`)
    lines.push(render.escapeHtml(p.message || 'MCP 服务需要你的确认。'))
  } else if (approval.kind === 'user_input') {
    const q = p.questions?.[0]
    lines.push(q?.header ? `<b>${render.escapeHtml(q.header)}</b>` : 'Codex 需要你的选择')
    if (q?.question) lines.push(render.escapeHtml(q.question))
  }
  if (p.reason && approval.kind === 'command') lines.push(`原因：${render.escapeHtml(p.reason)}`)
  return lines.join('\n')
}

function mcpApprovalKey(approval) {
  if (approval.kind !== 'mcp_elicitation') return null
  const server = approval.params.serverName || ''
  const tool = approval.params.message?.match(/\btool\s+"([^"]+)"/i)?.[1]
  return server && tool ? `${server}:${tool}` : null
}

async function showApproval(ctx, approval) {
  const token = crypto.randomBytes(6).toString('base64url')
  const rows = approvalButtons(token, approval)
  const pending = {
    approval,
    chatId: ctx.chat.id,
    // Proactive wake contexts are synthetic Telegram contexts and do
    // not carry `from`.  The private chat id is the only authorized user in
    // that path, and keeps approval rendering from tearing down the turn.
    userId: ctx.from?.id ?? ctx.chat.id,
    expiresAt: Date.now() + config.approvalTimeoutMs,
    timer: null,
  }
  pending.timer = setTimeout(() => {
    if (pendingApprovals.get(token) !== pending) return
    pendingApprovals.delete(token)
    approval.respond('cancel').catch(() => {})
  }, config.approvalTimeoutMs)
  pending.timer.unref()
  pendingApprovals.set(token, pending)
  try {
    await ctx.reply(
      approvalText(approval),
      replyOpts(ctx, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows },
      })
    )
  } catch (error) {
    clearTimeout(pending.timer)
    pendingApprovals.delete(token)
    await approval.respond('cancel').catch(() => {})
    throw error
  }
}

bot.action(/^ap:([^:]+):(.+)$/, async (ctx) => {
  const [, token, action] = ctx.match
  const pending = pendingApprovals.get(token)
  if (!pending || pending.expiresAt < Date.now()) {
    clearTimeout(pending?.timer)
    pendingApprovals.delete(token)
    return ctx.answerCbQuery('这个授权请求已经失效。', { show_alert: true })
  }
  if (pending.userId !== ctx.from.id || pending.chatId !== ctx.chat.id) {
    return ctx.answerCbQuery('这不是你的授权请求。', { show_alert: true })
  }

  // Telegram callback queries have a short response window. Acknowledge the
  // click before doing any Codex I/O or editing the original message.
  await ctx.answerCbQuery('正在处理…').catch(() => {})

  let decision
  let value
  if (action.startsWith('opt')) {
    const option = pending.approval.params.questions?.[0]?.options?.[Number(action.slice(3))]
    if (!option) return ctx.answerCbQuery('选项已经失效。', { show_alert: true })
    decision = 'accept'
    value = option.label
  } else {
    decision = {
      once: 'accept',
      always: 'accept',
      session: 'acceptForSession',
      deny: 'decline',
      cancel: 'cancel',
    }[action]
  }
  if (!decision) return

  let alwaysPersisted = false
  if (action === 'always') {
    const approvalKey = mcpApprovalKey(pending.approval)
    const separator = approvalKey?.indexOf(':') ?? -1
    if (separator > 0) {
      try {
        await appServerBackend.setMcpToolApproval(
          approvalKey.slice(0, separator),
          approvalKey.slice(separator + 1),
          'approve'
        )
        alwaysPersisted = true
      } catch (error) {
        console.warn('[approval] could not persist MCP allow rule:', error.message)
      }
    }
  }

  const accepted = await pending.approval.respond(decision, value).catch(() => false)
  if (accepted && action === 'always') {
    const approvalKey = mcpApprovalKey(pending.approval)
    if (approvalKey) {
      const session = sessionKey(ctx.chat.id, ctx.callbackQuery.message?.message_thread_id)
      const allowed = sessionMcpApprovals.get(session) || new Set()
      allowed.add(approvalKey)
      sessionMcpApprovals.set(session, allowed)
    }
  }
  clearTimeout(pending.timer)
  pendingApprovals.delete(token)
  const icon = decision === 'accept' || decision === 'acceptForSession' ? '✅' : '❌'
  const label = {
    accept:
      action === 'always'
        ? alwaysPersisted
          ? '已始终允许'
          : '已允许，并在本会话记住'
        : '已允许本次操作',
    acceptForSession: '已在本会话允许',
    decline: '已拒绝',
    cancel: '已取消',
  }[decision]
  await ctx.editMessageText(`${approvalText(pending.approval)}\n\n${icon} <b>${label || '已回答'}</b>`, {
    parse_mode: 'HTML',
  }).catch(() => {})
})

// ---------------------------------------------------------------- commands

/**
 * Registered with Telegram via setMyCommands, which is what drives the
 * autocomplete popup when you type "/". Keep in sync with the handlers below.
 */
const COMMANDS = [
  { command: 'new', description: '保存当前线程并开始新对话；clean 不携带近期上下文' },
  { command: 'threads', description: '列出可以恢复的旧对话' },
  { command: 'resume', description: '恢复一个旧对话线程' },
  { command: 'cd', description: '切换工作目录（会开新线程）' },
  { command: 'model', description: '查看或更改当前会话的模型' },
  { command: 'effort', description: '查看或更改推理强度' },
  { command: 'compact', description: '压缩当前线程上下文' },
  { command: 'usage', description: '查看线程 Token 用量与账户限额' },
  { command: 'memory', description: '查看、整理或删除长期记忆' },
  { command: 'skill', description: '查看、开启或结束隔离的 Skill episode' },
  { command: 'status', description: '查看工作目录、线程 id、轮次' },
  { command: 'stop', description: '中止正在运行的任务' },
  { command: 'restart', description: '重启机器人并加载最新代码' },
  { command: 'help', description: '显示帮助' },
]

bot.command('help', (ctx) =>
  say(
    ctx,
    [
      '<b>codex-tg</b>',
      '',
      '直接发消息即可在当前工作目录里和 Codex 对话。',
      '',
      ...COMMANDS.map((c) => `/${c.command} — ${render.escapeHtml(c.description)}`),
    ].join('\n')
  )
)

function formatThreadTime(value) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: config.userTimezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(Number(value) || Date.now()))
}

function threadPreview(thread) {
  const preview = String(thread?.preview || '').replace(/\s+/gu, ' ').trim()
  return preview || `thread ${String(thread?.thread_id || '').slice(0, 8)}`
}

bot.command('new', async (ctx) => {
  const key = keyOf(ctx)
  if (active.has(key)) return say(ctx, '⏳ 当前任务运行中，请结束后再开新线程。')
  const mode = ctx.message.text.split(/\s+/).slice(1).join(' ').trim().toLowerCase()
  if (mode && mode !== 'clean') {
    return say(ctx, 'Usage: <code>/new</code> or <code>/new clean</code>')
  }
  const clean = mode === 'clean'
  const current = getSession(key, config.defaultWorkspace)
  const portraitRoots = new Set([
    path.dirname(config.memoryFile),
    ...config.profileFiles.map((file) => path.dirname(file)),
  ])
  try {
    if (getSkillEpisode(key)) await closeSkillEpisode(key, current)
    const archived = archiveCurrentThread(key)
    if (!clean && config.recentThreadContextEnabled && archived) {
      const recentContext = buildRecentThreadContext(
        listCurrentThreadTail(key, config.recentThreadContextTurns),
        config.recentThreadContextMaxChars
      )
      saveThreadCarryover(key, archived.thread_id, recentContext)
    } else {
      clearThreadCarryover(key)
    }
  } catch (error) {
    return say(
      ctx,
      `❌ 保存当前线程失败：<pre>${render.escapeHtml(error.message)}</pre>`
    )
  }
  if (portraitRoots.has(path.resolve(current.workspace))) {
    setWorkspace(key, config.defaultWorkspace)
  } else {
    resetThread(key)
  }
  sessionMcpApprovals.delete(key)
  return say(
    ctx,
    portraitRoots.has(path.resolve(current.workspace))
      ? `🧵 New thread. Previous thread saved; workspace moved to <code>${render.escapeHtml(config.defaultWorkspace)}</code>.`
      : clean
        ? '🧵 Clean thread. Previous thread saved; recent context was not carried over.'
        : '🧵 New thread. Previous thread saved; recent context will follow into the first turn.'
  )
})

function renderThreadsPage(ctx, requestedPage = 1) {
  const key = keyOf(ctx)
  const current = getSession(key, config.defaultWorkspace)
  const previous = listThreadHistory(key)
  const pagination = paginateThreads(previous, requestedPage)
  const lines = [
    `<b>Conversation threads</b> · ${pagination.page}/${pagination.totalPages}`,
    '',
    current.thread_id
      ? `Current: <code>${render.escapeHtml(current.thread_id)}</code> · ${current.turn_count} turns`
      : 'Current: <i>fresh; the next message creates a thread</i>',
  ]
  if (!previous.length) {
    lines.push('', '<i>No saved previous threads yet.</i>')
  } else {
    lines.push('', '<b>Previous</b>')
    pagination.items.forEach((thread, index) => {
      lines.push(
        `${pagination.startIndex + index + 1}. ${render.escapeHtml(formatThreadTime(thread.last_used_at))} · ${thread.turn_count} turns`,
        `   ${render.escapeHtml(threadPreview(thread))}`
      )
    })
    lines.push('', 'Use <code>/resume N</code> to reopen one.')
  }

  return {
    html: lines.join('\n'),
    replyMarkup: threadPageKeyboard(pagination.page, pagination.totalPages),
  }
}

bot.command('threads', async (ctx) => {
  const requestedPage = ctx.message.text.split(/\s+/).slice(1).join('').trim() || 1
  const page = renderThreadsPage(ctx, requestedPage)
  try {
    return await ctx.reply(
      page.html,
      replyOpts(ctx, {
        parse_mode: 'HTML',
        ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
      })
    )
  } catch {
    return ctx.reply(render.stripHtml(page.html), replyOpts(ctx))
  }
})

bot.action(/^threads:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const page = renderThreadsPage(ctx, Number(ctx.match[1]))
  return ctx.editMessageText(page.html, {
    parse_mode: 'HTML',
    ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
  }).catch((error) => {
    if (!/message is not modified/iu.test(String(error?.message || ''))) throw error
  })
})

bot.command('resume', async (ctx) => {
  const key = keyOf(ctx)
  if (active.has(key)) return say(ctx, '⏳ 当前任务运行中，请结束后再切换线程。')
  const value = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 1) {
    return say(ctx, 'Usage: <code>/resume N</code>\n先用 <code>/threads</code> 查看编号。')
  }
  const current = getSession(key, config.defaultWorkspace)
  const previous = listThreadHistory(key)
  const target = previous[index - 1]
  if (!target) {
    return say(ctx, `❌ 没有编号为 <code>${index}</code> 的旧线程。`)
  }
  try {
    if (getSkillEpisode(key)) await closeSkillEpisode(key, current)
    archiveCurrentThread(key)
    const resumed = resumeThread(key, target.thread_id)
    if (!resumed) throw new Error('The selected thread is no longer available')
    sessionMcpApprovals.delete(key)
    return say(
      ctx,
      [
        `🧵 Resumed: ${render.escapeHtml(threadPreview(target))}`,
        `<code>${render.escapeHtml(target.thread_id)}</code>`,
        `📁 <code>${render.escapeHtml(resumed.workspace)}</code>`,
      ].join('\n')
    )
  } catch (error) {
    return say(ctx, `❌ 恢复线程失败：<pre>${render.escapeHtml(error.message)}</pre>`)
  }
})

bot.command('status', (ctx) => {
  const s = getSession(keyOf(ctx), config.defaultWorkspace)
  const episode = getSkillEpisode(keyOf(ctx))
  const model = s.model || config.model
  const effort = s.effort || config.reasoningEffort
  return say(
    ctx,
    [
      `📁 <code>${render.escapeHtml(s.workspace)}</code>`,
      `🧵 ${s.thread_id ? `<code>${s.thread_id}</code>` : '<i>none (next message starts fresh)</i>'}`,
      `🔁 ${s.turn_count} turns`,
      `🔒 sandbox: <code>${render.escapeHtml(config.sandbox)}</code>`,
      `🤖 model: ${model ? `<code>${render.escapeHtml(model)}</code>` : '<i>Codex default</i>'}`,
      `🧠 effort: ${effort ? `<code>${render.escapeHtml(effort)}</code>` : '<i>model default</i>'}`,
      episode
        ? `🧩 skill: <code>${render.escapeHtml(episode.skill_name)}</code> · worker <code>${render.escapeHtml(episode.worker_thread_id)}</code>${episode.needs_reload ? ' · <i>reload pending</i>' : ''}`
        : '',
      active.has(keyOf(ctx)) ? '⏳ <b>a turn is running</b>' : '',
    ]
      .filter(Boolean)
      .join('\n')
  )
})

async function collectHiddenTurn(gen, control = null) {
  // Hidden preparation turns use the same cancellation lifecycle as the
  // visible Telegram turn.  Without this binding, /stop only cancelled a
  // not-yet-created main generator and the session stayed permanently active.
  control?.setGenerator(gen)
  const messages = []
  let failure = null
  for await (const event of gen) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (event.item.text?.trim()) messages.push(event.item.text.trim())
    } else if (event.type === 'approval.requested') {
      await event.approval.respond('cancel').catch(() => {})
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      failure = event.error?.message || event.message || 'Hidden turn failed'
    }
  }
  if (failure) throw new Error(failure)
  return messages.at(-1) || ''
}

async function classifySkillRoute(session, prompt, control = null) {
  const turn = appServerBackend.runTurn({
      // Skill classification is part of handling the user's main message;
      // it must outrank autonomous/background work.
      priority: 'main',
      workspace: session.workspace,
      prompt,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      model: config.skillRouterModel || session.model || config.model,
      effort: config.skillRouterEffort,
      imagePaths: [],
      ephemeral: true,
      outputSchema: skillRouterSchema(skillCatalog.skills),
      developerInstructions:
        'You are a private routing classifier. Return only schema-valid JSON. Never answer the user, invoke a skill, or use tools.',
    })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    turn.kill?.()
  }, config.skillRouterTimeoutMs)
  timeout.unref()

  try {
    const result = await collectHiddenTurn(turn, control)
    if (timedOut) throw new Error('Skill routing timed out')
    return result
  } finally {
    clearTimeout(timeout)
  }
}

// The router sees only the user's own recent messages, never the assistant's:
// long in-character replies used to fill the window and carry the mood of a
// finished scene into the next decision.  The time cutoff keeps an overnight
// gap from doing the same.
function skillRouterHistory(key, session, turnMessages = []) {
  const limit = config.skillRouterHistoryTurns
  if (limit <= 0) return []
  const exclude = new Set(
    turnMessages.map((message) => message?.message_id).filter((id) => id != null)
  )
  const window = config.skillRouterHistoryWindowMs
  const rows = listRecentUserMessages(key, {
    limit: limit + exclude.size,
    afterId: session.context_message_id,
    sinceMs: window > 0 ? Date.now() - window : 0,
  })
  return rows
    .filter((row) => !exclude.has(row.telegram_message_id))
    .slice(-limit)
}

async function closeSkillEpisode(key, session, control = null) {
  const episode = getSkillEpisode(key)
  if (!episode) return null
  const summary = await collectHiddenTurn(
    appServerBackend.runTurn({
      priority: 'main',
      workspace: session.workspace,
      threadId: episode.worker_thread_id,
      prompt: episodeSummaryPrompt(episode.skill_name),
      sandbox: config.sandbox,
      model: session.model || config.model,
      effort: session.effort || config.reasoningEffort,
      imagePaths: [],
    }),
    control
  )
  if (!summary) throw new Error('Skill worker did not produce a handoff summary')

  const parentThreadId = episode.parent_thread_id
  if (parentThreadId && parentThreadId !== episode.worker_thread_id) {
    await appServerBackend.injectItems({
      threadId: parentThreadId,
      workspace: session.workspace,
      sandbox: config.sandbox,
      model: session.model || config.model,
      effort: session.effort || config.reasoningEffort,
      items: [episodeSummaryItem(episode.skill_name, summary)],
    })
  }

  deleteSkillEpisode(key)
  if (parentThreadId && parentThreadId !== episode.worker_thread_id) {
    await appServerBackend.archiveThread(episode.worker_thread_id).catch((error) => {
      console.warn('[skills] could not archive completed worker:', error.message)
    })
  }
  return episode
}

async function endSkillEpisode(ctx, key) {
  const episode = getSkillEpisode(key)
  if (!episode) return say(ctx, '🧩 当前没有正在进行的 Skill episode。')
  if (active.has(key)) return say(ctx, '⏳ 当前任务运行中，请结束后再退出 Skill episode。')

  const session = getSession(key, config.defaultWorkspace)
  await ctx.sendChatAction('typing', replyOpts(ctx)).catch(() => {})
  const closed = await closeSkillEpisode(key, session)
  return say(
    ctx,
    `🧩 <code>${render.escapeHtml(closed.skill_name)}</code> episode 已结束，摘要已带回主线程。`
  )
}

bot.command('skill', async (ctx) => {
  if (config.backend !== 'app-server') {
    return say(ctx, '❌ Skill episode 需要 app-server 后端。')
  }
  const key = keyOf(ctx)
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!arg) {
    const episode = getSkillEpisode(key)
    return say(
      ctx,
      episode
        ? `🧩 当前：<code>${render.escapeHtml(episode.skill_name)}</code>\n结束：<code>/skill off</code>`
        : skillCatalog.skills.length
          ? `🧩 当前没有 episode；平时直接说话即可自动路由。\n可路由：${skillCatalog.skills
              .map((skill) => `<code>$${render.escapeHtml(skill.name)}</code>`)
              .join('、')}`
          : '🧩 当前没有 episode。未配置 skill catalog，自动路由已关闭；可用 <code>$skill-name</code> 手动进入。'
    )
  }
  if (/^(off|end|stop)$/i.test(arg)) {
    return endSkillEpisode(ctx, key).catch((error) =>
      say(ctx, `❌ 无法结束 Skill episode：<pre>${render.escapeHtml(error.message)}</pre>`)
    )
  }
  if (/^list$/i.test(arg)) {
    const session = getSession(key, config.defaultWorkspace)
    try {
      const skills = await appServerBackend.listSkills(session.workspace)
      const names = skills.filter((skill) => skill.enabled !== false).map((skill) => skill.name)
      return say(
        ctx,
        names.length
          ? `🧩 <b>Skills</b>\n${names.map((name) => `• <code>${render.escapeHtml(name)}</code>`).join('\n')}`
          : '<i>当前 workspace 没有可用 Skill。</i>'
      )
    } catch (error) {
      return say(ctx, `❌ 无法读取 Skills：<pre>${render.escapeHtml(error.message)}</pre>`)
    }
  }
  return runCodexTurn(ctx, { text: `$${arg}` })
})

bot.command('model', async (ctx) => {
  const key = keyOf(ctx)
  const session = getSession(key, config.defaultWorkspace)
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()

  if (!arg) {
    const current = session.model || config.model
    await ctx.sendChatAction('typing', replyOpts(ctx)).catch(() => {})

    try {
      const models = await readAvailableModels()
      const lines = [
        '🤖 <b>Available models</b>',
        `Current: ${current ? `<code>${render.escapeHtml(current)}</code>` : '<i>Codex default</i>'}`,
        '',
      ]

      for (const item of models) {
        const id = item.model || item.id
        const label = item.displayName && item.displayName !== id ? `${item.displayName} — ` : ''
        const marks = [
          current && id === current ? '← current' : '',
          item.isDefault ? '★ default' : '',
        ].filter(Boolean)
        lines.push(
          `• ${render.escapeHtml(label)}<code>${render.escapeHtml(id)}</code>${
            marks.length ? ` <i>${marks.join(' · ')}</i>` : ''
          }`
        )
      }

      if (!models.length) lines.push('<i>No picker-visible models returned.</i>')
      lines.push('', '切换：<code>/model &lt;model-id&gt;</code>', '恢复默认：<code>/model default</code>')
      return say(ctx, lines.join('\n'))
    } catch (error) {
      console.warn('[model/list]', error.message)
      return say(
        ctx,
        [
          `🤖 当前模型：${current ? `<code>${render.escapeHtml(current)}</code>` : '<i>Codex default</i>'}`,
          '<i>暂时无法读取可用模型列表。</i>',
          '',
          '设置：<code>/model &lt;model-id&gt;</code>',
          '恢复默认：<code>/model default</code>',
        ].join('\n')
      )
    }
  }

  if (active.has(key)) return say(ctx, '⏳ 当前任务运行中，请结束后再更改模型。')

  const model = /^(default|reset)$/i.test(arg) ? '' : arg
  if (model && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))) {
    return say(ctx, '❌ 模型 ID 格式无效。')
  }

  setModel(key, model)
  const effective = model || config.model
  return say(
    ctx,
    `🤖 模型已设为 ${
      effective ? `<code>${render.escapeHtml(effective)}</code>` : '<i>Codex default</i>'
    }。\n<i>下一轮开始生效。</i>`
  )
})

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

bot.command('effort', (ctx) => {
  const key = keyOf(ctx)
  const session = getSession(key, config.defaultWorkspace)
  const arg = ctx.message.text.split(/\s+/)[1]?.trim().toLowerCase() || ''

  if (!arg) {
    const current = session.effort || config.reasoningEffort
    return say(
      ctx,
      [
        `🧠 当前推理强度：${current ? `<code>${current}</code>` : '<i>model default</i>'}`,
        '',
        `可选：<code>${EFFORTS.join(' · ')}</code>`,
        '设置：<code>/effort high</code>',
        '恢复默认：<code>/effort default</code>',
      ].join('\n')
    )
  }

  if (active.has(key)) return say(ctx, '⏳ 当前任务运行中，请结束后再更改推理强度。')

  const effort = /^(default|reset)$/.test(arg) ? '' : arg
  if (effort && !EFFORTS.includes(effort)) {
    return say(ctx, `❌ 无效的推理强度。可选：<code>${EFFORTS.join(' · ')}</code>`)
  }

  setEffort(key, effort)
  const effective = effort || config.reasoningEffort
  return say(
    ctx,
    `🧠 推理强度已设为 ${
      effective ? `<code>${effective}</code>` : '<i>model default</i>'
    }。\n<i>下一轮开始生效；部分模型不支持所有强度。</i>`
  )
})

bot.command('usage', async (ctx) => {
  const session = getSession(keyOf(ctx), config.defaultWorkspace)
  const model = session.model || config.model || 'Codex default'

  await ctx.sendChatAction('typing', replyOpts(ctx)).catch(() => {})

  const [usageResult, accountResult] = await Promise.allSettled([
    session.thread_id ? readThreadUsage(session.thread_id) : Promise.resolve(null),
    readAccountLimits(),
  ])

  const usage = usageResult.status === 'fulfilled' ? usageResult.value : null
  const account = accountResult.status === 'fulfilled' ? accountResult.value : null
  const usageModel = usage?.model || model
  const lines = [
    '📊 <b>Session Token Usage</b>',
    `Model: <code>${render.escapeHtml(usageModel)}</code>`,
  ]

  if (usage) {
    const contextUsed = usage.compactWindow?.currentTokens ?? usage.last.totalTokens
    const contextLimit = USAGE_CONTEXT_WINDOW
    const percent = contextPercent(contextUsed, contextLimit)
    const cachedInput = Math.min(
      usage.total.inputTokens,
      Math.max(0, usage.total.cachedInputTokens)
    )
    const cachePercent = cacheHitPercent(cachedInput, usage.total.inputTokens)
    lines.push(
      `Input tokens: <code>${formatInteger(usage.total.inputTokens)}</code>`,
      `Cache hit: <code>${cachePercent === null ? '—' : `${cachePercent.toFixed(1)}%`}</code>`,
      `Output tokens: <code>${formatInteger(usage.total.outputTokens)}</code>`,
      `Total: <code>${formatInteger(usage.total.totalTokens)}</code>`,
      `Context: <code>${formatInteger(contextUsed)} / ${
        contextLimit ? formatInteger(contextLimit) : '?'
      }${percent === null ? '' : ` (${percent}%)`}</code>`
    )
  } else {
    lines.push('<i>No completed turn usage yet.</i>')
  }

  lines.push('', '📈 <b>Account limits</b>')

  if (account) {
    const accountType = account.account?.type
    const plan = account.account?.planType || account.limits?.planType
    const provider =
      accountType === 'chatgpt'
        ? `openai-codex${
            plan
              ? ` (${String(plan)
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, (letter) => letter.toUpperCase())})`
              : ''
          }`
        : accountType === 'apiKey'
          ? 'openai (API key)'
          : accountType || 'unknown'
    lines.push(`Provider: <code>${render.escapeHtml(provider)}</code>`)

    const renderAccountLimit = (label, window) => {
      const formatted = formatAccountLimit(label, window, Date.now(), config.userTimezone)
      const detail = formatted.slice(label.length + 2)
      const [status, reset] = detail.split(' • ')
      return `${render.escapeHtml(label)}: <code>${render.escapeHtml(status)}</code>${
        reset ? ` • ${render.escapeHtml(reset)}` : ''
      }`
    }
    lines.push(
      renderAccountLimit('5h', account.limits?.primary),
      renderAccountLimit('Weekly', account.limits?.secondary)
    )
  } else {
    lines.push('<i>Account limit query unavailable.</i>')
  }

  return say(ctx, lines.join('\n'))
})

bot.command('memory', async (ctx) => {
  const arg = ctx.message.text.split(/\s+/).slice(1)
  const action = arg[0]?.toLowerCase() || ''

  if (action === 'refresh') {
    if (memoryReviewRunning()) return say(ctx, '🧠 记忆整理已经在后台运行。')
    await say(ctx, '🧠 已启动后台记忆整理，主聊天不受影响。')
    reviewMemory({ force: true })
      .then((result) =>
        say(
          ctx,
          result.skipped
            ? '🧠 没有尚未整理的聊天记录。'
            : `🧠 记忆整理完成：新增 ${result.stats.add}，替换 ${result.stats.replace}，删除 ${result.stats.delete}。`
        )
      )
      .catch((error) => {
        console.warn('[memory] manual review failed:', error.message)
        return say(ctx, `❌ 记忆整理失败：${render.escapeHtml(error.message)}`)
      })
    return
  }

  if (action === 'forget') {
    if (memoryReviewRunning()) return say(ctx, '⏳ 记忆整理运行中，请稍后再删除。')
    try {
      const removed = await forgetMemoryItem(arg[1])
      return say(ctx, `🧠 已删除：${render.escapeHtml(removed)}`)
    } catch (error) {
      return say(ctx, `❌ ${render.escapeHtml(error.message)}\n用法：<code>/memory forget 2</code>`)
    }
  }

  try {
    const memory = await readMemory()
    const pending = countPendingMemoryUserMessages()
    const lines = [
      '🧠 <b>Long-term Memory</b>',
      `文件：<code>${render.escapeHtml(config.memoryFile)}</code>`,
      `大小：<code>${memory.text.length} / ${config.memoryMaxChars}</code>`,
      `待整理用户消息：<code>${pending} / ${config.memoryReviewInterval}</code>`,
      memoryReviewRunning() ? '<i>后台整理正在运行</i>' : '',
      '',
    ].filter(Boolean)
    if (memory.items.length) {
      memory.items.forEach((item, index) => {
        lines.push(`${index + 1}. ${render.escapeHtml(item)}`)
      })
    } else {
      lines.push('<i>尚无动态长期记忆。</i>')
    }
    lines.push('', '手动整理：<code>/memory refresh</code>', '删除：<code>/memory forget &lt;序号&gt;</code>')
    return say(ctx, lines.join('\n'))
  } catch (error) {
    return say(ctx, `❌ 无法读取记忆：${render.escapeHtml(error.message)}`)
  }
})

bot.command('compact', async (ctx) => {
  const key = keyOf(ctx)
  if (active.has(key)) return say(ctx, '⏳ 当前任务运行中，请结束后再压缩上下文。')

  const session = getSession(key, config.defaultWorkspace)
  const episode = getSkillEpisode(key)
  const threadId = episode?.worker_thread_id || session.thread_id
  if (!threadId) return say(ctx, '🧵 当前还没有可压缩的线程。')

  const operation = compactThread({
    threadId,
    workspace: session.workspace,
    sandbox: config.sandbox,
    model: session.model || config.model,
    effort: session.effort || config.reasoningEffort,
  })
  active.set(key, operation)

  const status = new StatusLine(ctx)
  await status.set('🗜️ <i>正在压缩上下文…</i>')

  try {
    await operation.promise
    clearThreadMemoryHash(threadId)
    if (episode) markSkillEpisodeReload(key)
    await status.drop()
    return say(ctx, '🗜️ 上下文压缩完成。动态记忆将在下一条消息自动刷新。')
  } catch (error) {
    await status.drop()
    if (error.code === 'COMPACT_STOPPED') return
    console.error('[compact]', error)
    return say(ctx, `❌ 压缩失败：${render.escapeHtml(error.message)}`)
  } finally {
    await status.drop().catch(() => {})
    releaseActive(key, operation)
  }
})

bot.command('cd', async (ctx) => {
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!arg) return say(ctx, 'Usage: <code>/cd /path/to/project</code>')
  try {
    const ws = resolveWorkspace(arg)
    const key = keyOf(ctx)
    if (active.has(key)) return say(ctx, '⏳ 当前任务运行中，请结束后再切换工作目录。')
    const current = getSession(key, config.defaultWorkspace)
    if (getSkillEpisode(key)) await closeSkillEpisode(key, current)
    archiveCurrentThread(key)
    setWorkspace(key, ws)
    sessionMcpApprovals.delete(key)
    return say(ctx, `📁 → <code>${render.escapeHtml(ws)}</code>\n<i>New thread started.</i>`)
  } catch (e) {
    return say(ctx, `❌ ${render.escapeHtml(e.message)}`)
  }
})

bot.command('stop', async (ctx) => {
  const operation = active.get(keyOf(ctx))
  if (!operation) return say(ctx, 'Nothing running.')
  operation.kill()
  return say(ctx, '🛑 Stopping the current operation.')
})

function releaseActive(key, operation) {
  if (active.get(key) !== operation) return false
  active.delete(key)
  queueMicrotask(() => drainFollowups(key))
  return true
}

function pruneEndedActiveOperations() {
  for (const [key, operation] of active) {
    if (!operation?.ended) continue
    releaseActive(key, operation)
  }
}

function abortWorkForRestart() {
  // A restart is an explicit, authorized maintenance action. Do not let
  // queued follow-ups or delayed media timers start new work while the
  // process is waiting for PM2 to replace it.
  queuedFollowups.clear()
  for (const group of mediaGroups.values()) clearTimeout(group.timer)
  mediaGroups.clear()

  for (const operation of new Set(active.values())) {
    try {
      operation.kill?.()
    } catch (error) {
      console.warn('[restart] could not stop active operation:', error.message)
    }
  }

  for (const [token, pending] of pendingApprovals) {
    clearTimeout(pending.timer)
    pendingApprovals.delete(token)
    pending.approval.respond('cancel').catch(() => {})
  }
}

bot.command('restart', async (ctx) => {
  if (restarting) return say(ctx, '♻️ 已经在重启了。')
  pruneEndedActiveOperations()

  restarting = true
  abortWorkForRestart()
  let notificationId = null
  try {
    notificationId = queueRestartNotification(ctx.chat.id, ctx.message?.message_thread_id)
    await say(ctx, '♻️ 正在强制重启并加载最新代码…')
  } catch (error) {
    if (notificationId !== null) deleteRestartNotification(notificationId)
    restarting = false
    console.error('[restart] could not queue restart:', error)
    return say(ctx, `❌ 无法开始重启：${render.escapeHtml(error.message)}`)
  }

  const timer = setTimeout(() => {
    bot.stop('restart')
    process.exit(0)
  }, 500)
  timer.unref()
})

// ---------------------------------------------------------------- main turn

function newTurnControl() {
  return createTurnControl({ steerable: config.backend === 'app-server' })
}

function bindConversationTurnId(operation, ctx, messages = []) {
  if (operation.conversationTurnId) return operation.conversationTurnId
  const firstMessage = messages[0] || ctx.message
  if (firstMessage?.message_id != null) {
    operation.conversationTurnId = `telegram-turn:${ctx.chat.id}:${firstMessage.message_id}`
  }
  return operation.conversationTurnId
}

function enqueueFollowup(key, item) {
  const queue = queuedFollowups.get(key) || []
  const previous = queue.at(-1)
  if (item.coalesceKey && previous?.coalesceKey === item.coalesceKey) {
    previous.ctx = item.ctx
    previous.text = item.text
    previous.contextMessages = item.contextMessages || []
    previous.priorResponseWithheld ||= item.priorResponseWithheld
    return
  }
  if (item.coalesce && previous?.coalesce) {
    previous.ctx = item.ctx
    previous.text = [previous.text, item.text].filter(Boolean).join('\n\n')
    previous.contextMessages = [
      ...(previous.contextMessages || []),
      ...(item.contextMessages || []),
    ]
    previous.priorResponseWithheld ||= item.priorResponseWithheld
    return
  }
  queue.push(item)
  queuedFollowups.set(key, queue)
}

function drainFollowups(key) {
  if (active.has(key)) return
  const queue = queuedFollowups.get(key)
  if (!queue?.length) {
    queuedFollowups.delete(key)
    return
  }

  const next = queue.shift()
  if (!queue.length) queuedFollowups.delete(key)
  runCodexTurn(next.ctx, {
    text: next.text,
    contextMessages: next.contextMessages || [],
    priorResponseWithheld: Boolean(next.priorResponseWithheld),
  }).catch((error) => {
    console.error('[queued-followup]', error)
  })
}

async function steerOrQueueText(ctx, text) {
  const key = keyOf(ctx)
  // Persist at receipt time so a message arriving just before the 03:00 cut is
  // not missed while an earlier turn is still running.
  recordTelegramUserMessage(ctx, key)
  const operation = active.get(key)
  if (!operation) {
    return runCodexTurn(ctx, { text })
  }

  if (operation.kind === 'proactive') {
    enqueueFollowup(key, { ctx, text })
    operation.kill()
    return
  }

  if (!operation.steerable) {
    enqueueFollowup(key, { ctx, text })
    await say(ctx, '↪️ 当前后端不支持中途插话；这条已排到下一轮，不会丢。')
    return
  }

  const messageContext = buildTelegramMessageContext([ctx.message], config.userTimezone)
  const prompt = buildPrompt(
    text,
    '',
    [
      messageContext,
      '<bridge_steering_context>Any assistant response candidate from this active turn has not been delivered to the user. Produce one self-contained revised final answer that incorporates all still-relevant content and the new message.</bridge_steering_context>',
    ].join('\n\n')
  )
  operation.bumpResponseRevision()
  try {
    await operation.steer({
      prompt,
      clientUserMessageId: telegramClientUserMessageId(ctx),
    })
    recordTelegramUserMessage(ctx, key, ctx.message, operation.conversationTurnId)
    addMemoryEvent(key, 'user', text)
  } catch (error) {
    console.warn('[steer] falling back to queued turn:', error.message)
    operation.supersedeResponse()
    enqueueFollowup(key, {
      ctx,
      text,
      contextMessages: [ctx.message],
      priorResponseWithheld: true,
      coalesce: true,
    })
    if (/active turn ended before steering/iu.test(String(error.message))) {
      operation.end()
      releaseActive(key, operation)
    } else {
      queueMicrotask(() => drainFollowups(key))
    }
  }
}

async function runCodexTurn(
  ctx,
  {
    text,
    messages = [],
    contextMessages = [],
    control = null,
    priorResponseWithheld = false,
  }
) {
  const key = keyOf(ctx)
  if (active.has(key) && active.get(key) !== control) {
    return say(ctx, '⏳ Still working on the previous message. <code>/stop</code> to interrupt.')
  }

  const operation = control || newTurnControl()
  const turnMessages = resolveTurnMessages(ctx.message, messages, contextMessages)
  bindConversationTurnId(operation, ctx, turnMessages.context)
  active.set(key, operation)

  const session = getSession(key, config.defaultWorkspace)
  let episode = getSkillEpisode(key)
  let invocation = parseSkillInvocation(text, skillCatalog.aliases)
  if (!invocation && config.backend === 'app-server' && config.skillRouterEnabled && text.trim()) {
    const route = await decideSkillRoute({
      text,
      episode,
      recentMessages: skillRouterHistory(key, session, turnMessages.context),
      skills: skillCatalog.skills,
      classify: (prompt) => classifySkillRoute(session, prompt, operation),
    })
    if (route.action !== 'main' && route.source !== 'default') {
      console.log(
        `[skills] route session=${key} action=${route.action} skill=${route.skill || '-'} source=${route.source}${route.confidence === undefined ? '' : ` confidence=${route.confidence}`}`
      )
    }
    if (operation.cancelled) {
      releaseActive(key, operation)
      return
    }
    if ((route.action === 'end' || route.action === 'switch') && episode) {
      const closing = episode
      try {
        await closeSkillEpisode(key, session, operation)
        episode = null
        // A switch announces itself through the start notice instead.
        if (route.action === 'end') {
          await say(ctx, automaticSkillEndedNotice(closing.skill_name)).catch((error) => {
            console.warn('[skills] could not send automatic end notice:', error.message)
          })
        }
      } catch (error) {
        releaseActive(key, operation)
        return say(
          ctx,
          `❌ 自动结束 Skill episode 失败：<pre>${render.escapeHtml(error.message)}</pre>`
        )
      }
    }
    if ((route.action === 'start' || route.action === 'switch') && route.skill) {
      invocation = {
        name: route.skill,
        prompt: text.trim(),
        original: text.trim(),
        automatic: true,
      }
    }
  }
  let startingSkill = null
  if (invocation) {
    if (config.backend !== 'app-server') {
      releaseActive(key, operation)
      return say(ctx, '❌ 显式 Skill episode 需要 app-server 后端。')
    }
    if (episode && episode.skill_name.toLowerCase() !== invocation.name.toLowerCase()) {
      releaseActive(key, operation)
      return say(
        ctx,
        `🧩 <code>${render.escapeHtml(episode.skill_name)}</code> episode 仍在进行；请先用 <code>/skill off</code> 结束。`
      )
    }
    if (!episode) {
      let skills
      try {
        skills = await appServerBackend.listSkills(session.workspace)
      } catch (error) {
        releaseActive(key, operation)
        return say(
          ctx,
          `❌ 无法读取 Skills：<pre>${render.escapeHtml(error.message)}</pre>`
        )
      }
      startingSkill = findEnabledSkill(skills, invocation.name)
      if (!startingSkill) {
        releaseActive(key, operation)
        return say(
          ctx,
          `❌ 找不到已启用的 Skill：<code>${render.escapeHtml(invocation.name)}</code>\n可用 <code>/skill list</code> 查看。`
        )
      }
    }
  }
  const activeThreadId = episode?.worker_thread_id || session.thread_id
  const forkFromThreadId = startingSkill && session.thread_id ? session.thread_id : null
  const isFirstTurn = !activeThreadId && !forkFromThreadId
  const threadCarryover = isFirstTurn && config.recentThreadContextEnabled
    ? getThreadCarryover(key)
    : null
  const model = session.model || config.model
  const effort = session.effort || config.reasoningEffort
  const status = new StatusLine(ctx)
  let turn = null
  let files = []
  let newThreadId = null
  let responseSequence = 0
  const phaseResponses = createPhaseResponseRouter()
  let memoryUserRecorded = false
  let recentContextInjected = false
  let turnCompleted = false
  let finalRevision = null
  let threadStateRecorded = false

  const freezeFinalRevision = () => {
    if (finalRevision === null) finalRevision = operation.responseRevision
    return finalRevision
  }

  const recordCompletedThreadState = () => {
    if (threadStateRecorded || operation.cancelled) return
    if (episode || startingSkill) {
      if (!session.thread_id && newThreadId) recordTurn(key, newThreadId)
      else recordTurn(key, null)
    } else {
      recordTurn(key, newThreadId)
    }
    threadStateRecorded = true
  }

  try {
    turn = await createTurnDirectory()

    if (turnMessages.attachments.length) {
      await status.set('📥 <i>正在下载并校验附件…</i>')
      files = await downloadTelegramAttachments(
        ctx,
        turnMessages.attachments,
        turn,
        operation.abortController.signal
      )
    }

    if (operation.cancelled) return

    let memorySnapshot = null
    let developerInstructions = ''
    if (config.backend === 'app-server') {
      // Freeze one baseline per context window. A missing marker means a new
      // thread or a completed compaction. AGENTS.md is loaded independently of
      // MEMORY.md so a transient dynamic-memory failure cannot drop the fixed
      // profile from the new window.
      const baseline = await loadThreadBaseline({
        activeThreadId,
        getThreadMemoryHash,
        buildEvolvingMemorySnapshot,
        buildFixedProfileDeveloperInstructions,
      })
      memorySnapshot = baseline.memorySnapshot
      developerInstructions = baseline.developerInstructions
    } else if (isFirstTurn) {
      try {
        developerInstructions = await buildFixedProfileDeveloperInstructions()
      } catch (e) {
        console.warn('[memory] portrait injection failed, continuing without:', e.message)
      }
    }

    const promptText =
      (episode && invocation ? invocation.prompt : text.trim()) ||
      (files.some((file) => file.kind === 'document')
        ? '请检查这些附件，并说明你发现的内容。'
        : '请查看并分析这些图片。')
    const memoryUserText =
      text.trim() ||
      `[用户发送了 ${files.length} 个附件但没有文字说明；附件内容不得作为长期记忆来源。]`
    addMemoryEvent(key, 'user', memoryUserText)
    for (const message of turnMessages.context) {
      recordTelegramUserMessage(ctx, key, message, operation.conversationTurnId)
    }
    memoryUserRecorded = true
    const proactiveScheduleState = buildProactiveScheduleState({
      sessionKey: key,
      chatId: ctx.chat.id,
      timeZone: config.proactiveWakeTimezone,
    })
    developerInstructions = [developerInstructions, proactiveScheduleState]
      .filter(Boolean)
      .join('\n\n')
    const transferContext = buildTransferContext(files, turn.outbox)
    const messageContext = buildTelegramMessageContext(
      turnMessages.context,
      config.userTimezone
    )
    const reactionMessageId =
      turnMessages.context[0]?.message_id ?? ctx.message?.message_id
    const reactionHandler =
      config.backend === 'app-server' && reactionMessageId
        ? createTelegramReactionHandler({
            telegram: ctx.telegram,
            chatId: ctx.chat.id,
            messageId: reactionMessageId,
            allowedEmojis: config.telegramReactionEmojis,
          })
        : null
    const innerBatonHandler =
      config.backend === 'app-server'
        ? createInnerBatonHandler({
            sessionKey: key,
            currentRevision: () => operation.responseRevision,
          })
        : null
    const dynamicToolHandler =
      config.backend === 'app-server'
        ? createDynamicToolRouter({
            ...(reactionHandler ? { [telegramReactionTool.name]: reactionHandler } : {}),
            [innerBatonTool.name]: innerBatonHandler,
          })
        : null
    const innerBatonRecord =
      config.backend === 'app-server' ? getInnerBatonRecord(key) : null
    const innerBatonSnapshot =
      innerBatonRecord &&
      (startingSkill ||
        !activeThreadId ||
        getThreadInnerBatonVersion(activeThreadId) !== Number(innerBatonRecord.version))
        ? renderInnerBatonSnapshot(innerBatonRecord)
        : null
    const skillForTurn = startingSkill
      ? { name: startingSkill.name, path: startingSkill.path }
      : episode?.needs_reload
        ? { name: episode.skill_name, path: episode.skill_path }
        : null
    if (skillForTurn) {
      const skillSource = await fs.promises.readFile(skillForTurn.path, 'utf8')
      if (!developerInstructions) {
        developerInstructions = await buildFixedProfileDeveloperInstructions()
      }
      developerInstructions = [
        developerInstructions,
        episodeDeveloperInstructions(skillSource),
      ]
        .filter(Boolean)
        .join('\n\n')
      if (episode) touchSkillEpisode(key, { reloaded: true })
    }

    const gen = backend.runTurn({
      priority: 'main',
      workspace: session.workspace,
      threadId: forkFromThreadId ? null : activeThreadId,
      forkFromThreadId,
      prompt: buildPrompt(
        promptText,
        '',
        [
          config.backend === 'exec' ? threadCarryover?.content : '',
          priorResponseWithheld
            ? '<bridge_response_supersession>The preceding assistant answer in thread history was withheld and never shown to the user. Answer the latest user message with one self-contained revised response, incorporating any still-relevant content from that hidden answer.</bridge_response_supersession>'
            : '',
          messageContext,
          transferContext,
        ].filter(Boolean).join('\n\n')
      ),
      sandbox: config.sandbox,
      // Main Telegram turns must always be able to surface approval buttons,
      // even when the same long-lived thread was previously used by a wake.
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      model,
      effort,
      imagePaths: files.filter((file) => file.kind === 'image').map((file) => file.path),
      developerInstructions,
      memorySnapshot,
      innerBatonSnapshot,
      recentThreadContext:
        config.backend === 'app-server' ? threadCarryover?.content || '' : '',
      dynamicTools: [telegramReactionTool, innerBatonTool],
      dynamicToolHandler,
    })
    operation.setGenerator(gen)

    await ctx.sendChatAction('typing', replyOpts(ctx)).catch(() => {})

    // item.id -> Telegram message we posted for it. Only used in showToolCalls mode.
    const liveMsgs = new Map()
    // Fast, mandatory Skill reads are implementation scaffolding. Keep them
    // invisible so short conversational turns do not flash a status bubble.
    const quietToolIds = new Set()
    if (!config.showToolCalls) await status.set('🚀 <i>已提交…</i>')

    for await (const ev of gen) {
      switch (ev.type) {
        case 'thread.started':
          newThreadId = ev.thread_id
          if (startingSkill) {
            episode = saveSkillEpisode({
              sessionKey: key,
              skillName: startingSkill.name,
              skillPath: startingSkill.path,
              parentThreadId: session.thread_id || ev.thread_id,
              workerThreadId: ev.thread_id,
            })
            if (invocation?.automatic) {
              await say(ctx, automaticSkillStartedNotice(startingSkill.name)).catch((error) => {
                console.warn('[skills] could not send automatic start notice:', error.message)
              })
            }
          }
          break

        case 'memory.anchored':
          setThreadMemoryHash(ev.thread_id, ev.memory_hash)
          break

        case 'inner_baton.injected':
          setThreadInnerBatonVersion(ev.thread_id, key, Number(ev.version))
          break

        case 'recent_context.injected':
          recentContextInjected = true
          break

        case 'item.started': {
          const it = ev.item
          phaseResponses.start(it, operation.responseRevision)
          if (!config.showToolCalls) {
            if (render.isQuietSkillRead(it) || isQuietInnerBatonItem(it)) {
              if (it?.id) quietToolIds.add(it.id)
              await status.drop()
            } else {
              await status.set(render.statusFor(it))
            }
          } else if (it?.type === 'command_execution') {
            const m = await say(ctx, render.commandRunning(it.command))
            if (m) liveMsgs.set(it.id, m.message_id)
          }
          break
        }

        case 'item.completed': {
          const it = ev.item
          if (!it) break

          if (it.type === 'context_compaction') {
            const compactedThreadId = ev.thread_id || newThreadId || session.thread_id
            clearThreadMemoryHash(compactedThreadId)
            clearThreadInnerBatonVersion(compactedThreadId)
            if (episode) markSkillEpisodeReload(key)
          }

          if (it.type === 'agent_message') {
            const response = await completePhaseResponse({
              responses: phaseResponses,
              item: it,
              currentRevision: () => operation.responseRevision,
              responseSuperseded: () => operation.responseSuperseded,
              dropStatus: () => status.drop(),
              sayCommentary: (text) => sayFormatted(ctx, text),
            })
            if (response.kind === 'commentary') {
              addMemoryEvent(key, 'assistant', response.text)
              recordTelegramAssistantMessage(
                ctx,
                key,
                response.sent,
                response.text,
                operation.conversationTurnId
              )
            } else if (response.kind === 'final') {
              await status.drop()
            }
            break
          }

          if (!config.showToolCalls) {
            if (it.id && quietToolIds.delete(it.id)) break
            // A tool just finished, so the agent is thinking again.
            await status.set('🤔 <i>思考中…</i>')
            break
          }

          if (it.type === 'command_execution') {
            const body = render.commandDone(it)
            const msgId = liveMsgs.get(it.id)
            if (msgId) {
              await ctx.telegram
                .editMessageText(ctx.chat.id, msgId, undefined, render.chunk(body)[0], {
                  parse_mode: 'HTML',
                })
                .catch(() => say(ctx, body))
            } else {
              await say(ctx, body)
            }
            liveMsgs.delete(it.id)
          } else if (it.type === 'file_change') {
            const files = (it.changes || it.files || []).map((f) => f.path || f).slice(0, 20)
            await say(
              ctx,
              `📝 <b>files changed</b>\n<pre>${render.escapeHtml(files.join('\n'))}</pre>`
            )
          } else if (it.type === 'mcp_tool_call') {
            await say(ctx, `🔌 <code>${render.escapeHtml(it.server || '')}.${render.escapeHtml(it.tool || '')}</code>`)
          } else if (it.type === 'web_search') {
            await say(ctx, `🔍 <i>${render.escapeHtml(it.query || 'search')}</i>`)
          }
          break
        }

        case 'turn.completed': {
          turnCompleted = true
          // Freeze the final revision and persist a fresh thread id before
          // making this key available to the next queued message. Otherwise a
          // first turn can race its follow-up and split the conversation.
          freezeFinalRevision()
          recordCompletedThreadState()
          operation.end()
          releaseActive(key, operation)
          // Cosmetic Telegram cleanup must not block the next turn.
          await status.drop()
          break
        }

        case 'turn.failed':
          // Failed turns are terminal too. Preserve a thread created before
          // the failure, then release the key before rendering the error so a
          // follow-up cannot steer this dead operation.
          freezeFinalRevision()
          recordCompletedThreadState()
          operation.end()
          releaseActive(key, operation)
          await status.drop()
          await say(
            ctx,
            `❌ <b>Turn failed</b>\n<pre>${render.escapeHtml(
              JSON.stringify(ev.error ?? ev, null, 2).slice(0, 1200)
            )}</pre>`
          )
          break

        case 'approval.requested':
          await status.drop()
          {
            const approvalKey = mcpApprovalKey(ev.approval)
            const allowed = sessionMcpApprovals.get(key)
            if (approvalKey && allowed?.has(approvalKey)) {
              await ev.approval.respond('accept')
              await status.set(
                `🔓 <code>${render.escapeHtml(approvalKey)}</code> <i>已按本会话授权自动允许</i>`
              )
            } else {
              await showApproval(ctx, ev.approval)
            }
          }
          break

        case 'error':
          await status.drop()
          await say(ctx, `⚠️ <pre>${render.escapeHtml(String(ev.message).slice(0, 1500))}</pre>`)
          break

        default:
          break
      }
    }

    if (!operation.cancelled) {
      const commitRevision = finalRevision ?? operation.responseRevision
      const responseText = phaseResponses.finalTextFor(commitRevision)
      if (!responseText && reactionHandler?.state.succeeded) {
        console.log(`[reaction] reaction-only turn completed for ${key}`)
      }
      if (responseText) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, config.responseCommitGraceMs)
          timer.unref()
        })
      }
      const commitResponse =
        !operation.cancelled &&
        !operation.responseSuperseded &&
        operation.responseRevision === commitRevision
      if (commitResponse && responseText) {
        responseSequence += 1
        const sent = await sayAgent(ctx, responseText, turn, responseSequence)
        addMemoryEvent(key, 'assistant', responseText)
        recordTelegramAssistantMessage(
          ctx,
          key,
          sent,
          responseText,
          operation.conversationTurnId
        )
      }
      if (commitResponse) await sendOutbox(ctx, turn.outbox)
      if (commitResponse && responseText) {
        const batonCommit = innerBatonHandler?.commit(commitRevision)
        if (batonCommit && !batonCommit.ok) {
          console.warn('[inner-baton] staged update lost a version race; resync queued')
        }
      }
      recordCompletedThreadState()
      if (episode) touchSkillEpisode(key)
      if (
        isFirstTurn &&
        threadCarryover &&
        (recentContextInjected || (config.backend === 'exec' && turnCompleted))
      ) {
        clearThreadCarryover(key)
      }
      if (memoryUserRecorded) maybeReviewMemory()
    }
  } catch (e) {
    if (operation.cancelled || e.name === 'AbortError') return
    console.error('[turn]', e)
    const prefix = e instanceof AttachmentError ? '❌ 附件处理失败：' : '💥 '
    await say(ctx, `${prefix}<pre>${render.escapeHtml(e.message)}</pre>`).catch(() => {})
  } finally {
    // The bar is scaffolding, not output — it must never outlive the turn,
    // including when /stop kills the process mid-command.
    operation.end()
    releaseActive(key, operation)
    await status.drop().catch(() => {})
    // If the consumer exits early (for example while rendering an approval),
    // the App Server generator otherwise remains registered against its old
    // turn and later messages are steered into that orphan.  `kill()` is a
    // no-op after a normally completed generator, but interrupts any live one.
    operation.kill?.()
    if (turn) scheduleTurnCleanup(turn.root)
  }
}

bot.on('text', (ctx) => {
  const text = ctx.message.text
  if (text.startsWith('/')) return
  steerOrQueueText(ctx, text).catch((error) => console.error('[text-turn]', error))
})

function attachmentCaption(messages) {
  return messages
    .map((message) => message.caption?.trim())
    .filter(Boolean)
    .join('\n')
}

function handleSingleAttachment(ctx) {
  recordTelegramUserMessage(ctx, keyOf(ctx))
  runCodexTurn(ctx, {
    text: ctx.message.caption || '',
    messages: [ctx.message],
  }).catch((error) => console.error('[attachment-turn]', error))
}

function queueMediaGroup(ctx) {
  const key = keyOf(ctx)
  recordTelegramUserMessage(ctx, key)
  const groupId = ctx.message.media_group_id
  const groupKey = `${key}:${groupId}`
  let group = mediaGroups.get(groupKey)

  if (!group) {
    if (active.has(key)) {
      return say(ctx, '⏳ Still working on the previous message. <code>/stop</code> to interrupt.')
    }

    const control = newTurnControl()
    const originalKill = control.kill.bind(control)
    control.kill = () => {
      originalKill()
      clearTimeout(group?.timer)
      mediaGroups.delete(groupKey)
      if (!group?.started) releaseActive(key, control)
    }
    group = { ctx, messages: [], control, timer: null, started: false }
    mediaGroups.set(groupKey, group)
    active.set(key, control)
  }

  group.messages.push(ctx.message)
  clearTimeout(group.timer)
  group.timer = setTimeout(() => {
    mediaGroups.delete(groupKey)
    group.started = true
    group.messages.sort((a, b) => a.message_id - b.message_id)
    runCodexTurn(group.ctx, {
      text: attachmentCaption(group.messages),
      messages: group.messages,
      control: group.control,
    }).catch((error) => console.error('[media-group]', error))
  }, 800)
  group.timer.unref()
}

bot.on('photo', (ctx) =>
  ctx.message.media_group_id ? queueMediaGroup(ctx) : handleSingleAttachment(ctx)
)

bot.on('document', (ctx) =>
  ctx.message.media_group_id ? queueMediaGroup(ctx) : handleSingleAttachment(ctx)
)

// ---------------------------------------------------------------- lifecycle

bot.catch((err, ctx) => {
  console.error(`[telegraf] ${ctx.updateType}`, err)
})

bot.launch(async () => {
  // Drives the "/" autocomplete popup. Telegram caches this per bot, so it only
  // needs to succeed once — a failure here is not worth refusing to start over.
  try {
    await bot.telegram.setMyCommands(COMMANDS)
  } catch (e) {
    console.warn('[setMyCommands] failed, autocomplete may be stale:', e.message)
  }
  try {
    await ensureMemoryFile()
  } catch (error) {
    console.warn('[memory] could not initialize MEMORY.md:', error.message)
  }
  const sweepAttachments = () =>
    sweepStaleTurnDirectories().catch((e) =>
      console.warn('[attachments] stale cleanup failed:', e.message)
    )
  sweepAttachments()
  const cleanupTimer = setInterval(
    sweepAttachments,
    Math.max(60_000, Math.min(config.attachmentRetentionMs, 5 * 60_000))
  )
  cleanupTimer.unref()
  stopJournalCollector = startDailyJournalCollector()
  stopProactiveWakeScheduler = startProactiveWakeScheduler({
    backend,
    telegram: bot.telegram,
    active,
    drainFollowups,
  })
  for (const notification of getRestartNotifications()) {
    try {
      await bot.telegram.sendMessage(notification.chat_id, '✅ 机器人已重启，最新代码已加载。', {
        ...(notification.topic_id
          ? { message_thread_id: notification.topic_id }
          : {}),
      })
      deleteRestartNotification(notification.id)
    } catch (error) {
      console.warn('[restart] success notification failed:', error.message)
    }
  }
  console.log(`codex-tg up. allowed users: ${config.allowedUsers.join(', ')}`)
  console.log(`default workspace: ${config.defaultWorkspace}`)
  console.log(
    `backend: ${config.backend} | sandbox: ${config.sandbox} | model: ${config.model || 'default'} | effort: ${
      config.reasoningEffort || 'default'
    } | tool calls: ${config.showToolCalls ? 'shown' : 'collapsed'}`
  )
  console.log(
    `portrait files: ${config.profileFiles.length} | memory: ${config.memoryFile} | review every ${config.memoryReviewInterval} user messages`
  )
})

process.once('SIGINT', () => {
  stopJournalCollector()
  stopProactiveWakeScheduler()
  appServerBackend.close?.()
  bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
  stopJournalCollector()
  stopProactiveWakeScheduler()
  appServerBackend.close?.()
  bot.stop('SIGTERM')
})
