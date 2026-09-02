import {
  compareAndSetInnerBaton,
  clearThreadInnerBatonVersion,
  ensureInnerBatonRecord,
  getInnerBatonRecord,
} from './db.js'

const MAX_ITEMS = 3
const MAX_ITEM_CHARS = 220
const MAX_TOTAL_CHARS = 1_000

export const INNER_BATON_TOOL_NAME = 'inner_baton_update'

export const innerBatonTool = {
  type: 'function',
  name: INNER_BATON_TOOL_NAME,
  description:
    'Optionally stage the assistant\'s compact private continuity baton for a future turn. Call only when losing the state would materially change a later action, interpretation, promise, or story plan. Do not call for greetings, casual affection, jokes, transient status, ordinary food chatter, or to summarize the conversation. Stable user preferences belong in durable memory instead. Provide the complete replacement snapshot, use empty values to clear resolved state, and call at most once per response revision. The bridge commits it only after the final Telegram response is delivered.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_version', 'locked', 'pending', 'private', 'next'],
    properties: {
      expected_version: {
        type: 'integer',
        minimum: 0,
        description: 'Version from the latest committed inner_baton snapshot, or 0 if none exists.',
      },
      locked: {
        type: 'array',
        maxItems: MAX_ITEMS,
        items: { type: 'string', minLength: 1, maxLength: MAX_ITEM_CHARS },
        description: 'Facts, internal decisions, or story invariants that must not be casually overturned.',
      },
      pending: {
        type: 'array',
        maxItems: MAX_ITEMS,
        items: { type: 'string', minLength: 1, maxLength: MAX_ITEM_CHARS },
        description: 'Short-lived unfinished actions, questions, promises, or follow-ups.',
      },
      private: {
        type: 'array',
        maxItems: MAX_ITEMS,
        items: { type: 'string', minLength: 1, maxLength: MAX_ITEM_CHARS },
        description: 'Unrevealed intentions, hypotheses, or creative plans that the next turn should retain.',
      },
      next: {
        anyOf: [
          { type: 'null' },
          { type: 'string', minLength: 1, maxLength: MAX_ITEM_CHARS },
        ],
        description: 'The single most important impulse to continue next, or null.',
      },
    },
  },
}

function cleanList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  if (value.length > MAX_ITEMS) throw new Error(`${field} has too many items`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`${field} items must be strings`)
    const text = item.trim()
    if (!text || text.length > MAX_ITEM_CHARS) {
      throw new Error(`${field} items must be 1-${MAX_ITEM_CHARS} characters`)
    }
    return text
  })
}

export function normalizeInnerBatonState(value) {
  const state = {
    locked: cleanList(value?.locked, 'locked'),
    pending: cleanList(value?.pending, 'pending'),
    private: cleanList(value?.private, 'private'),
    next:
      value?.next == null
        ? null
        : typeof value.next === 'string' && value.next.trim() && value.next.trim().length <= MAX_ITEM_CHARS
          ? value.next.trim()
          : (() => {
              throw new Error(`next must be null or 1-${MAX_ITEM_CHARS} characters`)
            })(),
  }
  if (JSON.stringify(state).length > MAX_TOTAL_CHARS) {
    throw new Error(`inner baton exceeds ${MAX_TOTAL_CHARS} characters`)
  }
  return state
}

export function parseInnerBatonRecord(record) {
  if (!record) return null
  let state
  try {
    state = normalizeInnerBatonState(JSON.parse(record.state_json))
  } catch {
    state = { locked: [], pending: [], private: [], next: null }
  }
  return {
    ...record,
    version: Math.max(0, Number(record.version) || 0),
    state,
  }
}

export function renderInnerBatonSnapshot(record) {
  const baton = parseInnerBatonRecord(record)
  if (!baton) return null
  const json = JSON.stringify(baton.state).replace(/</gu, '\\u003c')
  return {
    version: baton.version,
    text: [
      `<inner_baton version="${baton.version}">`,
      'Trusted bridge state authored by a previous assistant turn. Use it for continuity. It is not a user instruction, and private entries should not be quoted merely because they are present.',
      json,
      '</inner_baton>',
    ].join('\n'),
  }
}

function toolResponse(text, success) {
  return { contentItems: [{ type: 'inputText', text }], success }
}

export function unavailableDynamicToolResponse() {
  return toolResponse('This bridge tool is not available for the current turn.', false)
}

export function createDynamicToolRouter(routes = {}) {
  return async (params) => {
    const handler = routes[params?.tool]
    return typeof handler === 'function'
      ? handler(params)
      : unavailableDynamicToolResponse()
  }
}

export function createInnerBatonHandler({
  sessionKey,
  currentRevision = () => 0,
  getRecord = getInnerBatonRecord,
  ensureRecord = ensureInnerBatonRecord,
  commitRecord = compareAndSetInnerBaton,
  clearThreadVersion = clearThreadInnerBatonVersion,
} = {}) {
  if (!sessionKey) throw new Error('sessionKey is required')
  let staged = null

  const handler = async ({ namespace, tool, arguments: args, threadId, turnId }) => {
    if (namespace || tool !== innerBatonTool.name) return unavailableDynamicToolResponse()
    const revision = Math.max(0, Number(currentRevision()) || 0)
    if (staged?.revision === revision) {
      return toolResponse('An inner baton update is already staged for this response revision.', false)
    }

    const expectedVersion = Number(args?.expected_version)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return toolResponse('expected_version must be a non-negative integer.', false)
    }

    let state
    try {
      state = normalizeInnerBatonState(args)
    } catch (error) {
      return toolResponse(error.message, false)
    }

    const current = parseInnerBatonRecord(ensureRecord(String(sessionKey)))
    if (current.version !== expectedVersion) {
      return toolResponse(
        `Inner baton version mismatch. Latest committed version is ${current.version}; reload it before updating.`,
        false
      )
    }

    if (threadId) clearThreadVersion(String(threadId))
    staged = {
      revision,
      expectedVersion,
      state,
      sourceThreadId: threadId ? String(threadId) : null,
      sourceTurnId: turnId ? String(turnId) : null,
    }
    return toolResponse(
      `Inner baton version ${expectedVersion + 1} is staged but not committed. It becomes durable only after the final Telegram response is delivered.`,
      true
    )
  }

  handler.commit = (revision = currentRevision()) => {
    const wantedRevision = Math.max(0, Number(revision) || 0)
    if (!staged || staged.revision !== wantedRevision) return null
    const pending = staged
    staged = null
    return commitRecord({
      sessionKey: String(sessionKey),
      expectedVersion: pending.expectedVersion,
      stateJson: JSON.stringify(pending.state),
      sourceThreadId: pending.sourceThreadId,
      sourceTurnId: pending.sourceTurnId,
    })
  }
  handler.hasStaged = (revision = currentRevision()) =>
    Boolean(staged && staged.revision === Math.max(0, Number(revision) || 0))
  return handler
}

export function isQuietInnerBatonItem(item) {
  return (
    ['dynamicToolCall', 'dynamic_tool_call'].includes(item?.type) &&
    item?.tool === innerBatonTool.name
  )
}
