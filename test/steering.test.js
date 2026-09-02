import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completePhaseResponse,
  createPhaseResponseRouter,
  createResponseAccumulator,
  createTurnControl,
  resolveTurnMessages,
  telegramClientUserMessageId,
  visibleText,
} from '../src/steering.js'

test('turn control holds steering until the backend generator is bound', async () => {
  const control = createTurnControl()
  const requests = []
  const pending = control.steer({ prompt: 'new information' })

  control.setGenerator({
    steer: async (request) => {
      requests.push(request)
      return { turnId: 'turn-1' }
    },
    kill() {},
  })

  assert.deepEqual(await pending, { turnId: 'turn-1' })
  assert.deepEqual(requests, [{ prompt: 'new information' }])
})

test('turn control releases waiting steering when cancelled before binding', async () => {
  const control = createTurnControl()
  const pending = control.steer({ prompt: 'too late' })
  control.kill()
  await assert.rejects(pending, /ended before steering/)
})

test('turn control kills a generator bound after cancellation', () => {
  const control = createTurnControl()
  let killed = 0

  control.kill()
  control.setGenerator({
    kill() { killed += 1 },
  })

  assert.equal(killed, 1)
})

test('turn control releases waiting steering when a turn ends before binding', async () => {
  const control = createTurnControl()
  const pending = control.steer({ prompt: 'too late' })
  control.end()
  await assert.rejects(pending, /ended before steering/)
})

test('response revisions invalidate earlier candidates and can supersede a turn', () => {
  const control = createTurnControl()
  const responses = createResponseAccumulator()
  responses.add('first answer', control.responseRevision)
  control.bumpResponseRevision()
  responses.add('revised answer', control.responseRevision)

  assert.equal(responses.textFor(0), 'first answer')
  assert.equal(responses.textFor(1), 'revised answer')
  assert.equal(control.responseSuperseded, false)
  control.supersedeResponse()
  assert.equal(control.responseSuperseded, true)
})

test('response accumulator keeps only the final message from the selected revision', () => {
  const responses = createResponseAccumulator()
  responses.add('checking', 0)
  responses.add('stale result', 0)
  responses.add('updated result', 1)
  assert.equal(responses.textFor(0), 'stale result')
  assert.equal(responses.textFor(1), 'updated result')
})

test('zero-width-only output stays empty while emoji joiners are preserved', () => {
  const responses = createResponseAccumulator()
  responses.add('\u200b', 0)
  responses.add('\u200d', 0)
  assert.equal(responses.textFor(0), '')
  assert.equal(visibleText('\u200b\uFEFF'), '')
  assert.equal(visibleText('a\u200bb'), 'ab')
  assert.equal(visibleText('🐈\u200d⬛'), '🐈\u200d⬛')
})

test('commentary -> tool -> commentary -> final sends bubbles before the final answer', async () => {
  const responses = createPhaseResponseRouter()
  const events = []
  const complete = (item) => completePhaseResponse({
    responses,
    item,
    currentRevision: 0,
    dropStatus: async () => events.push('status:drop'),
    sayCommentary: async (text) => {
      events.push(`bubble:${text}`)
      return { message_id: events.length }
    },
  })

  const first = { id: 'c1', type: 'agent_message', phase: 'commentary', text: '先看一下。' }
  responses.start(first, 0)
  await complete(first)

  // A tool starting after commentary creates a fresh status row beneath it.
  events.push('status:tool')

  const second = { id: 'c2', type: 'agent_message', phase: 'commentary', text: '找到原因了。' }
  responses.start(second, 0)
  await complete(second)

  const final = { id: 'f1', type: 'agent_message', phase: 'final_answer', text: '已经修好。' }
  responses.start(final, 0)
  assert.equal((await complete(final)).kind, 'final')

  assert.deepEqual(events, [
    'status:drop',
    'bubble:先看一下。',
    'status:tool',
    'status:drop',
    'bubble:找到原因了。',
  ])
  assert.equal(responses.finalTextFor(0), '已经修好。')
})

test('two user messages merge into only the revised final answer', () => {
  const responses = createPhaseResponseRouter()
  const control = createTurnControl()
  const first = { id: 'f1', type: 'agent_message', text: '第一版答案' }
  responses.start(first, control.responseRevision)

  control.bumpResponseRevision()
  responses.complete(first, control.responseRevision)
  const revised = { id: 'f2', type: 'agent_message', phase: 'final_answer', text: '合并后的答案' }
  responses.start(revised, control.responseRevision)
  responses.complete(revised, control.responseRevision)

  assert.equal(responses.finalTextFor(control.responseRevision), '合并后的答案')
})

test('commentary is discarded if steering supersedes its started revision', async () => {
  const responses = createPhaseResponseRouter()
  const commentary = {
    id: 'c1',
    type: 'agent_message',
    phase: 'commentary',
    text: '这条不该发出',
  }
  responses.start(commentary, 0)

  let sent = false
  const result = await completePhaseResponse({
    responses,
    item: commentary,
    currentRevision: 1,
    dropStatus: async () => {},
    sayCommentary: async () => { sent = true },
  })

  assert.equal(result.kind, 'superseded')
  assert.equal(sent, false)
})

test('commentary rechecks its revision after dropping the status row', async () => {
  const responses = createPhaseResponseRouter()
  const commentary = {
    id: 'c1',
    type: 'agent_message',
    phase: 'commentary',
    text: '也不该发出',
  }
  responses.start(commentary, 0)

  let revision = 0
  let sent = false
  const result = await completePhaseResponse({
    responses,
    item: commentary,
    currentRevision: () => revision,
    dropStatus: async () => { revision = 1 },
    sayCommentary: async () => { sent = true },
  })

  assert.equal(result.kind, 'superseded')
  assert.equal(sent, false)
})

test('queued text context never becomes an attachment list', () => {
  const current = { message_id: 12, text: 'second thought' }
  const earlier = { message_id: 11, text: 'first thought' }
  const resolved = resolveTurnMessages(current, [], [earlier, current])

  assert.deepEqual(resolved.attachments, [])
  assert.deepEqual(resolved.context, [earlier, current])
})

test('real attachment messages remain both downloadable and contextual', () => {
  const document = { message_id: 13, document: { file_id: 'file' } }
  const resolved = resolveTurnMessages(document, [document], [])

  assert.deepEqual(resolved.attachments, [document])
  assert.deepEqual(resolved.context, [document])
})

test('Telegram client message ids are stable and scoped to the chat', () => {
  assert.equal(
    telegramClientUserMessageId({
      chat: { id: 123 },
      message: { message_id: 456 },
    }),
    'telegram:123:456'
  )
})
