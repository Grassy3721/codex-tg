import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { config } from '../config.js'

const TIMEOUT_MS = 10_000
const CACHE_MS = 30_000
const MODEL_CACHE_MS = 5 * 60_000
let accountCache = null
let modelCache = null

function queryAppServer(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    const pending = new Set(requests.map((request) => request.id))
    const results = new Map()
    let stderr = ''
    let settled = false

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.stdin.on('error', (error) => finish(error))

    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      child.kill('SIGTERM')
      if (error) reject(error)
      else resolve(result)
    }

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }

      if (message.id === 1) {
        if (message.error) return finish(new Error(message.error.message || 'Codex initialization failed'))
        send({ method: 'initialized', params: {} })
        for (const request of requests) send(request)
        return
      }

      if (!pending.has(message.id)) return
      if (message.error) {
        return finish(new Error(message.error.message || `Codex request ${message.id} failed`))
      }
      pending.delete(message.id)
      results.set(message.id, message.result)
      if (!pending.size) finish(null, results)
    })

    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (!settled) {
        finish(new Error(`Codex account query exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
      }
    })

    const timer = setTimeout(() => {
      finish(new Error(`Codex account query timed out${stderr ? `: ${stderr.trim()}` : ''}`))
    }, TIMEOUT_MS)
    timer.unref()

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'codex-tg', title: 'codex-tg', version: '0.1.0' },
      },
    })
  })
}

/**
 * Query the authenticated Codex account through the documented app-server
 * surface. The result deliberately excludes email and all auth credentials.
 */
export async function readAccountLimits() {
  if (accountCache && Date.now() - accountCache.at < CACHE_MS) return accountCache.value

  const results = await queryAppServer([
    { method: 'account/read', id: 2, params: { refreshToken: false } },
    { method: 'account/rateLimits/read', id: 3 },
  ])
  const value = {
    account: results.get(2)?.account || null,
    limits: results.get(3)?.rateLimits || null,
  }

  accountCache = { at: Date.now(), value }
  return value
}

/** Picker-visible models available to the current Codex account. */
export async function readAvailableModels() {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.value

  const results = await queryAppServer([
    {
      method: 'model/list',
      id: 2,
      params: { limit: 100, includeHidden: false },
    },
  ])
  const value = (results.get(2)?.data || []).filter((model) => !model.hidden)
  modelCache = { at: Date.now(), value }
  return value
}

export default { readAccountLimits, readAvailableModels }
