import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTelegramReactionHandler,
  TELEGRAM_REACTION_EMOJIS,
  telegramReactionTool,
} from '../src/telegramReaction.js'

test('Telegram reaction tool exposes exactly the configured reaction set', () => {
  const expected = ['👀', '👾', '🎉', '🥰', '🗿', '🌭', '❤️‍🔥']
  assert.deepEqual(TELEGRAM_REACTION_EMOJIS, expected)
  assert.deepEqual(telegramReactionTool.inputSchema.properties.emoji.enum, expected)
})

test('Telegram reaction tool targets the bridge-bound message', async () => {
  const calls = []
  const handler = createTelegramReactionHandler({
    telegram: {
      setMessageReaction: async (...args) => {
        calls.push(args)
        return true
      },
    },
    chatId: 123,
    messageId: 456,
  })

  const result = await handler({
    namespace: null,
    tool: telegramReactionTool.name,
    arguments: { emoji: '❤️‍🔥' },
  })

  assert.equal(result.success, true)
  assert.deepEqual(handler.state, { attempted: true, succeeded: true })
  assert.deepEqual(calls, [[123, 456, [{ type: 'emoji', emoji: '❤️‍🔥' }], false]])
})

test('Telegram reaction tool rejects invalid and repeated reactions', async () => {
  let calls = 0
  const handler = createTelegramReactionHandler({
    telegram: {
      setMessageReaction: async () => {
        calls += 1
        return true
      },
    },
    chatId: 1,
    messageId: 2,
  })

  const invalid = await handler({
    namespace: null,
    tool: telegramReactionTool.name,
    arguments: { emoji: '👍' },
  })
  assert.equal(invalid.success, false)
  assert.equal(calls, 0)

  const first = await handler({
    namespace: null,
    tool: telegramReactionTool.name,
    arguments: { emoji: '🗿' },
  })
  const repeated = await handler({
    namespace: null,
    tool: telegramReactionTool.name,
    arguments: { emoji: '🌭' },
  })

  assert.equal(first.success, true)
  assert.equal(repeated.success, false)
  assert.equal(calls, 1)
  assert.deepEqual(handler.state, { attempted: true, succeeded: true })
})
