import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tg-thread-history-test-'))
process.env.DB_PATH = path.join(directory, 'sessions.db')

const legacy = new Database(process.env.DB_PATH)
legacy.exec(`
  CREATE TABLE sessions (
    key         TEXT PRIMARY KEY,
    thread_id   TEXT,
    workspace   TEXT NOT NULL,
    model       TEXT,
    effort      TEXT,
    turn_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  INSERT INTO sessions (
    key, thread_id, workspace, model, effort, turn_count, created_at, updated_at
  ) VALUES (
    'legacy:0', 'legacy-thread', '/tmp/legacy', NULL, NULL, 2, 1000, 2000
  );
`)
legacy.close()

const {
  addConversationMessage,
  archiveCurrentThread,
  getSession,
  listRecentConversationMessages,
  listRecentUserMessages,
  listThreadHistory,
  recordTurn,
  resetThread,
  resumeThread,
  sessionKey,
} = await import('../src/db.js')

test('existing session rows gain thread-history routing metadata', () => {
  const migrated = getSession('legacy:0', '/tmp/unused')
  assert.equal(migrated.thread_id, 'legacy-thread')
  assert.equal(migrated.context_message_id, 0)
  assert.equal(migrated.thread_started_at, 2000)
})

test('new threads archive, reset routing context, and resume by id', async () => {
  const key = sessionKey(4242, null)
  getSession(key, '/tmp/project-a')
  const firstMessageId = addConversationMessage({
    sourceId: 'telegram:4242:1',
    sessionKey: key,
    chatId: 4242,
    role: 'user',
    content: '我们的第一个房间',
    sentAt: 100_000,
  })
  recordTurn(key, 'thread-a')
  recordTurn(key, null)

  const archivedA = archiveCurrentThread(key)
  assert.equal(archivedA.preview, '我们的第一个房间')
  assert.equal(archivedA.turn_count, 2)
  assert.deepEqual(listThreadHistory(key), [])

  resetThread(key)
  const fresh = getSession(key, '/tmp/project-a')
  assert.equal(fresh.thread_id, null)
  assert.equal(fresh.turn_count, 0)
  assert.equal(fresh.context_message_id, Number(firstMessageId))
  assert.deepEqual(
    listRecentConversationMessages(key, 6, fresh.context_message_id),
    []
  )

  const secondMessageId = addConversationMessage({
    sourceId: 'telegram:4242:2',
    sessionKey: key,
    chatId: 4242,
    role: 'user',
    content: '这是新房间',
    sentAt: 200_000,
  })
  assert.deepEqual(
    listRecentConversationMessages(key, 6, fresh.context_message_id).map(
      ({ content }) => content
    ),
    ['这是新房间']
  )
  recordTurn(key, 'thread-b')
  archiveCurrentThread(key)

  assert.deepEqual(
    listThreadHistory(key).map(({ thread_id }) => thread_id),
    ['thread-a']
  )
  const resumed = resumeThread(key, 'thread-a')
  assert.equal(resumed.thread_id, 'thread-a')
  assert.equal(resumed.workspace, '/tmp/project-a')
  assert.equal(resumed.turn_count, 2)
  assert.equal(resumed.context_message_id, Number(secondMessageId))
  assert.deepEqual(
    listThreadHistory(key).map(({ thread_id }) => thread_id),
    ['thread-b']
  )

  addConversationMessage({
    sourceId: 'telegram:4242:3',
    sessionKey: key,
    chatId: 4242,
    role: 'user',
    content: '回到旧房间继续',
    sentAt: 300_000,
  })
  recordTurn(key, null)
  assert.equal(archiveCurrentThread(key).preview, '我们的第一个房间')
})

test('the skill-router window drops assistant replies and stale messages', (t) => {
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const key = sessionKey(5151, null)
  getSession(key, '/tmp/project-b')
  const now = Date.now()
  const add = (id, role, content, sentAt) =>
    addConversationMessage({
      sourceId: `telegram:5151:${id}`,
      sessionKey: key,
      chatId: 5151,
      telegramMessageId: id,
      role,
      content,
      sentAt,
    })

  add(1, 'user', '昨晚那句', now - 10 * 60 * 60 * 1000)
  add(2, 'user', '帮我看看这个函数', now - 3 * 60 * 1000)
  add(3, 'assistant', '这里有一个空指针风险……', now - 2 * 60 * 1000)
  add(4, 'user', '再仔细点', now - 60 * 1000)

  const window = { limit: 3, afterId: 0, sinceMs: now - 30 * 60 * 1000 }
  assert.deepEqual(
    listRecentUserMessages(key, window).map(({ content }) => content),
    ['帮我看看这个函数', '再仔细点']
  )

  assert.deepEqual(
    listRecentUserMessages(key, { ...window, sinceMs: 0 }).map(({ content }) => content),
    ['昨晚那句', '帮我看看这个函数', '再仔细点']
  )

  assert.deepEqual(
    listRecentUserMessages(key, window).map(({ telegram_message_id }) => telegram_message_id),
    [2, 4]
  )
})
