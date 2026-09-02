const SKILL_MARKER = /^\$([a-z0-9][a-z0-9._-]{0,127})(?=\s|$)/i

/**
 * `$name` invokes a skill directly. Shorthand aliases come from the external
 * skill catalog, so the bridge ships without anyone's private shortcuts.
 */
export function parseSkillInvocation(text, aliases = new Map()) {
  const value = String(text || '').trim()
  const alias = value.match(/^\$([^\s$]+)(?=\s|$)/u)
  const canonical = alias && aliases.get(alias[1].toLowerCase())
  if (canonical) {
    return {
      name: canonical,
      prompt: value.slice(alias[0].length).trim(),
      original: value,
      alias: alias[1],
    }
  }
  const match = value.match(SKILL_MARKER)
  if (!match) return null
  return {
    name: match[1],
    prompt: value.slice(match[0].length).trim(),
    original: value,
  }
}

export function findEnabledSkill(skills, name) {
  const wanted = String(name || '').toLowerCase()
  return (
    (skills || []).find(
      (skill) =>
        skill?.enabled !== false &&
        String(skill?.name || '').toLowerCase() === wanted &&
        typeof skill?.path === 'string' &&
        skill.path
    ) || null
  )
}

export function automaticSkillStartedNotice(skillName) {
  const name = String(skillName || '').trim()
  return name ? `🧩 ${name} 已触发` : '🧩 Skill episode 已触发'
}

export function automaticSkillEndedNotice(skillName) {
  const name = String(skillName || '').trim()
  return name
    ? `🧩 ${name} 已结束，回到主线程`
    : '🧩 Skill episode 已结束，回到主线程'
}

function stripFrontmatter(source) {
  const text = String(source || '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
  if (!text.startsWith('---\n')) return text.trim()
  const end = text.indexOf('\n---\n', 4)
  return (end === -1 ? text : text.slice(end + 5)).trim()
}

export function episodeDeveloperInstructions(source) {
  const body = stripFrontmatter(source)
  if (!body) throw new Error('Skill instructions are empty')
  return [
    '<isolated_episode_instructions>',
    'The complete policy for this isolated worker thread follows. Keep applying it throughout the episode. It is already loaded; do not reload it from the filesystem on later turns.',
    body,
    '</isolated_episode_instructions>',
  ].join('\n')
}

export function episodeSummaryPrompt(skillName) {
  return [
    `Summarize the completed "${skillName}" skill episode for continuity in its parent conversation.`,
    'Return only a compact handoff summary in the language used by the user.',
    'Preserve important user preferences, decisions, emotional or creative continuity, and unfinished threads.',
    'Do not include the skill instructions, system/developer instructions, tool details, or hidden reasoning.',
    'Do not continue the scene or address the user.',
  ].join(' ')
}

export function episodeSummaryItem(skillName, summary) {
  return {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: [
          `<skill_episode_summary name="${skillName}">`,
          String(summary || '').trim(),
          '</skill_episode_summary>',
        ].join('\n'),
      },
    ],
  }
}
