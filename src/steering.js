/**
 * Turn control shared by Telegram handlers. Steering may arrive while the
 * bridge is still preparing attachments/profile context, so it waits until the
 * backend generator is bound instead of dropping the message.
 */
export function createTurnControl({ steerable = true } = {}) {
  const abortController = new AbortController()
  let generatorReadyResolve
  const generatorReady = new Promise((resolve) => {
    generatorReadyResolve = resolve
  })

  return {
    abortController,
    generator: null,
    cancelled: false,
    ended: false,
    steerable,
    responseRevision: 0,
    responseSuperseded: false,
    conversationTurnId: null,
    bumpResponseRevision() {
      this.responseRevision += 1
      return this.responseRevision
    },
    supersedeResponse() {
      this.responseSuperseded = true
    },
    setGenerator(generator) {
      this.generator = generator
      generatorReadyResolve()
      // Cancellation can arrive while the bridge is still preparing a turn
      // (for example while the skill router is starting).  Do not let a
      // generator that is bound afterwards escape that cancellation.
      if (this.cancelled || this.ended) this.generator?.kill?.()
    },
    async steer(request) {
      if (!this.steerable) throw new Error('The configured backend does not support steering')
      await generatorReady
      if (this.cancelled || this.ended || typeof this.generator?.steer !== 'function') {
        throw new Error('The active turn ended before steering could be submitted')
      }
      return this.generator.steer(request)
    },
    end() {
      this.ended = true
      generatorReadyResolve()
    },
    kill() {
      this.cancelled = true
      abortController.abort()
      generatorReadyResolve()
      this.generator?.kill()
    },
  }
}

export function createResponseAccumulator() {
  const messages = []
  return {
    add(text, revision) {
      const value = visibleText(text)
      if (value) messages.push({ text: value, revision: Number(revision) || 0 })
    },
    textFor(revision) {
      return messages.findLast((message) => message.revision === revision)?.text || ''
    },
  }
}

export function visibleText(text) {
  const value = String(text || '')
    .replace(/[\u200B\uFEFF]/gu, '')
    .trim()
  return value.replace(/[\u200C\u200D]/gu, '').trim() ? value : ''
}

/**
 * Keep conversational commentary separate from the revision-aware final answer.
 * The revision is captured when an item starts because steering can arrive while
 * that item is still streaming.
 */
export function createPhaseResponseRouter() {
  const finalResponses = createResponseAccumulator()
  const startedRevisions = new Map()

  return {
    start(item, revision) {
      if (item?.type === 'agent_message' && item.id) {
        startedRevisions.set(item.id, Number(revision) || 0)
      }
    },
    complete(item, currentRevision) {
      const activeRevision = Number(currentRevision) || 0
      const revision = item?.id && startedRevisions.has(item.id)
        ? startedRevisions.get(item.id)
        : activeRevision
      if (item?.id) startedRevisions.delete(item.id)

      const text = visibleText(item?.text)
      if (!text) return { kind: 'empty', text: '', revision }

      if (item?.phase === 'commentary') {
        return revision === activeRevision
          ? { kind: 'commentary', text, revision }
          : { kind: 'superseded', text, revision }
      }

      // final_answer and legacy messages without a phase both retain the
      // existing "last answer for the selected revision" behavior.
      finalResponses.add(text, revision)
      return { kind: 'final', text, revision }
    },
    finalTextFor(revision) {
      return finalResponses.textFor(revision)
    },
  }
}

export async function completePhaseResponse({
  responses,
  item,
  currentRevision,
  responseSuperseded = false,
  dropStatus,
  sayCommentary,
}) {
  const readRevision = () => Number(
    typeof currentRevision === 'function' ? currentRevision() : currentRevision
  ) || 0
  const isSuperseded = () => Boolean(
    typeof responseSuperseded === 'function' ? responseSuperseded() : responseSuperseded
  )
  const result = responses.complete(item, readRevision())
  if (result.kind !== 'commentary') return result
  if (isSuperseded()) return { ...result, kind: 'superseded' }

  await dropStatus()
  if (result.revision !== readRevision() || isSuperseded()) {
    return { ...result, kind: 'superseded' }
  }
  const sent = await sayCommentary(result.text)
  return { ...result, sent }
}

export function resolveTurnMessages(
  currentMessage,
  attachmentMessages = [],
  contextMessages = []
) {
  const attachments = Array.isArray(attachmentMessages) ? attachmentMessages : []
  const context = Array.isArray(contextMessages) && contextMessages.length
    ? contextMessages
    : attachments.length
      ? attachments
      : [currentMessage].filter(Boolean)
  return { attachments, context }
}

export function telegramClientUserMessageId(ctx) {
  const chatId = ctx?.chat?.id
  const messageId = ctx?.message?.message_id
  if (chatId == null || messageId == null) return null
  return `telegram:${chatId}:${messageId}`
}
