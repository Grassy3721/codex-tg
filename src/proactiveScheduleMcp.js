#!/usr/bin/env node
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const { config } = await import('./config.js')
const {
  ensureProactiveRhythm,
  sessionKey,
  setProactiveSchedule,
} = await import('./db.js')
const {
  normalizeProactiveSchedule,
  proactiveScheduleTool,
} = await import('./proactiveScheduleTool.js')

const targetKey = sessionKey(config.proactiveWakeChatId, config.proactiveWakeTopicId)
const scheduleInputSchema = structuredClone(proactiveScheduleTool.inputSchema)
scheduleInputSchema.properties.earliestMinutes.minimum = config.proactiveWakeMinMinutes
scheduleInputSchema.properties.earliestMinutes.maximum = config.proactiveWakeMaxMinutes
scheduleInputSchema.properties.latestMinutes.minimum = config.proactiveWakeMinMinutes
scheduleInputSchema.properties.latestMinutes.maximum = config.proactiveWakeMaxMinutes

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function toolResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    isError,
  }
}

function ensureRhythm(now) {
  return ensureProactiveRhythm({
    sessionKey: targetKey,
    chatId: config.proactiveWakeChatId,
    topicId: config.proactiveWakeTopicId,
    nextWakeupAt: now + config.proactiveWakeBootstrapMinutes * 60_000,
    now,
  })
}

async function callSchedule(args) {
  if (!config.proactiveWakeEnabled) {
    return toolResult('Autonomous wakes are disabled in this bridge.', true)
  }
  const now = Date.now()
  let plan
  try {
    plan = normalizeProactiveSchedule(args, now, {
      minMinutes: config.proactiveWakeMinMinutes,
      maxMinutes: config.proactiveWakeMaxMinutes,
      wakeTimeOptions: {
        timeZone: config.proactiveWakeTimezone,
        startHour: config.proactiveWakeStartHour,
        endHour: config.proactiveWakeEndHour,
      },
    })
  } catch (error) {
    return toolResult(error.message, true)
  }

  ensureRhythm(now)
  const result = setProactiveSchedule(targetKey, plan, now)
  if (result.status === 'leased') {
    return toolResult(
      'A wake is already running. Its live lease prevents this schedule change; do not retry during this turn.',
      true
    )
  }
  if (result.status === 'no-exact-to-release') {
    return toolResult('There is no active exact appointment to release.', true)
  }
  if (result.status === 'exact-capacity-reached') {
    return toolResult(
      'Three exact appointments are already active. Complete or release one before adding another.',
      true
    )
  }
  if (result.status === 'exact-release-ambiguous') {
    return toolResult(
      'Several exact appointments are active. Provide at with the exact appointment timestamp to release only that one.',
      true
    )
  }
  if (result.status === 'exact-to-release-not-found') {
    return toolResult('No active exact appointment matches the supplied release time.', true)
  }
  if (result.status !== 'scheduled') {
    return toolResult('The rhythm changed concurrently, so this schedule was not written.', true)
  }

  return toolResult(
    JSON.stringify({
      scheduled: true,
      operation: args.mode,
      mode: plan.scheduleMode,
      at: new Date(plan.nextWakeupAt).toISOString(),
      earliest:
        plan.scheduleEarliestAt == null
          ? null
          : new Date(plan.scheduleEarliestAt).toISOString(),
      latest:
        plan.scheduleLatestAt == null
          ? null
          : new Date(plan.scheduleLatestAt).toISOString(),
      bias: plan.scheduleBias,
      reason: plan.scheduleReason,
      generation: result.rhythm?.generation,
      exactAppointments: (result.rhythm?.exact_appointments || []).map((appointment) => ({
        at: new Date(Number(appointment.wakeup_at)).toISOString(),
        reason: appointment.reason,
      })),
    })
  )
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', async (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    rpcError(null, -32700, 'Parse error')
    return
  }

  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sinus-rhythm', version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: proactiveScheduleTool.name,
            description: proactiveScheduleTool.description,
            inputSchema: scheduleInputSchema,
          },
        ],
      },
    })
    return
  }
  if (method === 'tools/call') {
    if (params?.name !== proactiveScheduleTool.name) {
      send({ jsonrpc: '2.0', id, result: toolResult('Unknown tool.', true) })
      return
    }
    try {
      send({ jsonrpc: '2.0', id, result: await callSchedule(params.arguments) })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: toolResult(`Scheduler failure: ${error.message}`, true),
      })
    }
    return
  }
  if (id !== undefined) rpcError(id, -32601, 'Method not found')
})
