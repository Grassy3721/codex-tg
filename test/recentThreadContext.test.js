import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tg-recent-context-test-'))
process.env.DB_PATH = path.join(directory, 'sessions.db')

const {
  addConversationMessage,
  assignConversationMessageTurn,
  clearThreadCarryover,
  getSession,
  getThreadCarryover,
  listCurrentThreadTail,
  recordTurn,
  resetThread,
  saveThreadCarryover,
  sessionKey,
  setWorkspace,
} = await import('../src/db.js')

test('captures ten complete user turns and keeps carryover across reset only', async (t) => {
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const key = sessionKey(9001, null)
  getSession(key, '/tmp/project-a')
  recordTurn(key, 'thread-a')

  let sentAt = 1_000
  for (let index = 1; index <= 12; index += 1) {
    addConversationMessage({
      sourceId: `user:${index}`,
      sessionKey: key,
      role: 'user',
      content: `user-${index}`,
      sentAt: sentAt++,
    })
    addConversationMessage({
      sourceId: `assistant:${index}`,
      sessionKey: key,
      role: 'assistant',
      content: `assistant-${index}`,
      sentAt: sentAt++,
    })
  }
  addConversationMessage({
    sourceId: 'assistant:12:extra',
    sessionKey: key,
    role: 'assistant',
    content: 'assistant-12-extra',
    sentAt: sentAt++,
  })

  const tail = listCurrentThreadTail(key, 10)
  assert.equal(tail.filter(({ role }) => role === 'user').length, 10)
  assert.equal(tail[0].content, 'user-3')
  assert.equal(tail.at(-1).content, 'assistant-12-extra')

  saveThreadCarryover(key, 'thread-a', 'rendered recent context')
  resetThread(key)
  assert.equal(getThreadCarryover(key).content, 'rendered recent context')
  assert.equal(clearThreadCarryover(key), true)
  assert.equal(getThreadCarryover(key), null)

  saveThreadCarryover(key, 'thread-a', 'must not cross workspaces')
  setWorkspace(key, '/tmp/project-b')
  assert.equal(getThreadCarryover(key), null)
})

test('counts steering messages with a shared conversation turn only once', () => {
  const key = sessionKey(9002, null)
  getSession(key, '/tmp/project-a')
  recordTurn(key, 'thread-b')

  let sentAt = 2_000
  for (let index = 1; index <= 11; index += 1) {
    addConversationMessage({
      sourceId: `grouped-user:${index}`,
      sessionKey: key,
      conversationTurnId: `turn-${index}`,
      role: 'user',
      content: `user-${index}`,
      sentAt: sentAt++,
    })
    if (index === 2) {
      addConversationMessage({
        sourceId: 'grouped-user:2:steer',
        sessionKey: key,
        role: 'user',
        content: 'user-2-steer',
        sentAt: sentAt++,
      })
      assert.equal(
        assignConversationMessageTurn('grouped-user:2:steer', 'turn-2'),
        true
      )
    }
    addConversationMessage({
      sourceId: `grouped-assistant:${index}`,
      sessionKey: key,
      conversationTurnId: `turn-${index}`,
      role: 'assistant',
      content: `assistant-${index}`,
      sentAt: sentAt++,
    })
  }

  const tail = listCurrentThreadTail(key, 10)
  assert.equal(tail[0].content, 'user-2')
  assert.equal(tail[1].content, 'user-2-steer')
  assert.equal(tail.filter(({ role }) => role === 'user').length, 11)
})
