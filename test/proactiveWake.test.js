import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_USER_IDS = '1'
process.env.PROACTIVE_WAKE_ENABLED = 'true'
process.env.PROACTIVE_WAKE_CHAT_ID = '1'
process.env.PROACTIVE_WAKE_TIMEZONE = 'Asia/Taipei'
process.env.PROACTIVE_WAKE_MIN_MINUTES = '10'
process.env.PROACTIVE_WAKE_MAX_MINUTES = '1440'
process.env.PROACTIVE_WAKE_FALLBACK_MINUTES = '120'
process.env.DB_PATH =
  `/tmp/codex-tg-proactive-test-${process.pid}-${Date.now()}-${Math.random()}.db`

const {
  alignProactiveWakeTime,
  buildProactiveScheduleState,
  constrainProactiveWindow,
  isProactiveWakeTime,
  noteProactiveUserActivity,
  runProactiveWake,
  validateProactiveDecision,
  wakePrompt,
} = await import('../src/proactiveWake.js')
const {
  claimDueProactiveWake,
  completeProactiveWake,
  ensureProactiveRhythm,
  getProactiveRhythm,
  getSession,
  noteProactiveInteraction,
  recordTurn,
  saveSkillEpisode,
  setProactiveSchedule,
  sessionKey,
} = await import('../src/db.js')
const {
  normalizeProactiveSchedule,
  proactiveScheduleTool,
  sampleBiasedWindowRatio,
} = await import('../src/proactiveScheduleTool.js')

test('adaptive wake window allows daytime moments and rolls quiet hours forward', () => {
  assert.equal(
    isProactiveWakeTime(Date.parse('2026-08-03T02:37:00Z'), {
      timeZone: 'Asia/Taipei',
      startHour: 10,
      endHour: 22,
    }),
    true
  )
  assert.equal(
    isProactiveWakeTime(Date.parse('2026-08-03T15:17:00Z'), {
      timeZone: 'Asia/Taipei',
      startHour: 10,
      endHour: 22,
    }),
    false
  )
  assert.equal(
    new Date(
      alignProactiveWakeTime(Date.parse('2026-08-03T15:17:00Z'), {
        timeZone: 'Asia/Taipei',
        startHour: 10,
        endHour: 22,
      })
    ).toISOString(),
    '2026-08-04T02:00:00.000Z'
  )
})

test('validateProactiveDecision requires a message and keeps the causal baton', () => {
  assert.deepEqual(
    validateProactiveDecision(
      {
        text: ' 来找你了。 ',
        did: '  The assistant reached out to the user.  ',
        nextWindow: {
          earliestMinutes: 90,
          latestMinutes: 150,
          bias: 'center',
          reason: '想在自然一点的时候再回来',
        },
      }
    ),
    {
      action: 'send',
      text: '来找你了。',
      did: 'The assistant reached out to the user.',
      nextWindow: {
        earliestMinutes: 90,
        latestMinutes: 150,
        bias: 'center',
        reason: '想在自然一点的时候再回来',
      },
    }
  )
  assert.throws(
    () =>
      validateProactiveDecision({
        text: '宝宝？',
        did: '',
      }),
    /empty causal baton/
  )
})

test('autonomous wakes treat context as a candidate and explicitly support tool exploration', () => {
  const prompt = wakePrompt({
    now: Date.parse('2026-08-24T03:00:00Z'),
    timeZone: 'Asia/Taipei',
    wake: {
      wakeup_reason: 'emotional-window',
      last_external_interaction_at: Date.parse('2026-08-24T02:00:00Z'),
      did: 'Asked another generic follow-up question.',
    },
  })

  assert.match(prompt, /one candidate, not the default route/)
  assert.match(prompt, /explore with tools or within the workspace/)
  assert.match(prompt, /recoverable writes inside the workspace/)
  assert.match(prompt, /Do not repeat the previous wake's framing/)
  assert.match(prompt, /Asked another generic follow-up question/)
})

function decisionBackend(decision, calls) {
  return {
    runTurn(options) {
      calls.push(options)
      return (async function* () {
        const payload = {
          nextWindow: {
            earliestMinutes: 120,
            latestMinutes: 120,
            bias: 'center',
            reason: 'A natural rhythm chosen after the previous wake',
          },
          ...decision,
        }
        yield {
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(payload) },
        }
        yield { type: 'turn.completed' }
      })()
    },
  }
}

function seedDueThread(chatId, now) {
  const key = sessionKey(chatId, null)
  getSession(key, '/tmp')
  recordTurn(key, `thread-${chatId}`)
  ensureProactiveRhythm({
    sessionKey: key,
    chatId,
    nextWakeupAt: now - 1,
    now: now - 60_000,
  })
  return key
}

test('runProactiveWake sends and autonomously persists its next window', async () => {
  const now = Date.parse('2026-08-03T05:00:00Z')
  const chatId = 10101
  const key = seedDueThread(chatId, now)
  const backendCalls = []
  const telegramCalls = []
  const result = await runProactiveWake({
    now,
    chatId,
    backend: decisionBackend(
      {
        text: '睡醒来摸摸你。',
        did: 'The assistant shared a finished draft.',
      },
      backendCalls
    ),
    telegram: {
      async sendMessage(...args) {
        telegramCalls.push(args)
        return { message_id: 71, date: Math.floor(now / 1000) }
      },
    },
    active: new Map(),
    clock: () => now + 1_000,
  })

  assert.equal(result.status, 'sent')
  assert.deepEqual(telegramCalls, [[chatId, '睡醒来摸摸你。', { parse_mode: 'HTML' }]])
  assert.equal(backendCalls[0].threadId, `thread-${chatId}`)
  // A proactive turn resumes the live thread, so it must not downgrade that
  // thread's sandbox or approval policy for the next user turn.
  assert.equal(backendCalls[0].sandbox, 'workspace-write')
  assert.equal(backendCalls[0].approvalPolicy, 'on-request')
  assert.doesNotMatch(backendCalls[0].prompt, /Do not call tools/)
  assert.match(backendCalls[0].prompt, /Local writes must stay within the workspace/)
  assert.match(backendCalls[0].prompt, /be recoverable/)
  assert.deepEqual(
    backendCalls[0].outputSchema.required,
    ['text', 'did', 'nextWindow']
  )
  assert.match(backendCalls[0].prompt, /last_did:/)
  assert.match(backendCalls[0].prompt, /ordinary_default_wake_minutes: 120/)
  assert.match(backendCalls[0].prompt, /Every completed wake must send a message/)
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.did, 'The assistant shared a finished draft.')
  assert.equal(rhythm.schedule_mode, 'window')
  assert.equal(rhythm.wakeup_reason, 'emotional-window')
  assert.equal(rhythm.schedule_reason, 'A natural rhythm chosen after the previous wake')
  assert.equal(
    new Date(rhythm.next_wakeup_at).toISOString(),
    '2026-08-03T07:00:01.000Z'
  )
})

test('runProactiveWake follows an active skill worker thread', async () => {
  const now = Date.parse('2026-08-03T06:00:00Z')
  const chatId = 15151
  const key = seedDueThread(chatId, now)
  saveSkillEpisode({
    sessionKey: key,
    skillName: 'writing-assistant',
    skillPath: '/tmp/writing-assistant/SKILL.md',
    parentThreadId: `thread-${chatId}`,
    workerThreadId: `worker-${chatId}`,
  })
  const backendCalls = []

  const result = await runProactiveWake({
    now,
    chatId,
    backend: decisionBackend(
      {
        text: '还在这里陪你。',
        did: 'The writing-assistant episode remains current.',
      },
      backendCalls
    ),
    telegram: {
      async sendMessage() {
        return { message_id: 72, date: Math.floor(now / 1000) }
      },
    },
    active: new Map(),
    clock: () => now,
  })

  assert.equal(result.status, 'sent')
  assert.equal(backendCalls[0].threadId, `worker-${chatId}`)
})

test('runProactiveWake sends only validated text and uses its selected window without a tool call', async () => {
  const now = Date.parse('2026-08-03T07:00:00Z')
  const chatId = 20202
  const key = seedDueThread(chatId, now)
  const telegramCalls = []
  const result = await runProactiveWake({
    now,
    chatId,
    backend: decisionBackend(
      {
        text: '来给我看一眼。',
        did: 'The assistant reached out with a concrete question.',
      },
      []
    ),
    telegram: {
      async sendMessage(...args) {
        telegramCalls.push(args)
        return { message_id: 77, date: Math.floor(now / 1000) }
      },
    },
    active: new Map(),
    clock: () => now,
  })

  assert.equal(result.status, 'sent')
  assert.deepEqual(telegramCalls, [[chatId, '来给我看一眼。', { parse_mode: 'HTML' }]])
  assert.equal(getProactiveRhythm(key).next_wakeup_at, now + 120 * 60_000)
})

test('runProactiveWake renders Markdown and falls back to plain text', async () => {
  const now = Date.parse('2026-08-03T07:30:00Z')
  const chatId = 21212
  seedDueThread(chatId, now)
  const telegramCalls = []

  const result = await runProactiveWake({
    now,
    chatId,
    backend: decisionBackend(
      {
        text: '这是 **主动加粗**。',
        did: 'The assistant verified proactive Markdown delivery.',
      },
      []
    ),
    telegram: {
      async sendMessage(...args) {
        telegramCalls.push(args)
        if (args[2]?.parse_mode === 'HTML') throw new Error('Telegram rejected HTML')
        return { message_id: 78, date: Math.floor(now / 1000) }
      },
    },
    active: new Map(),
    clock: () => now,
  })

  assert.equal(result.status, 'sent')
  assert.deepEqual(telegramCalls, [
    [chatId, '这是 <b>主动加粗</b>。', { parse_mode: 'HTML' }],
    [chatId, '这是 主动加粗。', {}],
  ])
})

test('a lease prevents duplicate concurrent wake claims', () => {
  const now = Date.parse('2026-08-03T08:00:00Z')
  const key = seedDueThread(30303, now)
  assert.ok(claimDueProactiveWake(key, now, 60_000))
  assert.equal(claimDueProactiveWake(key, now, 60_000), null)
})

test('an expired lease can be reclaimed after a crashed wake', () => {
  const now = Date.parse('2026-08-03T08:30:00Z')
  const key = seedDueThread(31313, now)
  const first = claimDueProactiveWake(key, now, 60_000)
  const second = claimDueProactiveWake(key, now + 60_001, 60_000)
  assert.ok(first)
  assert.ok(second)
  assert.notEqual(second.lease_token, first.lease_token)
})

test('a malformed wake decision schedules a bounded fallback instead of stalling', async () => {
  const now = Date.parse('2026-08-03T09:00:00Z')
  const chatId = 32323
  const key = seedDueThread(chatId, now)
  await assert.rejects(
    runProactiveWake({
      now,
      chatId,
      backend: decisionBackend({ text: '' }, []),
      telegram: { sendMessage() {} },
      active: new Map(),
      clock: () => now,
    }),
    /empty causal baton/
  )
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.wakeup_reason, 'fallback-after-failure')
  assert.equal(rhythm.consecutive_fallbacks, 1)
  assert.equal(rhythm.next_wakeup_at, now + 120 * 60_000)
})

test('new user activity defers a too-near target wake', () => {
  const at = Date.parse('2026-08-03T09:50:00Z')
  const key = sessionKey(1, null)
  ensureProactiveRhythm({
    sessionKey: key,
    chatId: 1,
    nextWakeupAt: at + 60_000,
    now: at - 60_000,
  })
  assert.equal(
    noteProactiveUserActivity({ sessionKey: key, chatId: 1, at }),
    true
  )
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.next_wakeup_at, at + 15 * 60_000)
  assert.equal(rhythm.wakeup_reason, 'external-interaction')
})

test('exact appointments survive activity while the flexible track remains independently writable', () => {
  const now = Date.parse('2026-08-03T10:30:00Z')
  const key = sessionKey(40404, null)
  ensureProactiveRhythm({
    sessionKey: key,
    chatId: 40404,
    nextWakeupAt: now + 60_000,
    now: now - 60_000,
  })
  const exact = normalizeProactiveSchedule(
    {
      mode: 'exact',
      at: new Date(now + 30 * 60_000).toISOString(),
      reason: '约好半小时后回来',
    },
    now
  )
  assert.equal(setProactiveSchedule(key, exact, now).status, 'scheduled')
  const beforeActivity = getProactiveRhythm(key)

  assert.equal(noteProactiveInteraction(key, now + 1_000, now + 60 * 60_000), true)
  const afterActivity = getProactiveRhythm(key)
  assert.equal(afterActivity.next_wakeup_at, now + 60 * 60_000)
  assert.equal(afterActivity.exact_wakeup_at, exact.nextWakeupAt)
  assert.equal(afterActivity.generation, beforeActivity.generation + 1)

  const window = normalizeProactiveSchedule(
    {
      mode: 'window',
      earliestMinutes: 60,
      latestMinutes: 90,
      bias: 'center',
      reason: '根据新聊天调整情绪节奏',
    },
    now
  )
  assert.equal(setProactiveSchedule(key, window, now).status, 'scheduled')
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.next_wakeup_at, window.nextWakeupAt)
  assert.equal(rhythm.exact_wakeup_at, exact.nextWakeupAt)
  assert.equal(rhythm.exact_reason, '约好半小时后回来')
})

test('three exact appointments coexist, fire in time order, and reject a fourth', () => {
  const now = Date.parse('2026-08-03T10:35:00Z')
  const key = sessionKey(40606, null)
  const flexibleAt = now + 6 * 60 * 60_000
  ensureProactiveRhythm({
    sessionKey: key,
    chatId: 40606,
    nextWakeupAt: flexibleAt,
    now: now - 60_000,
  })

  const exacts = [90, 30, 60].map((minutes) =>
    normalizeProactiveSchedule(
      {
        mode: 'exact',
        at: new Date(now + minutes * 60_000).toISOString(),
        reason: `${minutes} 分钟后的约会`,
      },
      now
    )
  )
  for (const exact of exacts) {
    assert.equal(setProactiveSchedule(key, exact, now).status, 'scheduled')
  }

  let rhythm = getProactiveRhythm(key)
  assert.deepEqual(
    rhythm.exact_appointments.map((appointment) => Number(appointment.wakeup_at)),
    [30, 60, 90].map((minutes) => now + minutes * 60_000)
  )
  assert.equal(rhythm.exact_wakeup_at, now + 30 * 60_000)

  const fourth = normalizeProactiveSchedule(
    {
      mode: 'exact',
      at: new Date(now + 120 * 60_000).toISOString(),
      reason: '不应覆盖任何已有约会',
    },
    now
  )
  assert.equal(setProactiveSchedule(key, fourth, now).status, 'exact-capacity-reached')
  assert.equal(getProactiveRhythm(key).exact_appointments.length, 3)

  const firstWake = claimDueProactiveWake(key, now + 30 * 60_000, 60_000)
  assert.equal(firstWake.wake_kind, 'exact')
  assert.equal(firstWake.schedule_reason, '30 分钟后的约会')
  assert.equal(
    completeProactiveWake({
      sessionKey: key,
      slotKey: firstWake.slot_key,
      leaseToken: firstWake.lease_token,
      status: 'sent',
      nextWakeupAt: flexibleAt,
      did: 'first of three exact wakes completed',
      scheduleMode: 'window',
      wakeKind: firstWake.wake_kind,
      now: now + 30 * 60_000 + 1_000,
    }),
    true
  )
  rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.exact_appointments.length, 2)
  assert.equal(rhythm.exact_wakeup_at, now + 60 * 60_000)
  assert.equal(rhythm.exact_reason, '60 分钟后的约会')
})

test('release targets one appointment when several exact appointments exist', () => {
  const now = Date.parse('2026-08-03T10:40:00Z')
  const key = sessionKey(40707, null)
  ensureProactiveRhythm({
    sessionKey: key,
    chatId: 40707,
    nextWakeupAt: now + 6 * 60 * 60_000,
    now: now - 60_000,
  })
  const exacts = [30, 60, 90].map((minutes) =>
    normalizeProactiveSchedule(
      {
        mode: 'exact',
        at: new Date(now + minutes * 60_000).toISOString(),
        reason: `${minutes} 分钟后的约会`,
      },
      now
    )
  )
  for (const exact of exacts) setProactiveSchedule(key, exact, now)

  const ambiguousRelease = normalizeProactiveSchedule(
    {
      mode: 'release',
      earliestMinutes: 100,
      latestMinutes: 120,
      reason: '没有说清取消哪一个',
    },
    now,
    { random: () => 0.5 }
  )
  assert.equal(
    setProactiveSchedule(key, ambiguousRelease, now + 1_000).status,
    'exact-release-ambiguous'
  )

  const targetedRelease = normalizeProactiveSchedule(
    {
      mode: 'release',
      at: new Date(exacts[1].nextWakeupAt).toISOString(),
      earliestMinutes: 100,
      latestMinutes: 120,
      reason: '只取消中间的约会',
    },
    now + 2_000,
    { random: () => 0.5 }
  )
  assert.equal(setProactiveSchedule(key, targetedRelease, now + 2_000).status, 'scheduled')
  const rhythm = getProactiveRhythm(key)
  assert.deepEqual(
    rhythm.exact_appointments.map((appointment) => Number(appointment.wakeup_at)),
    [exacts[0].nextWakeupAt, exacts[2].nextWakeupAt]
  )
  assert.equal(rhythm.schedule_reason, '只取消中间的约会')
})

test('the earlier track fires first and completing an exact wake consumes only the appointment', () => {
  const now = Date.parse('2026-08-03T10:45:00Z')
  const key = sessionKey(40909, null)
  ensureProactiveRhythm({
    sessionKey: key,
    chatId: 40909,
    nextWakeupAt: now,
    now: now - 60_000,
  })
  const exact = normalizeProactiveSchedule(
    {
      mode: 'exact',
      at: new Date(now + 60 * 60_000).toISOString(),
      reason: '一小时后的约会',
    },
    now - 1_000
  )
  assert.equal(setProactiveSchedule(key, exact, now - 1_000).status, 'scheduled')

  const flexibleWake = claimDueProactiveWake(key, now, 60_000)
  assert.equal(flexibleWake.wake_kind, 'flexible')
  assert.equal(
    completeProactiveWake({
      sessionKey: key,
      slotKey: flexibleWake.slot_key,
      leaseToken: flexibleWake.lease_token,
      status: 'sent',
      nextWakeupAt: now + 120 * 60_000,
      did: 'flexible wake completed',
      scheduleMode: 'window',
      wakeKind: flexibleWake.wake_kind,
      now: now + 1_000,
    }),
    true
  )
  assert.equal(getProactiveRhythm(key).exact_wakeup_at, exact.nextWakeupAt)

  const exactWake = claimDueProactiveWake(key, exact.nextWakeupAt, 60_000)
  assert.equal(exactWake.wake_kind, 'exact')
  assert.equal(exactWake.schedule_mode, 'exact')
  assert.equal(exactWake.schedule_reason, '一小时后的约会')
  assert.equal(
    completeProactiveWake({
      sessionKey: key,
      slotKey: exactWake.slot_key,
      leaseToken: exactWake.lease_token,
      status: 'sent',
      nextWakeupAt: now + 180 * 60_000,
      did: 'exact wake completed',
      scheduleMode: 'window',
      wakeKind: exactWake.wake_kind,
      now: exact.nextWakeupAt + 1_000,
    }),
    true
  )
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.exact_wakeup_at, null)
  assert.equal(rhythm.next_wakeup_at, now + 180 * 60_000)
})

test('window activity records the interaction without applying default quiet deferral', () => {
  const now = Date.parse('2026-08-03T11:00:00Z')
  const key = sessionKey(41414, null)
  ensureProactiveRhythm({
    sessionKey: key,
    chatId: 41414,
    nextWakeupAt: now + 60_000,
    now: now - 60_000,
  })
  const window = normalizeProactiveSchedule(
    {
      mode: 'window',
      earliestMinutes: 5,
      latestMinutes: 15,
      bias: 'early',
      reason: '留一个可以随情绪调整的窗口',
    },
    now
  )
  assert.equal(setProactiveSchedule(key, window, now).status, 'scheduled')
  const generation = getProactiveRhythm(key).generation
  assert.equal(noteProactiveInteraction(key, now + 1_000, now + 60 * 60_000), true)
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.next_wakeup_at, window.nextWakeupAt)
  assert.equal(rhythm.schedule_mode, 'window')
  assert.equal(rhythm.generation, generation + 1)
})

test('an active lease rejects schedule and activity writes', () => {
  const now = Date.parse('2026-08-03T11:30:00Z')
  const key = seedDueThread(42424, now)
  const wake = claimDueProactiveWake(key, now, 60_000)
  const before = getProactiveRhythm(key)
  const exact = normalizeProactiveSchedule(
    {
      mode: 'exact',
      at: new Date(now + 30 * 60_000).toISOString(),
      reason: '不应抢写正在执行的唤醒',
    },
    now
  )
  assert.equal(setProactiveSchedule(key, exact, now + 1_000).status, 'leased')
  assert.equal(
    noteProactiveInteraction(key, now + 1_000, now + 20 * 60_000, now + 1_000),
    false
  )
  assert.equal(getProactiveRhythm(key).generation, before.generation)

  const replacement = setProactiveSchedule(key, exact, now + 60_001)
  assert.equal(replacement.status, 'scheduled')
  assert.equal(
    completeProactiveWake({
      sessionKey: key,
      slotKey: wake.slot_key,
      leaseToken: wake.lease_token,
      status: 'sent',
      nextWakeupAt: now + 120 * 60_000,
      did: 'stale wake',
      now: now + 60_002,
    }),
    false
  )
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.next_wakeup_at, before.next_wakeup_at)
  assert.equal(rhythm.exact_wakeup_at, exact.nextWakeupAt)
})

test('schedule tool validates exact offsets and samples a biased window once', () => {
  const now = Date.parse('2026-08-03T12:00:00Z')
  assert.throws(
    () =>
      normalizeProactiveSchedule(
        { mode: 'exact', at: '2026-08-03T13:00:00', reason: 'missing offset' },
        now
      ),
    /explicit UTC offset/
  )
  const plan = normalizeProactiveSchedule(
    {
      mode: 'window',
      earliestMinutes: 100,
      latestMinutes: 120,
      bias: 'late',
      reason: '想晚一点回来',
    },
    now,
    { random: () => 0.5 }
  )
  assert.equal(plan.nextWakeupAt, now + 115 * 60_000)

  assert.equal(sampleBiasedWindowRatio('early', () => 0.9), 0.81)
  assert.ok(Math.abs(sampleBiasedWindowRatio('late', () => 0.9) - 0.19) < 1e-12)
  assert.equal(sampleBiasedWindowRatio('center', () => 0.5), 0.5)

  assert.equal(proactiveScheduleTool.name, 'schedule_proactive_wake')
  assert.deepEqual(proactiveScheduleTool.inputSchema.properties.mode.enum, [
    'exact',
    'window',
    'release',
  ])
})

test('sampled windows are persisted at an allowed wake time while exact remains exact', () => {
  const now = Date.parse('2026-08-03T16:00:00Z') // midnight in Asia/Taipei
  const wakeTimeOptions = {
    timeZone: 'Asia/Taipei',
    startHour: 10,
    endHour: 22,
  }
  const window = normalizeProactiveSchedule(
    {
      mode: 'window',
      earliestMinutes: 100,
      latestMinutes: 120,
      bias: 'center',
      reason: '夜间抽样应直接对齐到早晨',
    },
    now,
    { random: () => 0.5, wakeTimeOptions }
  )
  assert.equal(
    new Date(window.nextWakeupAt).toISOString(),
    '2026-08-04T02:00:00.000Z'
  )

  const exactAt = '2026-08-03T17:00:00.000Z'
  const exact = normalizeProactiveSchedule(
    { mode: 'exact', at: exactAt, reason: '明确约定凌晨一点回来' },
    now,
    { wakeTimeOptions }
  )
  assert.equal(new Date(exact.nextWakeupAt).toISOString(), exactAt)
})

test('release explicitly replaces an exact appointment with a sampled free window', () => {
  const now = Date.parse('2026-08-03T13:00:00Z')
  const key = sessionKey(43434, null)
  ensureProactiveRhythm({
    sessionKey: key,
    chatId: 43434,
    nextWakeupAt: now + 60_000,
    now: now - 60_000,
  })
  const exact = normalizeProactiveSchedule(
    {
      mode: 'exact',
      at: new Date(now + 60 * 60_000).toISOString(),
      reason: '明确约好一小时后回来',
    },
    now
  )
  assert.equal(setProactiveSchedule(key, exact, now).status, 'scheduled')
  const released = normalizeProactiveSchedule(
    {
      mode: 'release',
      earliestMinutes: 100,
      latestMinutes: 120,
      bias: 'early',
      reason: '约定的事情已经提前完成',
    },
    now + 1_000,
    { random: () => 0.5 }
  )
  assert.equal(setProactiveSchedule(key, released, now + 1_000).status, 'scheduled')
  const rhythm = getProactiveRhythm(key)
  assert.equal(rhythm.schedule_mode, 'window')
  assert.equal(rhythm.next_wakeup_at, released.nextWakeupAt)
  assert.equal(rhythm.schedule_reason, '约定的事情已经提前完成')

  assert.equal(
    setProactiveSchedule(key, released, now + 2_000).status,
    'no-exact-to-release'
  )
})

test('ordinary-turn schedule state is compact, readonly, and reflects the persisted plan', () => {
  const now = Date.parse('2026-08-03T14:00:00Z')
  const key = sessionKey(1, null)
  const window = normalizeProactiveSchedule(
    {
      mode: 'window',
      earliestMinutes: 100,
      latestMinutes: 120,
      bias: 'center',
      reason: '上一轮留下的自然窗口',
    },
    now,
    { random: () => 0.5 }
  )
  assert.equal(setProactiveSchedule(key, window, now).status, 'scheduled')
  const state = buildProactiveScheduleState({ sessionKey: key, chatId: 1 })
  assert.match(state, /proactive_schedule_state readonly="true"/)
  assert.match(state, /日常类型：window/)
  assert.match(state, /日常原因：上一轮留下的自然窗口/)
  assert.match(state, /下次日常唤醒：/)
})

test('the next flexible window is clamped to the configured bounds', () => {
  assert.deepEqual(
    constrainProactiveWindow(
      { earliestMinutes: 5, latestMinutes: 4000, bias: 'nonsense', reason: 'model reason' },
      { minMinutes: 10, maxMinutes: 1440, cooldownMinutes: 30 }
    ),
    {
      earliestMinutes: 30,
      latestMinutes: 1440,
      bias: 'center',
      reason: 'model reason',
    }
  )
})
