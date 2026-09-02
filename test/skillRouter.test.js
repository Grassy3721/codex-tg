import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideSkillRoute,
  localSkillRoute,
  parseSkillRouterDecision,
  skillRouterSchema,
} from '../src/skillRouter.js'

const SKILLS = [
  { name: 'code-review', purpose: 'Reviewing a diff or a file for defects.' },
  { name: 'writing-assistant', purpose: 'Drafting or editing prose the user is writing.' },
]

test('keywords never route locally and always require semantic intent', async () => {
  for (const text of ['review', '帮我看看这个函数', 'write something']) {
    assert.deepEqual(localSkillRoute(text), {
      action: 'classify',
      skill: null,
      source: 'semantic-fallback',
    })
  }

  let classified = false
  const ordinaryMention = await decideSkillRoute({
    text: 'that code review meeting was funny',
    skills: SKILLS,
    classify: async (prompt) => {
      classified = true
      assert.match(prompt, /isolated keywords/u)
      return JSON.stringify({ action: 'main', skill: null, confidence: 0.99 })
    },
  })
  assert.equal(classified, true)
  assert.equal(ordinaryMention.action, 'main')
})

test('every active-episode message is semantically checked for continuation or exit', () => {
  const episode = { skill_name: 'code-review' }
  assert.deepEqual(localSkillRoute('继续', episode), {
    action: 'classify',
    skill: null,
    source: 'semantic-episode',
  })
  assert.deepEqual(localSkillRoute('顺便看看这个 GitHub 链接', episode), {
    action: 'classify',
    skill: null,
    source: 'semantic-episode',
  })
})

test('unmatched messages use semantic routing instead of a phrase gate', async () => {
  let routerPrompt = ''
  const routed = await decideSkillRoute({
    text: '帮我 review 一下这个 diff',
    skills: SKILLS,
    recentMessages: [{ role: 'assistant', content: '好的。' }],
    classify: async (prompt) => {
      routerPrompt = prompt
      return JSON.stringify({ action: 'start', skill: 'code-review', confidence: 0.97 })
    },
  })
  assert.equal(routed.action, 'start')
  assert.equal(routed.skill, 'code-review')
  assert.match(routerPrompt, /这个 diff/u)

  const ordinary = await decideSkillRoute({
    text: '午饭吃土豆',
    skills: SKILLS,
    classify: async () =>
      JSON.stringify({ action: 'main', skill: null, confidence: 0.98 }),
  })
  assert.deepEqual(ordinary, {
    action: 'main',
    skill: null,
    confidence: 0.98,
    source: 'router',
  })
})

test('contextual messages use the hidden classifier and low confidence is conservative', async () => {
  const routed = await decideSkillRoute({
    text: '继续刚才那个',
    skills: SKILLS,
    recentMessages: [{ role: 'user', content: '帮我改改这段文字' }],
    classify: async () =>
      JSON.stringify({ action: 'start', skill: 'writing-assistant', confidence: 0.91 }),
  })
  assert.equal(routed.action, 'start')
  assert.equal(routed.skill, 'writing-assistant')

  assert.deepEqual(
    parseSkillRouterDecision(
      { action: 'end', skill: null, confidence: 0.4 },
      { skill_name: 'writing-assistant' },
      SKILLS
    ),
    {
      action: 'continue',
      skill: 'writing-assistant',
      confidence: 0.4,
      source: 'router-low',
    }
  )
})

test('a semantic topic change can end an active episode', async () => {
  const result = await decideSkillRoute({
    text: '算了，先看看这个 GitHub 链接',
    episode: { skill_name: 'writing-assistant' },
    skills: SKILLS,
    classify: async (prompt) => {
      assert.match(prompt, /link to inspect/u)
      return JSON.stringify({ action: 'end', skill: null, confidence: 0.98 })
    },
  })
  assert.deepEqual(result, {
    action: 'end',
    skill: null,
    confidence: 0.98,
    source: 'router',
  })
})

test('the router prompt carries only the user side of the recent window', async () => {
  let prompt = ''
  await decideSkillRoute({
    text: '继续',
    skills: SKILLS,
    recentMessages: [
      { role: 'user', content: '帮我看看这个函数' },
      { role: 'assistant', content: '这里有一个空指针风险……' },
      { role: 'user', content: '再仔细点' },
    ],
    classify: async (value) => {
      prompt = value
      return JSON.stringify({ action: 'main', skill: null, confidence: 0.99 })
    },
  })
  assert.match(prompt, /帮我看看这个函数/u)
  assert.match(prompt, /再仔细点/u)
  assert.doesNotMatch(prompt, /空指针风险/u)
  assert.doesNotMatch(prompt, /^assistant:/mu)
  assert.match(prompt, /assistant replies deliberately omitted/u)
})

test('an empty recent window is stated explicitly', async () => {
  let prompt = ''
  await decideSkillRoute({
    text: '午饭吃土豆',
    skills: SKILLS,
    recentMessages: [{ role: 'assistant', content: '好呀。' }],
    classify: async (value) => {
      prompt = value
      return JSON.stringify({ action: 'main', skill: null, confidence: 0.99 })
    },
  })
  assert.match(prompt, /Earlier messages from the user: none/u)
})

test('an empty catalog disables automatic routing without calling the classifier', async () => {
  let called = false
  const withoutCatalog = await decideSkillRoute({
    text: '帮我 review 一下这个 diff',
    classify: async () => {
      called = true
      return JSON.stringify({ action: 'start', skill: 'code-review', confidence: 0.99 })
    },
  })
  assert.equal(called, false)
  assert.deepEqual(withoutCatalog, { action: 'main', skill: null, source: 'no-catalog' })

  const duringEpisode = await decideSkillRoute({
    text: '继续',
    episode: { skill_name: 'code-review' },
    classify: async () => '{}',
  })
  assert.deepEqual(duringEpisode, {
    action: 'continue',
    skill: 'code-review',
    source: 'no-catalog',
  })
})

test('the output schema only admits catalog skill names', () => {
  const schema = skillRouterSchema(SKILLS)
  assert.deepEqual(schema.properties.skill.anyOf.at(-1).enum, [
    'code-review',
    'writing-assistant',
  ])
  assert.deepEqual(skillRouterSchema().properties.skill.anyOf.at(-1).enum, [])
})
