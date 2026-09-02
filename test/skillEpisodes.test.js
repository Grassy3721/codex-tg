import assert from 'node:assert/strict'
import test from 'node:test'
import {
  automaticSkillStartedNotice,
  episodeDeveloperInstructions,
  episodeSummaryItem,
  findEnabledSkill,
  parseSkillInvocation,
} from '../src/skillEpisodes.js'

test('automatic skill starts have a compact visible notice', () => {
  assert.equal(
    automaticSkillStartedNotice('fiction-writing'),
    '🧩 fiction-writing 已触发'
  )
  assert.equal(automaticSkillStartedNotice(''), '🧩 Skill episode 已触发')
})

test('episode instructions become persistent developer policy without a Skill marker', () => {
  const item = episodeDeveloperInstructions(
    '---\nname: test-private-skill\nversion: 1\n---\n# Episode policy\n\nKeep this rule.'
  )
  assert.match(item, /<isolated_episode_instructions>/)
  assert.match(item, /# Episode policy/)
  assert.match(item, /Keep this rule\./)
  assert.doesNotMatch(item, /test-private-skill/)
  assert.doesNotMatch(item, /version: 1/)
  assert.doesNotMatch(item, /SKILL\.md/)
})

test('skill invocation only matches an explicit leading marker', () => {
  const aliases = new Map([['cr', 'code-review']])
  assert.deepEqual(parseSkillInvocation('$code-review continue'), {
    name: 'code-review',
    prompt: 'continue',
    original: '$code-review continue',
  })
  assert.deepEqual(parseSkillInvocation('$cr 继续', aliases), {
    name: 'code-review',
    prompt: '继续',
    original: '$cr 继续',
    alias: 'cr',
  })
  // Without a catalog the alias is not special and does not resolve.
  assert.equal(parseSkillInvocation('$cr 继续').name, 'cr')
  assert.equal(parseSkillInvocation('please use $code-review'), null)
})

test('skill lookup is case insensitive and ignores disabled skills', () => {
  const skills = [
    { name: 'One', path: '/one/SKILL.md', enabled: false },
    { name: 'Two', path: '/two/SKILL.md', enabled: true },
  ]
  assert.equal(findEnabledSkill(skills, 'one'), null)
  assert.equal(findEnabledSkill(skills, 'TWO').path, '/two/SKILL.md')
})

test('episode handoff is injected as developer context', () => {
  const item = episodeSummaryItem('Two', 'Keep this detail.')
  assert.equal(item.role, 'developer')
  assert.match(item.content[0].text, /<skill_episode_summary name="Two">/)
  assert.match(item.content[0].text, /Keep this detail\./)
})
