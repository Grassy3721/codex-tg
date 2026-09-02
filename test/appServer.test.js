import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'

const { createAppServerBackend } = await import('../src/backends/appServer.js')
const here = path.dirname(fileURLToPath(import.meta.url))

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function raceFixtureEnv(t, { delayMs = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tg-app-server-race-'))
  const log = path.join(directory, 'events.log')
  fs.writeFileSync(log, '')
  const previousLog = process.env.APP_SERVER_RACE_LOG
  const previousDelay = process.env.APP_SERVER_RACE_SKILLS_DELAY_MS
  process.env.APP_SERVER_RACE_LOG = log
  process.env.APP_SERVER_RACE_SKILLS_DELAY_MS = String(delayMs)
  t.after(() => {
    if (previousLog === undefined) delete process.env.APP_SERVER_RACE_LOG
    else process.env.APP_SERVER_RACE_LOG = previousLog
    if (previousDelay === undefined) delete process.env.APP_SERVER_RACE_SKILLS_DELAY_MS
    else process.env.APP_SERVER_RACE_SKILLS_DELAY_MS = previousDelay
  })
  return { log, args: [path.join(here, 'fixtures', 'fakeAppServerRace.sh')] }
}

test('app-server turn forwards an approval response and resumes event streaming', async (t) => {
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: [path.join(here, 'fixtures', 'fakeAppServerTurn.sh')],
  })
  t.after(() => backend.close())

  const events = []
  const turn = backend.runTurn({
    workspace: '/tmp',
    prompt: 'test approval',
    sandbox: 'workspace-write',
    model: 'test-model',
    effort: 'high',
    imagePaths: ['/tmp/input.png'],
    developerInstructions: 'test portrait',
    memorySnapshot: { hash: 'memory-hash', text: 'latest memory' },
    innerBatonSnapshot: { version: 3, text: '<inner_baton version="3">state</inner_baton>' },
    recentThreadContext: 'recent thread tail',
    ephemeral: true,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    },
  })

  for await (const event of turn) {
    events.push(event)
    if (event.type === 'approval.requested') {
      assert.equal(event.approval.kind, 'command')
      assert.equal(await event.approval.respond('accept'), true)
    }
  }

  assert.equal(events[0].type, 'thread.started')
  assert.equal(events[0].thread_id, 'app-thread-1')
  const memoryInjected = events.find((event) => event.type === 'memory.injected')
  assert.equal(memoryInjected.thread_id, 'app-thread-1')
  assert.equal(memoryInjected.memory_hash, 'memory-hash')
  const batonInjected = events.find((event) => event.type === 'inner_baton.injected')
  assert.equal(batonInjected.thread_id, 'app-thread-1')
  assert.equal(batonInjected.version, 3)
  assert.equal(
    events.find((event) => event.type === 'recent_context.injected')?.thread_id,
    'app-thread-1'
  )
  assert.equal(events.some((event) => event.type === 'approval.requested'), true)
  const answer = events.find((event) => event.type === 'item.completed')
  assert.equal(answer.thread_id, 'app-thread-1')
  assert.equal(answer.item.type, 'agent_message')
  assert.equal(answer.item.text, 'approval resumed')
  assert.equal(events.at(-1).type, 'turn.completed')
})

test('skills/list waits for an in-progress recycle before starting the new app-server', async (t) => {
  const fixture = raceFixtureEnv(t)
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: fixture.args,
  })
  t.after(() => backend.close())

  let releaseRecycle
  backend.recycling = new Promise((resolve) => {
    releaseRecycle = resolve
  })

  const skillsPromise = backend.listSkills('/tmp')
  await sleep(25)
  assert.equal(fs.readFileSync(fixture.log, 'utf8').includes('request:'), false)

  releaseRecycle()
  assert.deepEqual(await skillsPromise, [])

  const events = fs.readFileSync(fixture.log, 'utf8').trim().split('\n')
  assert.match(events[0], /^start:/)
  assert.match(events[1], /^request:.*"method":"initialize"/)
  assert.match(events[2], /^request:.*"method":"skills\/list"/)
})

test('health checks do not recycle while skills/list RPC is in flight', async (t) => {
  const fixture = raceFixtureEnv(t, { delayMs: 120 })
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: fixture.args,
  })
  t.after(() => backend.close())

  await backend.ensureStarted()
  const skillsPromise = backend.listSkills('/tmp')
  await sleep(20)
  assert.equal(backend.inFlightRequests, 1)

  backend.lastActivityAt = Date.now() - 60 * 60 * 1000
  backend.checkHealth()

  assert.equal(backend.recycling, null)
  assert.deepEqual(await skillsPromise, [])
  assert.equal(backend.inFlightRequests, 0)
})

test('resumed threads reload MCP config before starting their first turn', async (t) => {
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: [path.join(here, 'fixtures', 'fakeAppServerResume.sh')],
  })
  t.after(() => backend.close())

  const events = []
  const turn = backend.runTurn({
    workspace: '/tmp',
    threadId: 'existing-thread',
    prompt: 'resume test',
    sandbox: 'workspace-write',
    imagePaths: [],
  })
  for await (const event of turn) events.push(event)

  assert.equal(events.some((event) => event.type === 'thread.started'), false)
  const answer = events.find(
    (event) => event.type === 'item.completed' && event.item?.type === 'agent_message'
  )
  assert.equal(answer.item.text, 'resume reloaded')
  assert.equal(events.at(-1).type, 'turn.completed')
})

test('a writable wake leaves the resumed main conversation writable', async (t) => {
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: [path.join(here, 'fixtures', 'fakeAppServerWakeWritable.sh')],
  })
  t.after(() => backend.close())

  const wake = backend.runTurn({
    workspace: '/tmp/writable-workspace',
    threadId: 'live-thread',
    prompt: 'perform recoverable local maintenance',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    imagePaths: [],
  })
  for await (const _event of wake) {
    // Drain the wake before resuming the same thread as the main conversation.
  }

  const mainEvents = []
  const main = backend.runTurn({
    workspace: '/tmp/writable-workspace',
    threadId: 'live-thread',
    prompt: 'continue the main conversation',
    sandbox: 'workspace-write',
    imagePaths: [],
  })
  for await (const event of main) mainEvents.push(event)

  assert.equal(
    mainEvents.find((event) => event.item?.type === 'agent_message')?.item.text,
    'main thread remains writable'
  )
  assert.equal(mainEvents.at(-1).type, 'turn.completed')
})

test('a terminal app-server error releases the global turn scheduler', async (t) => {
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: [path.join(here, 'fixtures', 'fakeAppServerTerminalError.sh')],
  })
  t.after(() => backend.close())

  const failedEvents = []
  const failed = backend.runTurn({
    workspace: '/tmp',
    prompt: 'hit model capacity',
    sandbox: 'workspace-write',
    imagePaths: [],
  })
  for await (const event of failed) failedEvents.push(event)

  assert.deepEqual(failedEvents.at(-1), {
    type: 'error',
    message: 'Selected model is at capacity. Please try a different model.',
  })

  const recoveryEvents = []
  const recovery = backend.runTurn({
    workspace: '/tmp',
    prompt: 'try the next message',
    sandbox: 'workspace-write',
    imagePaths: [],
  })
  for await (const event of recovery) recoveryEvents.push(event)

  assert.equal(
    recoveryEvents.find((event) => event.item?.type === 'agent_message')?.item.text,
    'scheduler recovered'
  )
  assert.equal(recoveryEvents.at(-1).type, 'turn.completed')
})

test('app-server queues early steering until the active turn id is ready', async (t) => {
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: [path.join(here, 'fixtures', 'fakeAppServerSteer.sh')],
  })
  t.after(() => backend.close())

  const turn = backend.runTurn({
    workspace: '/tmp',
    prompt: 'start work',
    sandbox: 'workspace-write',
    imagePaths: [],
  })
  const steered = turn.steer({
    prompt: 'Actually use the new requirement.',
    clientUserMessageId: 'telegram:123:456',
  })

  const events = []
  for await (const event of turn) events.push(event)

  assert.deepEqual(await steered, { turnId: 'steer-turn-1' })
  const answer = events.find(
    (event) => event.type === 'item.completed' && event.item?.type === 'agent_message'
  )
  assert.equal(answer.item.text, 'steering received')
  assert.equal(events.at(-1).type, 'turn.completed')
})

test('app-server registers and handles a client-side dynamic tool', async (t) => {
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: [path.join(here, 'fixtures', 'fakeAppServerDynamicTool.sh')],
  })
  t.after(() => backend.close())

  const calls = []
  const events = []
  const turn = backend.runTurn({
    workspace: '/tmp',
    prompt: 'react if appropriate',
    sandbox: 'workspace-write',
    imagePaths: [],
    dynamicTools: [
      {
        type: 'function',
        name: 'telegram_react',
        description: 'React to the current Telegram message.',
        inputSchema: {
          type: 'object',
          required: ['emoji'],
          properties: { emoji: { type: 'string' } },
        },
      },
    ],
    dynamicToolHandler: async (params) => {
      calls.push(params)
      return {
        contentItems: [{ type: 'inputText', text: 'reaction added' }],
        success: true,
      }
    },
  })

  for await (const event of turn) events.push(event)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'telegram_react')
  assert.deepEqual(calls[0].arguments, { emoji: '❤️' })
  assert.equal(events.at(-1).type, 'turn.completed')
})

test('skill episode forks with persistent developer policy, then sends text only', async (t) => {
  const backend = createAppServerBackend({
    codexBin: '/bin/bash',
    appServerArgs: [path.join(here, 'fixtures', 'fakeAppServerSkillEpisode.sh')],
  })
  t.after(() => backend.close())

  const firstEvents = []
  const first = backend.runTurn({
    workspace: '/tmp',
    forkFromThreadId: 'parent-thread',
    prompt: 'first prompt',
    sandbox: 'workspace-write',
    imagePaths: [],
    developerInstructions:
      '<isolated_episode_instructions>test policy</isolated_episode_instructions>',
  })
  for await (const event of first) firstEvents.push(event)

  assert.deepEqual(firstEvents[0], {
    type: 'thread.started',
    thread_id: 'skill-worker',
    forked_from_id: 'parent-thread',
  })

  const secondEvents = []
  const second = backend.runTurn({
    workspace: '/tmp',
    threadId: 'skill-worker',
    prompt: 'follow up',
    sandbox: 'workspace-write',
    imagePaths: [],
  })
  for await (const event of second) secondEvents.push(event)

  assert.equal(
    secondEvents.find((event) => event.item?.type === 'agent_message')?.item.text,
    'second answer'
  )
})
