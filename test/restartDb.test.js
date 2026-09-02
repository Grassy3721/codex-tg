import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tg-db-test-'))
process.env.DB_PATH = path.join(directory, 'sessions.db')

const {
  queueRestartNotification,
  getRestartNotifications,
  deleteRestartNotification,
  clearThreadMemoryHash,
  getThreadMemoryHash,
  setThreadMemoryHash,
  compareAndSetInnerBaton,
  clearThreadInnerBatonVersion,
  ensureInnerBatonRecord,
  getInnerBatonRecord,
  getThreadInnerBatonVersion,
  setThreadInnerBatonVersion,
} = await import('../src/db.js')

test('restart success notifications are stored and cleared in SQLite', async (t) => {
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const id = queueRestartNotification(-100123, 42)
  assert.deepEqual(
    getRestartNotifications().map(({ chat_id, topic_id }) => ({ chat_id, topic_id })),
    [{ chat_id: -100123, topic_id: 42 }]
  )

  deleteRestartNotification(id)
  assert.deepEqual(getRestartNotifications(), [])
})

test('memory hashes persist by Codex thread id', () => {
  assert.equal(getThreadMemoryHash('thread-a'), null)
  setThreadMemoryHash('thread-a', 'hash-one')
  assert.equal(getThreadMemoryHash('thread-a'), 'hash-one')
  setThreadMemoryHash('thread-a', 'hash-two')
  assert.equal(getThreadMemoryHash('thread-a'), 'hash-two')
  assert.equal(clearThreadMemoryHash('thread-a'), true)
  assert.equal(getThreadMemoryHash('thread-a'), null)
  assert.equal(clearThreadMemoryHash('thread-a'), false)
  assert.equal(getThreadMemoryHash('thread-b'), null)
})

test('inner baton uses optimistic versions and per-thread injection markers', () => {
  const initial = ensureInnerBatonRecord('session-baton')
  assert.equal(initial.version, 0)

  const first = compareAndSetInnerBaton({
    sessionKey: 'session-baton',
    expectedVersion: 0,
    stateJson: '{"locked":["truth"],"pending":[],"private":[],"next":null}',
    sourceThreadId: 'thread-baton',
    sourceTurnId: 'turn-one',
  })
  assert.equal(first.ok, true)
  assert.equal(first.record.version, 1)
  assert.equal(getInnerBatonRecord('session-baton').source_turn_id, 'turn-one')

  const stale = compareAndSetInnerBaton({
    sessionKey: 'session-baton',
    expectedVersion: 0,
    stateJson: '{"locked":[],"pending":[],"private":[],"next":null}',
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.record.version, 1)

  assert.equal(getThreadInnerBatonVersion('thread-baton'), null)
  setThreadInnerBatonVersion('thread-baton', 'session-baton', 1)
  assert.equal(getThreadInnerBatonVersion('thread-baton'), 1)
  assert.equal(clearThreadInnerBatonVersion('thread-baton'), true)
  assert.equal(getThreadInnerBatonVersion('thread-baton'), null)
})
