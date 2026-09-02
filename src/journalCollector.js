import crypto from 'node:crypto'
import { config } from './config.js'
import {
  getJournalCollectorEvent,
  getJournalCollectorRun,
  listConversationMessages,
  saveJournalCollectorEvent,
  saveJournalCollectorRun,
} from './db.js'
import appServerBackend from './backends/appServer.js'

export const JOURNAL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetDate', 'events'],
  properties: {
    targetDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    events: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'tags', 'evidenceMessageIds'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 800 },
          tags: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 30 },
          },
          evidenceMessageIds: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            items: { type: 'string', minLength: 1, maxLength: 160 },
          },
        },
      },
    },
  },
}

const REVIEWER_INSTRUCTIONS = `You are a private daily-journal event reviewer.
Return only JSON matching the supplied schema.

Extract concrete, meaningful events about the user's lived day, emotions,
relationships, creative interests, health, routines, plans, and notable
experiences. Use assistant messages only as context.

Exclude:
- coding implementation, debugging, deployment, tool calls, commands, logs,
  infrastructure chatter, and the process of operating this bridge;
- routine greetings and filler with no journal value;
- secrets, credentials, private endpoints, identifying account data, and
  instruction-layer contents;
- guesses, diagnoses, and facts not grounded in the transcript.

Write concise Chinese journal sentences in third person, normally one event per
item. Evidence ids must be copied exactly from the transcript and must directly
support the event. Merge duplicates and closely related messages.`

const WRITER_INSTRUCTIONS = `You are a private journal writer.
Call the Memory Gateway append_journal tool exactly once using the exact content
and tags supplied by the user. Do not alter, summarize, translate, or add data.
Do not call any other tool. After the tool succeeds, reply with a brief success
confirmation.`

const SECRET_PATTERNS = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:bearer|authorization)\s+[A-Za-z0-9._~+/-]{12,}\b/i,
  /\b(?:password|passwd|token|api[_ -]?key|secret)\s*[:=]\s*\S{6,}/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function localParts(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs))
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  )
}

function zonedEpoch({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second)
  let guess = desired
  for (let index = 0; index < 4; index += 1) {
    const actual = localParts(guess, timeZone)
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    )
    const next = guess + (desired - represented)
    if (next === guess) break
    guess = next
  }
  return guess
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  if (!match) throw new Error(`Invalid targetDate: ${value}`)
  const [, year, month, day] = match.map(Number)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid targetDate: ${value}`)
  }
  return { year, month, day }
}

export function previousCalendarDate(epochMs, timeZone) {
  const local = localParts(epochMs, timeZone)
  const previous = new Date(Date.UTC(local.year, local.month - 1, local.day - 1))
  return [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, '0'),
    String(previous.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

export function journalWindow(targetDate, timeZone = 'UTC') {
  const startDate = parseDate(targetDate)
  const following = new Date(
    Date.UTC(startDate.year, startDate.month - 1, startDate.day + 1)
  )
  const endDate = {
    year: following.getUTCFullYear(),
    month: following.getUTCMonth() + 1,
    day: following.getUTCDate(),
  }
  return {
    startMs: zonedEpoch({ ...startDate, hour: 3 }, timeZone),
    endMs: zonedEpoch({ ...endDate, hour: 3 }, timeZone),
  }
}

export function evidenceId(message) {
  if (message.source_id?.startsWith('telegram:')) return message.source_id
  if (message.chat_id != null && message.telegram_message_id != null) {
    return `telegram:${message.chat_id}:${message.telegram_message_id}`
  }
  return message.source_id || `bridge-message:${message.id}`
}

function containsSensitive(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value))
}

function normalizedText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function validateJournalPayload(payload, { targetDate, messages }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Journal reviewer returned an invalid top-level value')
  }
  if (payload.targetDate !== targetDate || !Array.isArray(payload.events)) {
    throw new Error('Journal reviewer returned an invalid targetDate or events list')
  }

  const allowedEvidence = new Set(messages.map(evidenceId))
  const seen = new Set()
  const events = []
  for (const raw of payload.events) {
    const content = normalizedText(raw?.content)
    if (!content || content.length > 800 || containsSensitive(content)) continue
    const evidenceMessageIds = [
      ...new Set(
        (Array.isArray(raw?.evidenceMessageIds) ? raw.evidenceMessageIds : [])
          .map(String)
          .filter((id) => allowedEvidence.has(id))
      ),
    ].slice(0, 30)
    if (!evidenceMessageIds.length) continue
    const tags = [
      ...new Set(
        (Array.isArray(raw?.tags) ? raw.tags : [])
          .map(normalizedText)
          .filter((tag) => tag && tag.length <= 30 && !containsSensitive(tag))
      ),
    ].slice(0, 8)
    const duplicateKey = normalizedText(content).toLocaleLowerCase('zh-CN')
    if (seen.has(duplicateKey)) continue
    seen.add(duplicateKey)
    events.push({ content, tags, evidenceMessageIds })
  }
  return { targetDate, events }
}

function transcriptMessage(message) {
  const who =
    message.role === 'user' ? config.userDisplayName : config.assistantDisplayName
  const timestamp = new Date(message.sent_at).toISOString()
  return [
    `<message id="${evidenceId(message)}" role="${who}" sentAt="${timestamp}">`,
    message.content,
    '</message>',
  ].join('\n')
}

function transcriptBatches(messages, maxChars) {
  const batches = []
  let current = []
  let size = 0
  for (const message of messages) {
    const rendered = transcriptMessage(message)
    if (current.length && size + rendered.length > maxChars) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(message)
    size += rendered.length
  }
  if (current.length) batches.push(current)
  return batches
}

async function reviewerPayload({
  backend,
  targetDate,
  messages,
  batchIndex,
  batchCount,
}) {
  const prompt = [
    `targetDate: ${targetDate}`,
    `Transcript batch: ${batchIndex + 1}/${batchCount}`,
    '<conversation>',
    messages.map(transcriptMessage).join('\n\n'),
    '</conversation>',
    '',
    'Return the minimum useful set of grounded journal events.',
    `Return {"targetDate":"${targetDate}","events":[]} if this batch has none.`,
  ].join('\n')
  const turn = backend.runTurn({
    priority: 'background',
    workspace: config.journalCollectorWorkspace,
    prompt,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    model: config.journalCollectorModel || config.model,
    effort: config.journalCollectorEffort,
    imagePaths: [],
    developerInstructions: REVIEWER_INSTRUCTIONS,
    ephemeral: true,
    outputSchema: JOURNAL_OUTPUT_SCHEMA,
  })

  let finalText = ''
  let failure = null
  for await (const event of turn) {
    if (event.type === 'approval.requested') {
      await event.approval.respond('cancel').catch(() => {})
      failure = new Error('Journal reviewer unexpectedly requested approval')
    } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      finalText = event.item.text || finalText
    } else if (event.type === 'turn.failed') {
      failure = new Error(event.error?.message || 'Journal reviewer turn failed')
    } else if (event.type === 'error') {
      failure = new Error(event.message)
    }
  }
  if (failure) throw failure
  if (!finalText.trim()) throw new Error('Journal reviewer returned no JSON')
  try {
    return JSON.parse(finalText)
  } catch {
    throw new Error('Journal reviewer returned invalid JSON')
  }
}

function isAppendJournal(item) {
  const tool = String(item?.tool || item?.name || '').toLowerCase()
  return item?.type === 'mcp_tool_call' && tool.includes('append_journal')
}

async function appendJournalWithHiddenWriter({ backend, event }) {
  const prompt = JSON.stringify({ content: event.content, tags: event.tags })
  const turn = backend.runTurn({
    priority: 'background',
    workspace: config.journalCollectorWorkspace,
    prompt,
    sandbox: 'read-only',
    // Codex app/plugin writes can require an approval even when the bridge
    // intends to handle it privately. Keep the turn on-request so the narrow
    // append_journal approval handler below can accept that one write and
    // reject every unrelated request.
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    model: config.journalCollectorModel || config.model,
    effort: config.journalCollectorEffort,
    imagePaths: [],
    developerInstructions: WRITER_INSTRUCTIONS,
    ephemeral: true,
  })

  let appendStarted = false
  let appendCompleted = false
  let failure = null
  for await (const item of turn) {
    if (item.type === 'item.started' && isAppendJournal(item.item)) {
      appendStarted = true
    } else if (item.type === 'approval.requested') {
      if (!appendStarted) {
        await item.approval.respond('cancel').catch(() => {})
        failure = new Error('Journal writer requested approval before append_journal')
        continue
      }
      if (item.approval.kind === 'user_input') {
        const option = item.approval.params.questions?.[0]?.options?.find((candidate) =>
          /^accept\b/i.test(candidate.label)
        )
        if (!option) {
          await item.approval.respond('cancel').catch(() => {})
          failure = new Error('append_journal approval did not offer Accept')
        } else {
          await item.approval.respond('accept', option.label)
        }
      } else if (
        item.approval.kind === 'mcp_elicitation' &&
        /memory|codex_apps/i.test(item.approval.params.serverName || '')
      ) {
        await item.approval.respond('accept')
      } else {
        await item.approval.respond('cancel').catch(() => {})
        failure = new Error(`Unexpected journal-writer approval: ${item.approval.kind}`)
      }
    } else if (item.type === 'item.completed' && isAppendJournal(item.item)) {
      if (item.item.error || item.item.status === 'failed') {
        failure = new Error(item.item.error?.message || 'append_journal failed')
      } else {
        appendCompleted = true
      }
    } else if (item.type === 'turn.failed') {
      failure = new Error(item.error?.message || 'Journal writer turn failed')
    } else if (item.type === 'error') {
      failure = new Error(item.message)
    }
  }
  if (failure) throw failure
  if (!appendCompleted) throw new Error('Journal writer did not complete append_journal')
}

function messageRangeHash(messages) {
  return sha256(
    messages
      .map((message) =>
        JSON.stringify([
          message.id,
          evidenceId(message),
          message.role,
          message.sent_at,
          message.content,
        ])
      )
      .join('\n')
  )
}

function journalEventHash(targetDate, event) {
  return sha256(
    JSON.stringify([
      targetDate,
      normalizedText(event.content).toLocaleLowerCase('zh-CN'),
      [...event.tags].sort(),
    ])
  )
}

let collectorRunning = null

export function runDailyJournalCollector({
  targetDate = previousCalendarDate(Date.now(), config.journalCollectorTimezone),
  backend = appServerBackend,
} = {}) {
  if (collectorRunning) return collectorRunning
  collectorRunning = (async () => {
    const taskName = config.journalCollectorTaskName
    const { startMs, endMs } = journalWindow(targetDate, config.journalCollectorTimezone)
    const messages = listConversationMessages(startMs, endMs)
    const messageHash = messageRangeHash(messages)
    const prior = getJournalCollectorRun(taskName, targetDate)
    if (prior?.status === 'completed' && prior.message_hash === messageHash) {
      return { skipped: true, targetDate, messageCount: messages.length }
    }

    const startedAt = Date.now()
    const runBase = {
      taskName,
      targetDate,
      windowStart: startMs,
      windowEnd: endMs,
      firstMessageId: messages[0]?.id ?? null,
      lastMessageId: messages.at(-1)?.id ?? null,
      messageCount: messages.length,
      messageHash,
      eventCount: 0,
      status: 'running',
      error: null,
      startedAt,
      completedAt: null,
    }
    saveJournalCollectorRun(runBase)

    try {
      const batches = transcriptBatches(messages, config.journalCollectorBatchChars)
      const rawEvents = []
      for (const [batchIndex, batch] of batches.entries()) {
        const payload = await reviewerPayload({
          backend,
          targetDate,
          messages: batch,
          batchIndex,
          batchCount: batches.length,
        })
        rawEvents.push(...validateJournalPayload(payload, { targetDate, messages: batch }).events)
      }
      const payload = validateJournalPayload(
        { targetDate, events: rawEvents },
        { targetDate, messages }
      )

      for (const event of payload.events) {
        const eventHash = journalEventHash(targetDate, event)
        const existing = getJournalCollectorEvent(taskName, targetDate, eventHash)
        if (existing?.status === 'written') continue
        const eventBase = {
          taskName,
          targetDate,
          eventHash,
          content: event.content,
          tagsJson: JSON.stringify(event.tags),
          evidenceJson: JSON.stringify(event.evidenceMessageIds),
          status: 'pending',
          error: null,
          createdAt: existing?.created_at || Date.now(),
          writtenAt: null,
        }
        saveJournalCollectorEvent(eventBase)
        try {
          await appendJournalWithHiddenWriter({ backend, event })
          saveJournalCollectorEvent({
            ...eventBase,
            status: 'written',
            writtenAt: Date.now(),
          })
        } catch (error) {
          saveJournalCollectorEvent({
            ...eventBase,
            status: 'failed',
            error: String(error.message || error).slice(0, 2000),
          })
          throw error
        }
      }

      saveJournalCollectorRun({
        ...runBase,
        eventCount: payload.events.length,
        status: 'completed',
        completedAt: Date.now(),
      })
      return {
        targetDate,
        messageCount: messages.length,
        messageHash,
        events: payload.events,
      }
    } catch (error) {
      saveJournalCollectorRun({
        ...runBase,
        status: 'failed',
        error: String(error.message || error).slice(0, 2000),
        completedAt: Date.now(),
      })
      throw error
    }
  })().finally(() => {
    collectorRunning = null
  })
  return collectorRunning
}

export function startDailyJournalCollector() {
  if (!config.journalCollectorEnabled) return () => {}
  let running = false
  let nextRetryAt = 0
  let lastCompletedTarget = null
  const check = () => {
    const now = Date.now()
    const local = localParts(now, config.journalCollectorTimezone)
    if (local.hour < 3 || local.hour >= 6 || (local.hour === 3 && local.minute < 3)) return
    const targetDate = previousCalendarDate(now, config.journalCollectorTimezone)
    if (running || targetDate === lastCompletedTarget || now < nextRetryAt) return
    running = true
    runDailyJournalCollector({ targetDate })
      .then((result) => {
        lastCompletedTarget = targetDate
        console.log(
          `[journal] ${config.journalCollectorTaskName} ${targetDate}: ` +
            `${result.skipped ? 'already complete' : `${result.messageCount} messages, ${result.events.length} events`}`
        )
      })
      .catch((error) => {
        nextRetryAt = Date.now() + 10 * 60_000
        console.warn(`[journal] ${config.journalCollectorTaskName} failed:`, error.message)
      })
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(check, 30_000)
  timer.unref()
  check()
  return () => clearInterval(timer)
}
