import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tg-memory-test-'))
const fixedOne = path.join(root, 'SOUL.md')
const fixedTwo = path.join(root, 'USER.md')
process.env.PROFILE_FILES = `${fixedOne},${fixedTwo}`
process.env.MEMORY_FILE = path.join(root, 'MEMORY.md')
process.env.MEMORY_MAX_CHARS = '120'
await fs.writeFile(fixedOne, '# SOUL\nFixed identity.')
await fs.writeFile(fixedTwo, '# USER\nA developer.')

const {
  applyMemoryOperations,
  buildEvolvingMemorySnapshot,
  buildFixedProfileDeveloperInstructions,
  ensureMemoryFile,
  forgetMemoryItem,
  readMemory,
} = await import('../src/memoryStore.js')

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('fixed portrait and evolving memory are built as separate injections', async () => {
  await ensureMemoryFile()
  await applyMemoryOperations([
    { action: 'add', oldText: null, content: '喜欢简洁的技术说明。' },
  ])
  const fixed = await buildFixedProfileDeveloperInstructions()
  const memory = await buildEvolvingMemorySnapshot()
  assert.match(fixed, /<bridge_fixed_profile>/)
  assert.match(fixed, /Fixed identity/)
  assert.doesNotMatch(fixed, /<bridge_evolving_memory>/)
  assert.match(memory.text, /<bridge_evolving_memory/)
  assert.match(memory.text, /喜欢简洁的技术说明/)
  assert.equal(memory.hash.length, 64)
})

test('validated operations add, replace, delete, and forget exact entries', async () => {
  await applyMemoryOperations([
    {
      action: 'replace',
      oldText: '喜欢简洁的技术说明。',
      content: '偏好简洁但完整的技术说明。',
    },
    { action: 'add', oldText: null, content: '长期使用 Telegram bridge。' },
  ])
  let memory = await readMemory()
  assert.deepEqual(memory.items, ['偏好简洁但完整的技术说明。', '长期使用 Telegram bridge。'])

  const removed = await forgetMemoryItem(2)
  assert.equal(removed, '长期使用 Telegram bridge。')
  memory = await readMemory()
  assert.deepEqual(memory.items, ['偏好简洁但完整的技术说明。'])
})

test('invalid oldText and oversized results leave the file unchanged', async () => {
  const before = (await readMemory()).text
  await assert.rejects(
    applyMemoryOperations([
      { action: 'replace', oldText: '不存在', content: 'new' },
    ]),
    /does not exactly match/
  )
  await assert.rejects(
    applyMemoryOperations([
      { action: 'add', oldText: null, content: 'x'.repeat(110) },
    ]),
    /limit is 120/
  )
  assert.equal((await readMemory()).text, before)
})

test('section-delimited MEMORY files are parsed and preserved in § format', async () => {
  await fs.writeFile(
    process.env.MEMORY_FILE,
    '# MEMORY\n\n第一段稳定记忆。\n§\nSecond stable memory.\n'
  )
  const memory = await readMemory()
  assert.deepEqual(memory.items, ['第一段稳定记忆。', 'Second stable memory.'])

  await applyMemoryOperations([
    {
      action: 'replace',
      oldText: '第一段稳定记忆。',
      content: '更新后的第一段稳定记忆。',
    },
  ])
  const output = await fs.readFile(process.env.MEMORY_FILE, 'utf8')
  assert.equal(
    output,
    '# MEMORY\n\n更新后的第一段稳定记忆。\n§\nSecond stable memory.\n'
  )
})
