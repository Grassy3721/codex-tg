import assert from 'node:assert/strict'
import test from 'node:test'

import { loadThreadBaseline } from '../src/threadBaseline.js'

test('a completed compaction reloads both AGENTS.md and evolving memory', async () => {
  const calls = []
  const result = await loadThreadBaseline({
    activeThreadId: 'compacted-thread',
    getThreadMemoryHash() {
      return null
    },
    async buildEvolvingMemorySnapshot() {
      calls.push('memory')
      return { hash: 'new-window', text: 'latest memory' }
    },
    async buildFixedProfileDeveloperInstructions() {
      calls.push('profile')
      return '<bridge_fixed_profile>AGENTS.md</bridge_fixed_profile>'
    },
  })

  assert.deepEqual(calls, ['memory', 'profile'])
  assert.deepEqual(result, {
    memorySnapshot: { hash: 'new-window', text: 'latest memory' },
    developerInstructions: '<bridge_fixed_profile>AGENTS.md</bridge_fixed_profile>',
  })
})

test('AGENTS.md still reloads when evolving memory fails after compaction', async () => {
  const warnings = []
  const result = await loadThreadBaseline({
    activeThreadId: 'compacted-thread',
    getThreadMemoryHash() {
      return null
    },
    async buildEvolvingMemorySnapshot() {
      throw new Error('MEMORY.md unavailable')
    },
    async buildFixedProfileDeveloperInstructions() {
      return '<bridge_fixed_profile>AGENTS.md</bridge_fixed_profile>'
    },
    warn(...args) {
      warnings.push(args.join(' '))
    },
  })

  assert.equal(result.memorySnapshot, null)
  assert.match(result.developerInstructions, /AGENTS\.md/)
  assert.match(warnings[0], /MEMORY\.md unavailable/)
})

test('an unchanged live window does not inject the baseline again', async () => {
  let loads = 0
  const result = await loadThreadBaseline({
    activeThreadId: 'live-thread',
    getThreadMemoryHash() {
      return 'current-window'
    },
    async buildEvolvingMemorySnapshot() {
      loads += 1
    },
    async buildFixedProfileDeveloperInstructions() {
      loads += 1
    },
  })

  assert.equal(loads, 0)
  assert.deepEqual(result, { memorySnapshot: null, developerInstructions: '' })
})
