export const DEFAULT_TELEGRAM_REACTION_EMOJIS = Object.freeze([
  '👀',
  '🎉',
  '🥰',
  '❤️‍🔥',
])

export function normalizeTelegramReactionEmojis(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',')
  const emojis = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))]
  return emojis.length ? emojis.slice(0, 16) : [...DEFAULT_TELEGRAM_REACTION_EMOJIS]
}

export function createTelegramReactionTool(allowedEmojis = DEFAULT_TELEGRAM_REACTION_EMOJIS) {
  const emojis = normalizeTelegramReactionEmojis(allowedEmojis)
  return {
    type: 'function',
    name: 'telegram_react',
    description:
      'Optionally add one emoji reaction to the current user message in Telegram. Use this sparingly when a reaction adds natural emotional texture; do not react to every message, do not use it instead of a needed written reply, and avoid it when the tone is serious or ambiguous. The bridge chooses the message target. Call at most once per turn.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['emoji'],
      properties: {
        emoji: {
          type: 'string',
          enum: emojis,
          description: 'The single standard Telegram emoji reaction to add.',
        },
      },
    },
  }
}

function toolResponse(text, success) {
  return {
    contentItems: [{ type: 'inputText', text }],
    success,
  }
}

export function createTelegramReactionHandler({
  telegram,
  chatId,
  messageId,
  allowedEmojis = DEFAULT_TELEGRAM_REACTION_EMOJIS,
  logger = console,
}) {
  const emojis = normalizeTelegramReactionEmojis(allowedEmojis)
  let attempted = false
  const state = { attempted: false, succeeded: false }

  const handler = async ({ namespace, tool, arguments: args }) => {
    if (namespace || tool !== 'telegram_react') {
      return toolResponse('This bridge tool is not available.', false)
    }
    if (attempted) {
      return toolResponse('A Telegram reaction has already been attempted for this turn.', false)
    }

    const emoji = args?.emoji
    if (!emojis.includes(emoji)) {
      return toolResponse('That Telegram reaction is not allowed by this bridge.', false)
    }

    // Count attempts, not only successes. Otherwise a model could loop on an
    // unsupported reaction and turn a cosmetic failure into Telegram API spam.
    attempted = true
    state.attempted = true
    try {
      await telegram.setMessageReaction(
        chatId,
        messageId,
        [{ type: 'emoji', emoji }],
        false
      )
      state.succeeded = true
      return toolResponse(`Added ${emoji} to the current user message.`, true)
    } catch (error) {
      logger.warn?.('[reaction] Telegram rejected reaction:', error.message)
      return toolResponse(
        'Telegram could not add that reaction. Continue the reply normally and do not retry.',
        false
      )
    }
  }
  handler.state = state
  return handler
}
