import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'

const { compactThread } = await import('../src/backends/codexCompact.js')

test('compact waits for the app-server completion notification', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fakeAppServer.sh', import.meta.url))
  const operation = compactThread({
    threadId: 'thread-for-compact-test',
    workspace: process.cwd(),
    sandbox: 'workspace-write',
    model: 'test-model',
    effort: 'high',
    codexBin: 'bash',
    appServerArgs: [fixture],
  })

  const result = await operation.promise
  assert.deepEqual(result, {
    threadId: 'thread-for-compact-test',
    turnId: 'compact-turn',
  })
})
