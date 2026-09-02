import fs from 'node:fs'

/**
 * Skills the automatic router may start are declared in an external JSON
 * catalog so the bridge itself stays free of anyone's private skill names.
 *
 * {
 *   "skills": [
 *     { "name": "code-review", "purpose": "...", "aliases": ["cr"] }
 *   ]
 * }
 *
 * An absent or empty catalog simply disables automatic routing; explicit
 * `$skill-name` invocations keep working either way.
 */
export function normalizeSkillCatalog(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.skills) ? raw.skills : null
  if (!list) throw new Error('Skill catalog must be an array or { "skills": [...] }')

  const skills = []
  const aliases = new Map()
  const seen = new Set()
  for (const entry of list) {
    const name = String(entry?.name || '').trim()
    const purpose = String(entry?.purpose || '').trim()
    if (!name) throw new Error('Every catalog skill needs a name')
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) {
      throw new Error(`Invalid skill name in catalog: ${name}`)
    }
    if (seen.has(name.toLowerCase())) throw new Error(`Duplicate catalog skill: ${name}`)
    seen.add(name.toLowerCase())
    if (!purpose) throw new Error(`Catalog skill ${name} needs a purpose`)
    skills.push({ name, purpose })
    for (const alias of Array.isArray(entry?.aliases) ? entry.aliases : []) {
      const key = String(alias || '').trim().toLowerCase()
      if (!key) continue
      if (aliases.has(key)) throw new Error(`Duplicate catalog alias: ${key}`)
      aliases.set(key, name)
    }
  }
  return { skills, aliases }
}

export function loadSkillCatalog(filePath) {
  const path = String(filePath || '').trim()
  if (!path) return { skills: [], aliases: new Map() }
  let source
  try {
    source = fs.readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { skills: [], aliases: new Map() }
    throw error
  }
  return normalizeSkillCatalog(JSON.parse(source))
}
