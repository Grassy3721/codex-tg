import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadSkillCatalog, normalizeSkillCatalog } from '../src/skillCatalog.js'

test('a catalog yields routable skills and lowercased aliases', () => {
  const { skills, aliases } = normalizeSkillCatalog({
    skills: [
      { name: 'code-review', purpose: 'Reviewing a diff.', aliases: ['CR', 'rv'] },
      { name: 'research', purpose: 'Open-ended investigation.' },
    ],
  })
  assert.deepEqual(skills, [
    { name: 'code-review', purpose: 'Reviewing a diff.' },
    { name: 'research', purpose: 'Open-ended investigation.' },
  ])
  assert.equal(aliases.get('cr'), 'code-review')
  assert.equal(aliases.get('rv'), 'code-review')
  assert.equal(aliases.size, 2)
})

test('a bare array is accepted and malformed entries are rejected', () => {
  assert.equal(normalizeSkillCatalog([{ name: 'a', purpose: 'b' }]).skills.length, 1)
  assert.throws(() => normalizeSkillCatalog({ skills: [{ purpose: 'no name' }] }), /needs a name/)
  assert.throws(() => normalizeSkillCatalog({ skills: [{ name: 'a' }] }), /needs a purpose/)
  assert.throws(() => normalizeSkillCatalog({ skills: [{ name: 'a b', purpose: 'c' }] }), /Invalid skill name/)
  assert.throws(
    () => normalizeSkillCatalog({ skills: [{ name: 'a', purpose: 'x' }, { name: 'A', purpose: 'y' }] }),
    /Duplicate catalog skill/
  )
  assert.throws(() => normalizeSkillCatalog('nope'), /must be an array/)
})

test('a missing or unset catalog path leaves routing empty instead of throwing', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-tg-catalog-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))

  assert.deepEqual(loadSkillCatalog(''), { skills: [], aliases: new Map() })
  assert.deepEqual(loadSkillCatalog(path.join(directory, 'absent.json')), {
    skills: [],
    aliases: new Map(),
  })

  const file = path.join(directory, 'skills.json')
  fs.writeFileSync(file, JSON.stringify({ skills: [{ name: 'x', purpose: 'y' }] }))
  assert.deepEqual(loadSkillCatalog(file).skills, [{ name: 'x', purpose: 'y' }])
})

test('the shipped example catalog is valid', () => {
  const file = new URL('../skills.example.json', import.meta.url)
  const { skills } = normalizeSkillCatalog(JSON.parse(fs.readFileSync(file, 'utf8')))
  assert.ok(skills.length >= 1)
})
