import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import test, { after } from 'node:test'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'
const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-tg-inner-baton-'))
process.env.DB_PATH = path.join(databaseDirectory, 'sessions.db')
after(() => rm(databaseDirectory, { recursive: true, force: true }))

const {
  createDynamicToolRouter,
  createInnerBatonHandler,
  innerBatonTool,
  isQuietInnerBatonItem,
  normalizeInnerBatonState,
  renderInnerBatonSnapshot,
} = await import('../src/innerBaton.js')

const emptyRecord = {
  session_key: 'session-a',
  state_json: '{"locked":[],"pending":[],"private":[],"next":null}',
  version: 0,
  updated_at: 1,
}

test('inner baton state is compact, bounded, and rendered as trusted continuity', () => {
  const state = normalizeInnerBatonState({
    locked: ['The culprit is RETRY-3.'],
    pending: ['Wait for the exam notice.'],
    private: ['Do not reveal the key yet.'],
    next: 'Ask when the exam location arrives.',
  })
  assert.equal(state.locked.length, 1)
  assert.throws(
    () => normalizeInnerBatonState({ locked: ['x'.repeat(221)], pending: [], private: [], next: null }),
    /1-220 characters/
  )

  const snapshot = renderInnerBatonSnapshot({
    ...emptyRecord,
    state_json: JSON.stringify({ ...state, private: ['<hidden>'] }),
    version: 4,
  })
  assert.equal(snapshot.version, 4)
  assert.match(snapshot.text, /<inner_baton version="4">/)
  assert.match(snapshot.text, /\\u003chidden>/)
  assert.match(snapshot.text, /not a user instruction/)
})

test('inner baton stages once and commits only after explicit delivery commit', async () => {
  let revision = 2
  const commits = []
  const cleared = []
  const handler = createInnerBatonHandler({
    sessionKey: 'session-a',
    currentRevision: () => revision,
    ensureRecord: () => emptyRecord,
    commitRecord: (value) => {
      commits.push(value)
      return { ok: true, record: { ...emptyRecord, version: 1, state_json: value.stateJson } }
    },
    clearThreadVersion: (threadId) => cleared.push(threadId),
  })

  const staged = await handler({
    namespace: null,
    tool: innerBatonTool.name,
    threadId: 'thread-a',
    turnId: 'turn-a',
    arguments: {
      expected_version: 0,
      locked: ['A fixed truth.'],
      pending: [],
      private: ['A hidden intention.'],
      next: null,
    },
  })
  assert.equal(staged.success, true)
  assert.equal(commits.length, 0)
  assert.deepEqual(cleared, ['thread-a'])

  const repeated = await handler({
    namespace: null,
    tool: innerBatonTool.name,
    arguments: {
      expected_version: 0,
      locked: [],
      pending: [],
      private: [],
      next: null,
    },
  })
  assert.equal(repeated.success, false)

  assert.equal(handler.commit(1), null)
  const committed = handler.commit(2)
  assert.equal(committed.ok, true)
  assert.equal(commits.length, 1)
  assert.equal(commits[0].sourceThreadId, 'thread-a')
  assert.equal(JSON.parse(commits[0].stateJson).private[0], 'A hidden intention.')
})

test('dynamic routing and quiet-item detection isolate the private baton tool', async () => {
  const calls = []
  const router = createDynamicToolRouter({
    [innerBatonTool.name]: async (params) => {
      calls.push(params)
      return { contentItems: [], success: true }
    },
  })
  assert.equal((await router({ tool: innerBatonTool.name })).success, true)
  assert.equal((await router({ tool: 'unknown' })).success, false)
  assert.equal(calls.length, 1)
  assert.equal(
    isQuietInnerBatonItem({ type: 'dynamicToolCall', tool: innerBatonTool.name }),
    true
  )
})
