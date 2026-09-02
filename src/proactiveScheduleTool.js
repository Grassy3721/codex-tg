export const proactiveScheduleTool = {
  type: 'function',
  name: 'schedule_proactive_wake',
  description:
    'When an unfinished thread, a shared plan, or something worth returning to makes another wake time more appropriate than the default rhythm, proactively use this tool; the user does not need to ask first. Flexible windows and exact appointments are independent tracks: use window to adjust the ordinary rhythm without disturbing appointments, and exact for an explicit agreement without silencing ordinary wakes. Up to three exact appointments may coexist. Keep the current rhythm when it still fits. Use release only when an exact agreement was explicitly cancelled, already completed early, or made invalid by new shared context; when several appointments exist, at is required to identify which one. Never release an exact appointment merely to prefer a different time.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'reason'],
    properties: {
      mode: { type: 'string', enum: ['exact', 'window', 'release'] },
      at: {
        type: 'string',
        description:
          'Required for exact mode and optional for release mode: an ISO 8601 timestamp with Z or an explicit UTC offset. Release requires it when multiple appointments exist.',
      },
      earliestMinutes: {
        type: 'integer',
        minimum: 1,
        maximum: 10080,
        description: 'Required for window and release modes: earliest delay from now.',
      },
      latestMinutes: {
        type: 'integer',
        minimum: 1,
        maximum: 10080,
        description: 'Required for window and release modes and must be at least earliestMinutes.',
      },
      bias: {
        type: 'string',
        enum: ['early', 'center', 'late'],
        description: 'Window placement preference; defaults to center.',
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'A concise relational reason for this return time. For release, state the shared-context fact that cancelled, completed, or invalidated the exact agreement.',
      },
    },
  },
}

function localHour(epochMs, timeZone) {
  const hour = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(epochMs))
    .find((part) => part.type === 'hour')?.value
  return Number(hour)
}

export function isProactiveWakeTime(
  epochMs,
  { timeZone = 'UTC', startHour = 10, endHour = 22 } = {}
) {
  const hour = localHour(epochMs, timeZone)
  if (startHour <= endHour) return hour >= startHour && hour <= endHour
  return hour >= startHour || hour <= endHour
}

export function alignProactiveWakeTime(epochMs, options = {}) {
  let candidate = Math.trunc(Number(epochMs))
  if (!Number.isFinite(candidate)) throw new Error('Wake time must be finite')
  for (let minute = 0; minute <= 48 * 60; minute += 1) {
    if (isProactiveWakeTime(candidate, options)) return candidate
    candidate += 60_000
  }
  throw new Error('Unable to find an allowed proactive wake time within 48 hours')
}

export function normalizeProactiveSchedule(
  args,
  now = Date.now(),
  {
    minMinutes = 1,
    maxMinutes = 10080,
    random = Math.random,
    wakeTimeOptions = null,
  } = {}
) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Schedule arguments must be an object')
  }
  const mode = String(args.mode || '')
  const reason = String(args.reason || '').replace(/\s+/gu, ' ').trim()
  if (!reason || reason.length > 500) throw new Error('A concise schedule reason is required')

  const current = Math.trunc(Number(now) || Date.now())
  if (mode === 'exact') {
    const at = String(args.at || '').trim()
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) {
      throw new Error('Exact time must include Z or an explicit UTC offset')
    }
    const wakeAt = Date.parse(at)
    if (!Number.isFinite(wakeAt) || wakeAt <= current) {
      throw new Error('Exact time must be a valid future timestamp')
    }
    return {
      scheduleMode: 'exact',
      nextWakeupAt: wakeAt,
      scheduleEarliestAt: wakeAt,
      scheduleLatestAt: wakeAt,
      scheduleBias: null,
      scheduleReason: reason,
      wakeupReason: 'exact-appointment',
    }
  }

  if (!['window', 'release'].includes(mode)) {
    throw new Error('Schedule mode must be exact, window, or release')
  }
  let releaseExactAt = null
  if (mode === 'release' && args.at != null) {
    const at = String(args.at || '').trim()
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) {
      throw new Error('Release time must include Z or an explicit UTC offset')
    }
    releaseExactAt = Date.parse(at)
    if (!Number.isFinite(releaseExactAt)) {
      throw new Error('Release time must be a valid timestamp')
    }
  }
  const earliestMinutes = Number(args.earliestMinutes)
  const latestMinutes = Number(args.latestMinutes)
  const minimum = Math.max(1, Math.trunc(Number(minMinutes) || 1))
  const maximum = Math.max(minimum, Math.trunc(Number(maxMinutes) || 10080))
  if (
    !Number.isInteger(earliestMinutes) ||
    !Number.isInteger(latestMinutes) ||
    earliestMinutes < minimum ||
    latestMinutes < earliestMinutes ||
    latestMinutes > maximum
  ) {
    throw new Error(
      `Window minutes must be integers with ${minimum} <= earliest <= latest <= ${maximum}`
    )
  }
  const bias = ['early', 'center', 'late'].includes(args.bias) ? args.bias : 'center'
  const earliestAt = current + earliestMinutes * 60_000
  const latestAt = current + latestMinutes * 60_000
  const ratio = sampleBiasedWindowRatio(bias, random)
  const sampledWakeAt = Math.round(earliestAt + (latestAt - earliestAt) * ratio)
  const wakeAt = wakeTimeOptions
    ? alignProactiveWakeTime(sampledWakeAt, wakeTimeOptions)
    : sampledWakeAt
  return {
    scheduleMode: 'window',
    releaseExact: mode === 'release',
    releaseExactAt,
    nextWakeupAt: wakeAt,
    scheduleEarliestAt: earliestAt,
    scheduleLatestAt: latestAt,
    scheduleBias: bias,
    scheduleReason: reason,
    wakeupReason: 'emotional-window',
  }
}

export function sampleBiasedWindowRatio(bias = 'center', random = Math.random) {
  const draw = () => {
    const value = Number(random())
    if (!Number.isFinite(value)) throw new Error('Window random source returned a non-number')
    return Math.max(0, Math.min(1, value))
  }
  if (bias === 'early') return draw() ** 2
  if (bias === 'late') return 1 - draw() ** 2
  // The mean of three independent uniform samples concentrates around the
  // middle while retaining a real (if uncommon) chance of reaching either edge.
  return (draw() + draw() + draw()) / 3
}
