import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const SESSION_ROOTS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions'),
]
export const USAGE_CONTEXT_WINDOW = 353400

async function findRollout(dir, suffix) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name.endsWith(suffix)) return full
    if (entry.isDirectory()) {
      const found = await findRollout(full, suffix)
      if (found) return found
    }
  }
  return null
}

export function tokenUsageFromEvent(payload) {
  if (payload?.type !== 'token_count' || !payload.info) return null
  const total = payload.info.total_token_usage
  const last = payload.info.last_token_usage
  if (!total || !last) return null

  return {
    total: {
      inputTokens: total.input_tokens || 0,
      cachedInputTokens: total.cached_input_tokens || 0,
      outputTokens: total.output_tokens || 0,
      totalTokens: total.total_tokens || 0,
    },
    last: {
      inputTokens: last.input_tokens || 0,
      cachedInputTokens: last.cached_input_tokens || 0,
      outputTokens: last.output_tokens || 0,
      totalTokens: last.total_tokens || 0,
    },
    modelContextWindow: payload.info.model_context_window || null,
  }
}

/** Read only token metadata from the persisted Codex rollout. */
export async function readThreadUsage(threadId, { sessionRoots = SESSION_ROOTS } = {}) {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(threadId || '')) return null

  const suffix = `${threadId}.jsonl`
  let rollout = null
  for (const root of sessionRoots) {
    rollout = await findRollout(root, suffix)
    if (rollout) break
  }
  if (!rollout) return null

  const lines = readline.createInterface({
    input: fs.createReadStream(rollout, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let latest = null
  let latestModel = null
  let compaction = null
  for await (const line of lines) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'turn_context' && event.payload?.model) {
        latestModel = event.payload.model
      }
      if (event.type === 'compacted') {
        compaction = {
          timestamp: event.timestamp || null,
          windowNumber: event.payload?.window_number ?? null,
          beforeTokens: latest?.last.totalTokens ?? null,
          compactedTokens: null,
          latestRawTokens: null,
        }
      }
      if (event.type === 'event_msg') {
        const usage = tokenUsageFromEvent(event.payload)
        if (!usage) continue
        if (
          compaction &&
          compaction.compactedTokens === null &&
          usage.last.inputTokens === 0 &&
          usage.last.outputTokens === 0 &&
          usage.last.totalTokens > 0
        ) {
          compaction.compactedTokens = usage.last.totalTokens
        } else if (compaction && compaction.compactedTokens !== null) {
          compaction.latestRawTokens = usage.last.totalTokens
        }
        latest = usage
      }
    } catch {
      // A partially written final line should not hide earlier valid usage.
    }
  }
  if (!latest) return null

  let compactWindow = null
  if (
    compaction &&
    compaction.beforeTokens !== null &&
    compaction.compactedTokens !== null
  ) {
    const rawAfter = compaction.latestRawTokens
    const rawCounterReset = rawAfter !== null && rawAfter < compaction.beforeTokens
    const growthTokens = rawAfter === null
      ? 0
      : rawCounterReset
        ? Math.max(0, rawAfter - compaction.compactedTokens)
        : rawAfter - compaction.beforeTokens
    compactWindow = {
      ...compaction,
      growthTokens,
      currentTokens: rawCounterReset
        ? rawAfter
        : compaction.compactedTokens + growthTokens,
    }
  }

  return { ...latest, model: latestModel, compactWindow }
}

export function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Number(value) || 0))
}

export function contextPercent(used, limit) {
  if (!limit) return null
  return Math.min(100, Math.round((used / limit) * 100))
}

export function cacheHitPercent(cachedInputTokens, inputTokens) {
  const total = Math.max(0, Number(inputTokens) || 0)
  if (!total) return null
  const cached = Math.min(total, Math.max(0, Number(cachedInputTokens) || 0))
  return Math.round((cached / total) * 1000) / 10
}

export function formatReset(resetSeconds, nowMs = Date.now(), timeZone = 'UTC') {
  if (!resetSeconds) return 'reset time unavailable'
  const resetMs = resetSeconds * 1000
  const remainingMinutes = Math.max(0, Math.ceil((resetMs - nowMs) / 60000))
  const days = Math.floor(remainingMinutes / 1440)
  const hours = Math.floor((remainingMinutes % 1440) / 60)
  const minutes = remainingMinutes % 60
  const relative = [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    !days && minutes ? `${minutes}m` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(resetMs))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value])
  )
  const local = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timeZone}`
  return `resets in ${relative || '0m'} (${local})`
}

export function formatAccountLimit(label, window, nowMs = Date.now(), timeZone = 'UTC') {
  if (!window) return `${label}: rate-limit data unavailable`
  const used = Math.max(0, Math.min(100, Math.round(Number(window.usedPercent) || 0)))
  return `${label}: ${100 - used}% remaining (${used}% used) • ${formatReset(window.resetsAt, nowMs, timeZone)}`
}
