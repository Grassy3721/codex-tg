import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tg-journal-test-'))
process.env.DB_PATH = path.join(root, 'sessions.db')
process.env.JOURNAL_COLLECTOR_TASK_NAME = 'daily-journal-event-collector-test'
process.env.JOURNAL_COLLECTOR_WORKSPACE = root
process.env.JOURNAL_COLLECTOR_TIMEZONE = 'Asia/Taipei'

const {
  journalWindow,
  previousCalendarDate,
  runDailyJournalCollector,
  validateJournalPayload,
} = await import('../src/journalCollector.js')
const {
  addConversationMessage,
  getJournalCollectorEvent,
  getJournalCollectorRun,
} = await import('../src/db.js')

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('journal day is the local 03:00-to-03:00 window', () => {
  assert.equal(
    previousCalendarDate(Date.parse('2026-07-30T20:03:00Z'), 'Asia/Taipei'),
    '2026-07-30'
  )
  const window = journalWindow('2026-07-30', 'Asia/Taipei')
  assert.equal(new Date(window.startMs).toISOString(), '2026-07-29T19:00:00.000Z')
  assert.equal(new Date(window.endMs).toISOString(), '2026-07-30T19:00:00.000Z')
})

test('payload validation grounds evidence, deduplicates, and drops secrets', () => {
  const messages = [
    {
      id: 1,
      source_id: 'telegram:1:101',
      role: 'user',
      content: '今天练车了',
      sent_at: Date.now(),
    },
  ]
  const payload = validateJournalPayload(
    {
      targetDate: '2026-07-30',
      events: [
        {
          content: '今天练车。',
          tags: ['生活', '生活'],
          evidenceMessageIds: ['telegram:1:101', 'invented'],
        },
        {
          content: '今天练车。',
          tags: ['重复'],
          evidenceMessageIds: ['telegram:1:101'],
        },
        {
          content: 'token=super-secret-value',
          tags: ['秘密'],
          evidenceMessageIds: ['telegram:1:101'],
        },
      ],
    },
    { targetDate: '2026-07-30', messages }
  )
  assert.deepEqual(payload.events, [
    {
      content: '今天练车。',
      tags: ['生活'],
      evidenceMessageIds: ['telegram:1:101'],
    },
  ])
})

test('collector reviews, appends once, records hashes, and skips a completed rerun', async () => {
  addConversationMessage({
    sourceId: 'telegram:1:101',
    sessionKey: '1:0',
    chatId: 1,
    telegramMessageId: 101,
    role: 'user',
    content: '今天倒车顺多了，只压了一次线。',
    sentAt: Date.parse('2026-07-30T08:00:00+08:00'),
  })

  const calls = []
  const backend = {
    runTurn(options) {
      calls.push(options)
      if (options.outputSchema) {
        return (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: JSON.stringify({
                targetDate: '2026-07-30',
                events: [
                  {
                    content: '练车时倒车明显更顺，只出现一次压线。',
                    tags: ['生活', '练车'],
                    evidenceMessageIds: ['telegram:1:101'],
                  },
                ],
              }),
            },
          }
          yield { type: 'turn.completed' }
        })()
      }
      return (async function* () {
        yield {
          type: 'item.started',
          item: { type: 'mcp_tool_call', server: 'codex_apps', tool: '_append_journal' },
        }
        yield {
          type: 'approval.requested',
          approval: {
            kind: 'user_input',
            params: {
              questions: [{ options: [{ label: 'Accept' }, { label: 'Decline' }] }],
            },
            respond: async (action, value) => {
              assert.equal(action, 'accept')
              assert.equal(value, 'Accept')
            },
          },
        }
        yield {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'codex_apps',
            tool: '_append_journal',
            status: 'completed',
          },
        }
        yield { type: 'turn.completed' }
      })()
    },
  }

  const result = await runDailyJournalCollector({ targetDate: '2026-07-30', backend })
  assert.equal(result.messageCount, 1)
  assert.equal(result.events.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].ephemeral, true)
  assert.equal(calls[0].approvalPolicy, 'never')
  assert.equal(calls[1].ephemeral, true)
  assert.equal(calls[1].approvalPolicy, 'on-request')

  const run = getJournalCollectorRun(
    'daily-journal-event-collector-test',
    '2026-07-30'
  )
  assert.equal(run.status, 'completed')
  assert.equal(run.message_count, 1)
  assert.equal(run.message_hash.length, 64)

  const eventHash = (
    await import('node:crypto')
  ).createHash('sha256').update(
    JSON.stringify([
      '2026-07-30',
      '练车时倒车明显更顺，只出现一次压线。',
      ['生活', '练车'],
    ])
  ).digest('hex')
  assert.equal(
    getJournalCollectorEvent(
      'daily-journal-event-collector-test',
      '2026-07-30',
      eventHash
    ).status,
    'written'
  )

  const rerun = await runDailyJournalCollector({ targetDate: '2026-07-30', backend })
  assert.equal(rerun.skipped, true)
  assert.equal(calls.length, 2)
})
