import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveActiveThreadId } from '../src/threadRouting.js'

test('resolveActiveThreadId prefers the skill worker over the parent session', () => {
  assert.equal(
    resolveActiveThreadId(
      { thread_id: 'parent-thread' },
      { worker_thread_id: 'worker-thread' }
    ),
    'worker-thread'
  )
})

test('resolveActiveThreadId falls back to the parent and then null', () => {
  assert.equal(resolveActiveThreadId({ thread_id: 'parent-thread' }), 'parent-thread')
  assert.equal(resolveActiveThreadId({ thread_id: '' }), null)
})
