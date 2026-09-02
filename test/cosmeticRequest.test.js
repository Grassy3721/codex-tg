import assert from 'node:assert/strict'
import test from 'node:test'
import { settleCosmeticRequest } from '../src/cosmeticRequest.js'

test('a stalled cosmetic request stops blocking after its deadline', async () => {
  const started = Date.now()
  const result = await settleCosmeticRequest(new Promise(() => {}), { timeoutMs: 10 })
  assert.equal(result, null)
  assert.ok(Date.now() - started < 250)
})

test('late cosmetic replies can be cleaned up after the caller continues', async () => {
  let resolveRequest
  const request = new Promise((resolve) => { resolveRequest = resolve })
  const late = []
  assert.equal(
    await settleCosmeticRequest(request, {
      timeoutMs: 10,
      onLate: (value) => late.push(value.message_id),
    }),
    null
  )
  resolveRequest({ message_id: 42 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(late, [42])
})
