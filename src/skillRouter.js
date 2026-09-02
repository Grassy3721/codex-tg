/**
 * The routable skill list is supplied by the caller (see skillCatalog.js), so
 * this module never hard-codes anyone's private skill names.  Every function
 * degrades to "no automatic routing" when the catalog is empty.
 */

export function localSkillRoute(text, episode = null) {
  const value = String(text || '').trim()
  if (!value) {
    return episode
      ? { action: 'continue', skill: episode.skill_name, source: 'empty' }
      : { action: 'main', skill: null, source: 'empty' }
  }

  // Never treat a character name, emotional phrase, or intimate word as an
  // instruction to fork the conversation. Automatic episodes are selected by
  // semantic intent; explicit $skill invocations are parsed before this path.
  return {
    action: 'classify',
    skill: null,
    source: episode ? 'semantic-episode' : 'semantic-fallback',
  }
}

export function skillRouterPrompt({ text, episode = null, recentMessages = [], skills = [] }) {
  // Only the user's own earlier messages are shown.  Assistant replies were
  // previously included and dominated the window: three long in-character
  // replies left the router reading the mood of a finished scene instead of
  // what the user is asking for now.
  const history = recentMessages
    .filter((message) => message?.role !== 'assistant')
    .slice(-10)
    .map((message) => `- ${String(message.content || '').slice(0, 800)}`)
    .join('\n')
  return [
    'Classify one Telegram message for a conversation router. Do not answer the message.',
    'Choose conservatively. When no skill episode is active, uncertain means "main".',
    'When an episode is active, uncertain means "continue"; end it only for a clear topic change.',
    'Route by the behavior the user is requesting, never by isolated keywords.',
    'A character name, emotional phrase, intimate word, or casual reference alone is not enough to start or switch a skill.',
    'Start a skill only when the current message clearly asks for that skill behavior in context.',
    'When an episode is active, end it for a clear move to another task or domain, including a link to inspect, code, health data, logistics, or unrelated conversation, even when the transition is phrased casually.',
    'Skills whose purposes sound adjacent are still separate; never substitute one for another.',
    'Earlier user messages are provided only to resolve fragments, pronouns, and references in the current message. Never route on the mood or subject matter of earlier messages by themselves.',
    `Active episode: ${episode?.skill_name || 'none'}`,
    `Skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.purpose}`).join('\n')}`,
    history
      ? `Earlier messages from the user, oldest first (assistant replies deliberately omitted):\n${history}`
      : 'Earlier messages from the user: none',
    `Current message:\n<message>${String(text || '').slice(0, 3000)}</message>`,
    'Return only the requested JSON classification.',
  ].join('\n\n')
}

export function skillRouterSchema(skills = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'skill', 'confidence'],
    properties: {
      action: { type: 'string', enum: ['main', 'start', 'continue', 'end', 'switch'] },
      skill: {
        anyOf: [
          { type: 'null' },
          { type: 'string', enum: skills.map((skill) => skill.name) },
        ],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  }
}

export function parseSkillRouterDecision(value, episode = null, skills = []) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  const allowedSkills = new Set(skills.map((skill) => skill.name))
  if (!['main', 'start', 'continue', 'end', 'switch'].includes(parsed?.action)) {
    throw new Error('Invalid skill-router action')
  }
  if (parsed.skill !== null && !allowedSkills.has(parsed.skill)) {
    throw new Error('Invalid skill-router skill')
  }
  const confidence = Number(parsed.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Invalid skill-router confidence')
  }

  if (confidence < 0.72) {
    return episode
      ? { action: 'continue', skill: episode.skill_name, confidence, source: 'router-low' }
      : { action: 'main', skill: null, confidence, source: 'router-low' }
  }
  if (!episode) {
    if (parsed.action !== 'start' || !parsed.skill) {
      return { action: 'main', skill: null, confidence, source: 'router' }
    }
    return { action: 'start', skill: parsed.skill, confidence, source: 'router' }
  }
  if (parsed.action === 'start' || parsed.action === 'switch') {
    return parsed.skill && parsed.skill !== episode.skill_name
      ? { action: 'switch', skill: parsed.skill, confidence, source: 'router' }
      : { action: 'continue', skill: episode.skill_name, confidence, source: 'router' }
  }
  if (parsed.action === 'main' || parsed.action === 'end') {
    return { action: 'end', skill: null, confidence, source: 'router' }
  }
  return { action: 'continue', skill: episode.skill_name, confidence, source: 'router' }
}

export async function decideSkillRoute({
  text,
  episode = null,
  recentMessages = [],
  skills = [],
  classify,
}) {
  const local = localSkillRoute(text, episode)
  if (local.action !== 'classify' || typeof classify !== 'function' || !skills.length) {
    return local.action === 'classify'
      ? episode
        ? { action: 'continue', skill: episode.skill_name, source: 'no-catalog' }
        : { action: 'main', skill: null, source: 'no-catalog' }
      : local
  }
  try {
    const raw = await classify(skillRouterPrompt({ text, episode, recentMessages, skills }))
    return parseSkillRouterDecision(raw, episode, skills)
  } catch {
    return episode
      ? { action: 'continue', skill: episode.skill_name, source: 'router-fallback' }
      : { action: 'main', skill: null, source: 'router-fallback' }
  }
}
