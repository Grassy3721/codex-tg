import assert from 'node:assert/strict'
import test from 'node:test'

import {
  paginateThreads,
  threadPageKeyboard,
} from '../src/threadPagination.js'

test('thread history is paginated in stable groups of five', () => {
  const threads = Array.from({ length: 12 }, (_, index) => `thread-${index + 1}`)
  const first = paginateThreads(threads, 1)
  const second = paginateThreads(threads, 2)
  const last = paginateThreads(threads, 99)

  assert.deepEqual(first.items, threads.slice(0, 5))
  assert.deepEqual(second.items, threads.slice(5, 10))
  assert.deepEqual(last.items, threads.slice(10))
  assert.equal(second.startIndex, 5)
  assert.equal(last.page, 3)
  assert.equal(last.totalPages, 3)
})

test('thread pagination buttons expose only reachable neighbours', () => {
  assert.deepEqual(threadPageKeyboard(1, 3), {
    inline_keyboard: [[{ text: '下一页 ›', callback_data: 'threads:2' }]],
  })
  assert.deepEqual(threadPageKeyboard(2, 3), {
    inline_keyboard: [[
      { text: '‹ 上一页', callback_data: 'threads:1' },
      { text: '下一页 ›', callback_data: 'threads:3' },
    ]],
  })
  assert.deepEqual(threadPageKeyboard(3, 3), {
    inline_keyboard: [[{ text: '‹ 上一页', callback_data: 'threads:2' }]],
  })
  assert.equal(threadPageKeyboard(1, 1), undefined)
})
