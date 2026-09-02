import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import {
  tokenUsageFromEvent,
  readThreadUsage,
  USAGE_CONTEXT_WINDOW,
  contextPercent,
  cacheHitPercent,
  formatInteger,
  formatReset,
  formatAccountLimit,
} from '../src/usage.js'

function tokenEvent(totalTokens, { inputTokens = totalTokens, outputTokens = 0 } = {}) {
  return {
    timestamp: '2026-07-31T09:57:47.838Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 500000,
          cached_input_tokens: 450000,
          output_tokens: 20000,
          total_tokens: 520000,
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
        },
        model_context_window: 258400,
      },
    },
  }
}

test('extracts cumulative and current usage from rollout token events', () => {
  assert.deepEqual(
    tokenUsageFromEvent({
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 194158,
          cached_input_tokens: 143872,
          output_tokens: 1074,
          total_tokens: 195232,
        },
        last_token_usage: {
          input_tokens: 24766,
          cached_input_tokens: 24320,
          output_tokens: 195,
          total_tokens: 24961,
        },
        model_context_window: 258400,
      },
    }),
    {
      total: {
        inputTokens: 194158,
        cachedInputTokens: 143872,
        outputTokens: 1074,
        totalTokens: 195232,
      },
      last: {
        inputTokens: 24766,
        cachedInputTokens: 24320,
        outputTokens: 195,
        totalTokens: 24961,
      },
      modelContextWindow: 258400,
    }
  )
})

test('formats usage and reset values for Telegram', () => {
  assert.equal(formatInteger(87749), '87,749')
  assert.equal(USAGE_CONTEXT_WINDOW, 353400)
  assert.equal(contextPercent(87749, USAGE_CONTEXT_WINDOW), 25)
  assert.equal(cacheHitPercent(6425088, 7799447), 82.4)
  assert.equal(cacheHitPercent(0, 7799447), 0)
  assert.equal(cacheHitPercent(5, 0), null)
  assert.equal(cacheHitPercent(120, 100), 100)
  assert.equal(
    formatReset(1785813780, Date.parse('2026-07-28T12:00:00Z'), 'Asia/Taipei'),
    'resets in 6d 15h (2026-08-04 11:23 Asia/Taipei)'
  )
  assert.equal(
    formatAccountLimit(
      '5h',
      { usedPercent: 45, resetsAt: 1787726515 },
      Date.parse('2026-08-26T00:00:00Z')
    ),
    '5h: 55% remaining (45% used) • resets in 6h 42m (2026-08-26 06:41 UTC)'
  )
  assert.equal(
    formatAccountLimit(
      'Weekly',
      { usedPercent: 12, resetsAt: 1788272331 },
      Date.parse('2026-08-26T00:00:00Z')
    ),
    'Weekly: 88% remaining (12% used) • resets in 6d 14h (2026-09-01 14:18 UTC)'
  )
  assert.equal(formatAccountLimit('Weekly', null), 'Weekly: rate-limit data unavailable')
})

test('tracks the active compaction window separately from carried raw context', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const threadId = 'thread-compact-usage'
  const dir = path.join(root, '2026', '07', '31')
  await mkdir(dir, { recursive: true })
  const events = [
    { type: 'turn_context', payload: { model: 'gpt-test' } },
    tokenEvent(130830, { inputTokens: 130557, outputTokens: 273 }),
    {
      timestamp: '2026-07-31T09:57:47.832Z',
      type: 'compacted',
      payload: { window_number: 1, replacement_history: [] },
    },
    tokenEvent(8323, { inputTokens: 0, outputTokens: 0 }),
    tokenEvent(131793, { inputTokens: 131689, outputTokens: 104 }),
  ]
  await writeFile(
    path.join(dir, `rollout-${threadId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  )

  const usage = await readThreadUsage(threadId, { sessionRoots: [root] })
  assert.equal(usage.model, 'gpt-test')
  assert.equal(usage.last.totalTokens, 131793)
  assert.deepEqual(usage.compactWindow, {
    timestamp: '2026-07-31T09:57:47.832Z',
    windowNumber: 1,
    beforeTokens: 130830,
    compactedTokens: 8323,
    latestRawTokens: 131793,
    growthTokens: 963,
    currentTokens: 9286,
  })
})

test('tracks growth when the raw context counter resets after compaction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-reset-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const threadId = 'thread-compact-reset'
  const dir = path.join(root, '2026', '07', '31')
  await mkdir(dir, { recursive: true })
  const events = [
    tokenEvent(214909, { inputTokens: 214000, outputTokens: 909 }),
    {
      timestamp: '2026-07-31T10:32:38.749Z',
      type: 'compacted',
      payload: { window_number: 1, replacement_history: [] },
    },
    tokenEvent(16766, { inputTokens: 0, outputTokens: 0 }),
    tokenEvent(22668, { inputTokens: 22400, outputTokens: 268 }),
  ]
  await writeFile(
    path.join(dir, `rollout-${threadId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  )

  const usage = await readThreadUsage(threadId, { sessionRoots: [root] })
  assert.deepEqual(usage.compactWindow, {
    timestamp: '2026-07-31T10:32:38.749Z',
    windowNumber: 1,
    beforeTokens: 214909,
    compactedTokens: 16766,
    latestRawTokens: 22668,
    growthTokens: 5902,
    currentTokens: 22668,
  })
})
