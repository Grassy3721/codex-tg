import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { config } from '../config.js'

const STDERR_KEEP = 4000

/**
 * Compact an existing Codex thread through the documented App Server protocol.
 *
 * `thread/compact/start` only acknowledges that compaction began, so the
 * returned promise deliberately waits for the completion notification (or the
 * equivalent completed contextCompaction item).
 */
export function compactThread({
  threadId,
  workspace,
  sandbox,
  model,
  effort,
  codexBin,
  appServerArgs,
}) {
  const child = spawn(codexBin || config.codexBin, appServerArgs || config.appServerArgs, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  let stderr = ''
  let settled = false
  let stopped = false

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP)
  })

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  const finish = (error, result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    lines.close()
    if (child.exitCode === null) child.kill('SIGTERM')
    if (error) rejectPromise(error)
    else resolvePromise(result)
  }

  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.id === 1) {
      if (message.error) {
        finish(new Error(message.error.message || 'Codex initialization failed'))
        return
      }

      send({ method: 'initialized', params: {} })
      const params = {
        threadId,
        cwd: workspace,
        sandbox: sandbox || config.sandbox,
        excludeTurns: true,
      }
      if (model) params.model = model
      if (effort) params.config = { model_reasoning_effort: effort }
      send({ method: 'thread/resume', id: 2, params })
      return
    }

    if (message.id === 2) {
      if (message.error) {
        finish(new Error(message.error.message || 'Could not resume the Codex thread'))
        return
      }
      send({ method: 'thread/compact/start', id: 3, params: { threadId } })
      return
    }

    if (message.id === 3 && message.error) {
      finish(new Error(message.error.message || 'Could not start context compaction'))
      return
    }

    const sameThread = message.params?.threadId === threadId
    const compacted =
      (message.method === 'thread/compacted' && sameThread) ||
      (message.method === 'item/completed' &&
        sameThread &&
        message.params?.item?.type === 'contextCompaction')

    if (compacted) {
      finish(null, { threadId, turnId: message.params?.turnId || null })
      return
    }

    if (
      message.method === 'error' &&
      sameThread &&
      message.params?.willRetry === false
    ) {
      finish(new Error(message.params?.error?.message || 'Context compaction failed'))
    }
  })

  child.stdin.on('error', (error) => {
    if (!settled) finish(error)
  })
  child.once('error', (error) => finish(error))
  child.once('close', (code) => {
    if (settled) return
    const detail = stderr.trim()
    finish(
      new Error(
        stopped
          ? 'Context compaction stopped.'
          : `Codex compaction exited with code ${code}${detail ? `: ${detail}` : ''}`
      )
    )
  })

  const timer = setTimeout(() => {
    finish(
      new Error(
        `Context compaction timed out${stderr.trim() ? `: ${stderr.trim()}` : ''}`
      )
    )
  }, config.turnTimeoutMs)
  timer.unref()

  send({
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: { name: 'codex-tg', title: 'codex-tg', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    },
  })

  return {
    promise,
    kill() {
      if (settled) return
      stopped = true
      const error = new Error('Context compaction stopped.')
      error.code = 'COMPACT_STOPPED'
      finish(error)
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 3000).unref()
    },
  }
}

export default { compactThread }
