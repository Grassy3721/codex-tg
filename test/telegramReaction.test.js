import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTelegramReactionHandler,
  createTelegramReactionTool,
  DEFAULT_TELEGRAM_REACTION_EMOJIS,
  normalizeTelegramReactionEmojis,
} from '../src/telegramReaction.js'

test('Telegram reaction tool exposes a conservative default set', () => {
  const expected = ['👀', '🎉', '🥰', '❤️‍🔥']
  const telegramReactionTool = createTelegramReactionTool()
  assert.deepEqual(DEFAULT_TELEGRAM_REACTION_EMOJIS, expected)
  assert.deepEqual(telegramReactionTool.inputSchema.properties.emoji.enum, expected)
})

test('Telegram reaction set is configurable, trimmed, and deduplicated', () => {
  const configured = normalizeTelegramReactionEmojis('👍, 🤔,👏,👏')
  const telegramReactionTool = createTelegramReactionTool(configured)
  assert.deepEqual(configured, ['👍', '🤔', '👏'])
  assert.deepEqual(telegramReactionTool.inputSchema.properties.emoji.enum, configured)
})

test('Telegram reaction tool targets the bridge-bound message', async () => {
  const telegramReactionTool = createTelegramReactionTool()
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
  const telegramReactionTool = createTelegramReactionTool()
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
    arguments: { emoji: '🎉' },
  })
  const repeated = await handler({
    namespace: null,
    tool: telegramReactionTool.name,
    arguments: { emoji: '👀' },
  })

  assert.equal(first.success, true)
  assert.equal(repeated.success, false)
  assert.equal(calls, 1)
  assert.deepEqual(handler.state, { attempted: true, succeeded: true })
})
