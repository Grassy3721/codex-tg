import { spawn } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'
import { config } from '../config.js'

const STDERR_KEEP = 4000
const PROCESS_TERMINATION_GRACE_MS = 5000

class AsyncEventQueue {
  constructor(maxItems = config.eventQueueMaxItems) {
    this.items = []
    this.waiters = []
    this.ended = false
    this.maxItems = Math.max(16, Number(maxItems) || 256)
    this.dropped = 0
  }

  push(value) {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else {
      if (this.items.length >= this.maxItems) {
        this.items.shift()
        this.dropped += 1
      }
      this.items.push(value)
    }
  }

  end() {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false })
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process already exited.
    }
  }
}

async function terminateProcessGroup(child, graceMs = PROCESS_TERMINATION_GRACE_MS) {
  if (!child || child.exitCode !== null) return

  signalProcessGroup(child, 'SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ])
  if (child.exitCode === null) {
    signalProcessGroup(child, 'SIGKILL')
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ])
  }
}

function processGroupRssBytes(pid) {
  if (!pid) return 0
  const pageSize = 4096
  let total = 0
  let entries
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return 0
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
      const closeParen = stat.lastIndexOf(')')
      const fields = stat.slice(closeParen + 2).split(' ')
      // After the comm field: state=1, ppid=2, pgrp=3 (1-based here).
      if (Number(fields[2]) !== pid) continue
      const statm = fs.readFileSync(`/proc/${entry}/statm`, 'utf8').trim().split(/\s+/)
      total += Number(statm[1] || 0) * pageSize
    } catch {
      // Processes can disappear while /proc is being scanned.
    }
  }
  return total
}

class TurnScheduler {
  constructor({ backgroundQueueLimit = config.backgroundQueueLimit } = {}) {
    this.main = []
    this.background = []
    this.active = null
    this.running = false
    this.sequence = 0
    this.backgroundQueueLimit = Math.max(1, Number(backgroundQueueLimit) || 4)
  }

  schedule({ priority = 'main', start }) {
    const stream = new AsyncEventQueue()
    let resolveFinished
    const finished = new Promise((resolve) => {
      resolveFinished = resolve
    })
    const job = {
      id: ++this.sequence,
      priority,
      start,
      stream,
      inner: null,
      cancelled: false,
      cancelling: false,
      resolveFinished,
    }

    stream.finished = finished
    stream.kill = () => this.cancel(job, 'cancelled')
    stream.steer = (...args) => {
      if (job.inner?.steer) return job.inner.steer(...args)
      return Promise.reject(new Error('Turn is waiting for the global scheduler'))
    }

    if (priority === 'background' && this.background.length >= this.backgroundQueueLimit) {
      stream.push({ type: 'error', message: 'Background turn queue is full; turn skipped.' })
      stream.end()
      resolveFinished()
      return stream
    }

    if (priority === 'main') {
      this.cancelQueuedBackgrounds('preempted by main chat')
      if (this.active?.priority === 'background') this.cancel(this.active, 'preempted by main chat')
      this.main.push(job)
    } else {
      this.background.push(job)
    }
    this.dispatch()
    return stream
  }

  cancelQueuedBackgrounds(reason) {
    for (const job of this.background.splice(0)) this.cancel(job, reason)
  }

  cancel(job, reason) {
    if (job.cancelled) return
    job.cancelled = true
    if (this.active === job) {
      if (!job.cancelling) {
        job.cancelling = true
        if (job.inner?.killAndWait) void job.inner.killAndWait(reason)
        else job.inner?.kill?.()
      }
      return
    }
    this.main = this.main.filter((candidate) => candidate !== job)
    this.background = this.background.filter((candidate) => candidate !== job)
    job.stream.push({ type: 'error', message: `Turn ${reason}.` })
    job.stream.end()
    job.resolveFinished()
  }

  async dispatch() {
    if (this.running) return
    this.running = true
    try {
      while (this.main.length || this.background.length) {
        const job = this.main.shift() || this.background.shift()
        if (!job || job.cancelled) continue
        this.active = job
        let inner = null
        try {
          inner = job.inner = job.start()
          for await (const event of inner) job.stream.push(event)
          await inner.finished
        } catch (error) {
          job.stream.push({ type: 'error', message: error.message })
        } finally {
          job.stream.end()
          job.resolveFinished()
          if (this.active === job) this.active = null
        }
      }
    } finally {
      this.running = false
      if ((this.main.length || this.background.length) && !this.active) this.dispatch()
    }
  }
}

function normalizeItem(item) {
  if (!item) return item
  switch (item.type) {
    case 'agentMessage':
      return { ...item, type: 'agent_message' }
    case 'commandExecution':
      return {
        ...item,
        type: 'command_execution',
        aggregated_output: item.aggregatedOutput,
        exit_code: item.exitCode,
      }
    case 'fileChange':
      return { ...item, type: 'file_change' }
    case 'mcpToolCall':
      return { ...item, type: 'mcp_tool_call' }
    case 'webSearch':
      return { ...item, type: 'web_search' }
    case 'contextCompaction':
      return { ...item, type: 'context_compaction' }
    default:
      return item
  }
}

function cancellationResult(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'cancel' }
    case 'mcpServer/elicitation/request':
      return { action: 'cancel', content: null, _meta: null }
    case 'item/tool/requestUserInput':
      return { answers: {} }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }
    case 'item/tool/call':
      return {
        contentItems: [{ type: 'inputText', text: 'The client-side tool is unavailable.' }],
        success: false,
      }
    default:
      return null
  }
}

function approvalKind(method) {
  return {
    'item/commandExecution/requestApproval': 'command',
    'item/fileChange/requestApproval': 'file_change',
    'mcpServer/elicitation/request': 'mcp_elicitation',
    'item/tool/requestUserInput': 'user_input',
    'item/permissions/requestApproval': 'permissions',
  }[method]
}

function approvalResult(method, params, action, value) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision: action }
  }
  if (method === 'mcpServer/elicitation/request') {
    return {
      action,
      content: action === 'accept' ? value ?? null : null,
      _meta: null,
    }
  }
  if (method === 'item/tool/requestUserInput') {
    const question = params.questions?.[0]
    return question && action === 'accept'
      ? { answers: { [question.id]: { answers: [String(value ?? '')] } } }
      : { answers: {} }
  }
  if (method === 'item/permissions/requestApproval') {
    return action === 'accept' || action === 'acceptForSession'
      ? {
          permissions: {
            ...(params.permissions?.network ? { network: params.permissions.network } : {}),
            ...(params.permissions?.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
          },
          scope: action === 'acceptForSession' ? 'session' : 'turn',
        }
      : { permissions: {}, scope: 'turn' }
  }
  throw new Error(`Unsupported approval request: ${method}`)
}

class AppServerClient {
  constructor({
    codexBin = config.codexBin,
    appServerArgs = config.appServerArgs,
    rpcTimeoutMs = config.appServerRpcTimeoutMs,
  } = {}) {
    this.codexBin = codexBin
    this.appServerArgs = appServerArgs
    this.rpcTimeoutMs = Math.max(1, Number(rpcTimeoutMs) || config.appServerRpcTimeoutMs)
    this.child = null
    this.lines = null
    this.stderr = ''
    this.nextId = 1
    this.pending = new Map()
    this.inFlightRequests = 0
    this.operationsByThread = new Map()
    this.operationsByTurn = new Map()
    this.operations = new Set()
    this.mcpReloadedThreads = new Set()
    this.skillsChangedListeners = new Set()
    this.starting = null
    this.recycling = null
    this.monitorTimer = null
    this.lastActivityAt = 0
    this.turnCount = 0
    this.recycleWhenIdle = null
    this.scheduler = new TurnScheduler()
  }

  async ensureStarted() {
    if (this.recycling) await this.recycling
    if (this.starting) return this.starting
    if (this.child && this.child.exitCode === null) return Promise.resolve()
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async start() {
    const child = spawn(this.codexBin, this.appServerArgs, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    })
    this.child = child
    this.stderr = ''
    this.lastActivityAt = Date.now()
    this.turnCount = 0
    this.recycleWhenIdle = null
    this.startMonitor()
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => this.onLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP)
    })
    child.stdin.on('error', (error) => this.onExit(error, child))
    child.once('error', (error) => this.onExit(error, child))
    child.once('close', (code) => {
      this.onExit(
        new Error(
          `Codex App Server exited with code ${code}${
            this.stderr.trim() ? `: ${this.stderr.trim()}` : ''
          }`
        ),
        child
      )
    })

    await this.requestRaw('initialize', {
      clientInfo: { name: 'codex-tg', title: 'codex-tg', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized', params: {} })
  }

  startMonitor() {
    clearInterval(this.monitorTimer)
    this.monitorTimer = setInterval(() => this.checkHealth(), config.appServerMonitorIntervalMs)
    this.monitorTimer.unref()
  }

  stopMonitor() {
    clearInterval(this.monitorTimer)
    this.monitorTimer = null
  }

  checkHealth() {
    if (!this.child || this.child.exitCode !== null) return
    if (this.inFlightRequests > 0) return
    const rss = processGroupRssBytes(this.child.pid)
    const idle =
      this.operations.size === 0 &&
      this.inFlightRequests === 0 &&
      Date.now() - this.lastActivityAt >= config.appServerIdleMs
    if (rss >= config.appServerMaxRssBytes) {
      this.recycleWhenIdle ||= `RSS threshold exceeded (${Math.round(rss / 1024 / 1024)} MiB)`
    } else if (this.turnCount >= config.appServerMaxTurns) {
      this.recycleWhenIdle ||= `turn threshold exceeded (${this.turnCount})`
    } else if (idle) {
      this.recycleWhenIdle ||= `idle for ${Math.round(config.appServerIdleMs / 60000)} minutes`
    }
    if (this.recycleWhenIdle && this.operations.size === 0 && this.inFlightRequests === 0) {
      void this.recycle(this.recycleWhenIdle)
    }
  }

  async recycle(reason = 'resource policy') {
    if (this.recycling) return this.recycling
    const child = this.child
    if (!child || child.exitCode !== null) return
    this.lastActivityAt = Date.now()
    this.recycling = terminateProcessGroup(child).finally(() => {
      this.recycling = null
    })
    console.warn(`[app-server] recycling Codex process: ${reason}`)
    return this.recycling
  }

  send(message) {
    if (!this.child || this.child.exitCode !== null) throw new Error('Codex App Server is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  requestRaw(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const pending = {
        method,
        resolve,
        reject,
        timer: null,
      }
      this.pending.set(id, pending)
      this.inFlightRequests += 1
      this.lastActivityAt = Date.now()
      pending.timer = setTimeout(() => {
        const error = new Error(
          `Codex App Server RPC timed out after ${this.rpcTimeoutMs}ms: ${method}`
        )
        this.rejectPending(error)
        void this.recycle(`RPC timeout: ${method}`)
      }, this.rpcTimeoutMs)
      pending.timer.unref()
      try {
        this.send({ method, id, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        this.settlePending(id, { error })
      }
    })
  }

  settlePending(id, { result, error } = {}) {
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.inFlightRequests = Math.max(0, this.inFlightRequests - 1)
    this.lastActivityAt = Date.now()
    if (error) pending.reject(error)
    else pending.resolve(result)
    return true
  }

  rejectPending(error) {
    const pending = [...this.pending.entries()]
    for (const [id] of pending) this.settlePending(id, { error })
  }

  async request(method, params) {
    await this.ensureStarted()
    return this.requestRaw(method, params)
  }

  async setMcpToolApproval(serverName, toolName, mode = 'approve') {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverName)) throw new Error('Invalid MCP server name')
    if (!/^[A-Za-z0-9_:/-]{1,256}$/.test(toolName)) throw new Error('Invalid MCP tool name')
    if (!['auto', 'prompt', 'writes', 'approve'].includes(mode)) {
      throw new Error('Invalid MCP approval mode')
    }
    await this.request('config/value/write', {
      keyPath: `mcp_servers.${serverName}.tools.${toolName}.approval_mode`,
      value: mode,
      mergeStrategy: 'upsert',
    })
    await this.request('config/mcpServer/reload')
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.method && message.id !== undefined) {
      this.onServerRequest(message)
      return
    }

    if (message.id !== undefined) {
      if (message.error) {
        this.settlePending(message.id, {
          error: new Error(message.error.message || 'Codex request failed'),
        })
      } else {
        this.settlePending(message.id, { result: message.result })
      }
      return
    }

    if (message.method) this.onNotification(message)
  }

  operationFor(params = {}) {
    return (
      (params.turnId && this.operationsByTurn.get(params.turnId)) ||
      (params.threadId && this.operationsByThread.get(params.threadId)) ||
      null
    )
  }

  onNotification(message) {
    const params = message.params || {}
    if (message.method === 'skills/changed') {
      for (const listener of this.skillsChangedListeners) {
        try {
          listener()
        } catch (error) {
          console.warn('[app-server] skills/changed listener failed:', error.message)
        }
      }
      return
    }
    const operation = this.operationFor(params)
    if (!operation) return

    switch (message.method) {
      case 'turn/started': {
        const turnId = params.turn?.id
        if (turnId) {
          operation.turnId = turnId
          this.operationsByTurn.set(turnId, operation)
          operation.readyResolve()
        }
        break
      }
      case 'item/started':
        operation.queue.push({
          type: 'item.started',
          thread_id: params.threadId,
          item: normalizeItem(params.item),
        })
        break
      case 'item/completed':
        operation.queue.push({
          type: 'item.completed',
          thread_id: params.threadId,
          item: normalizeItem(params.item),
        })
        break
      case 'turn/completed': {
        const turn = params.turn || {}
        operation.queue.push(
          turn.status === 'failed'
            ? { type: 'turn.failed', error: turn.error || { message: 'Turn failed' } }
            : { type: 'turn.completed', usage: turn.usage }
        )
        operation.finishActual()
        operation.finish()
        break
      }
      case 'error':
        operation.queue.push({
          type: 'error',
          message: params.error?.message || params.message || 'Codex App Server error',
        })
        if (params.willRetry === false) {
          // Terminal app-server errors (for example model capacity) are not
          // followed by turn/completed. Resolve both lifecycles so the global
          // scheduler can advance instead of waiting on `finished` forever.
          operation.finishActual()
          operation.finish()
        }
        break
      default:
        break
    }
  }

  onServerRequest(message) {
    if (message.method === 'item/tool/call') {
      const operation = this.operationFor(message.params)
      if (!operation?.dynamicToolHandler) {
        this.send({ id: message.id, result: cancellationResult(message.method) })
        return
      }

      Promise.resolve(operation.dynamicToolHandler(message.params))
        .then((result) => {
          this.send({
            id: message.id,
            result: {
              contentItems: Array.isArray(result?.contentItems) ? result.contentItems : [],
              success: result?.success === true,
            },
          })
        })
        .catch((error) => {
          console.warn('[app-server] dynamic tool failed:', error.message)
          this.send({
            id: message.id,
            result: {
              contentItems: [
                { type: 'inputText', text: 'The client-side tool failed unexpectedly.' },
              ],
              success: false,
            },
          })
        })
      return
    }

    const kind = approvalKind(message.method)
    const operation = this.operationFor(message.params)
    if (!kind || !operation) {
      const result = cancellationResult(message.method)
      if (result) this.send({ id: message.id, result })
      return
    }

    let resolved = false
    const approval = {
      id: message.id,
      kind,
      method: message.method,
      params: message.params,
      respond: async (action, value) => {
        if (resolved) return false
        resolved = true
        operation.approvals.delete(approval)
        this.send({
          id: message.id,
          result: approvalResult(message.method, message.params, action, value),
        })
        return true
      },
    }
    operation.approvals.add(approval)
    operation.queue.push({ type: 'approval.requested', approval })
  }

  onExit(error, sourceChild = this.child) {
    if (!this.child || sourceChild !== this.child) return
    this.stopMonitor()
    this.lines?.close()
    this.child = null
    this.rejectPending(error)
    this.operationsByThread.clear()
    this.operationsByTurn.clear()
    this.mcpReloadedThreads.clear()
    for (const operation of this.operations) {
      operation.queue.push({ type: 'error', message: error.message })
      operation.finish(false)
      operation.finishActual()
    }
    this.operations.clear()
    this.lastActivityAt = Date.now()
  }

  async openThread({
    workspace,
    threadId,
    forkFromThreadId,
    sandbox,
    model,
    effort,
    approvalPolicy,
    approvalsReviewer,
    developerInstructions,
    ephemeral,
    dynamicTools,
  }) {
    const params = {
      cwd: workspace,
      sandbox: sandbox || config.sandbox,
      approvalPolicy: approvalPolicy || 'on-request',
      approvalsReviewer: approvalsReviewer || 'user',
      excludeTurns: true,
    }
    if (model) params.model = model
    if (effort) params.config = { model_reasoning_effort: effort }
    if (developerInstructions) params.developerInstructions = developerInstructions

    if (threadId) {
      params.threadId = threadId
      const result = await this.request('thread/resume', params)
      if (!this.mcpReloadedThreads.has(threadId)) {
        await this.request('config/mcpServer/reload')
        this.mcpReloadedThreads.add(threadId)
      }
      return result
    }
    if (forkFromThreadId) {
      params.threadId = forkFromThreadId
      delete params.excludeTurns
      if (ephemeral !== undefined) params.ephemeral = Boolean(ephemeral)
      return this.request('thread/fork', params)
    }
    delete params.excludeTurns
    if (ephemeral !== undefined) params.ephemeral = Boolean(ephemeral)
    if (dynamicTools?.length) params.dynamicTools = dynamicTools
    return this.request('thread/start', params)
  }

  runTurnNow(options) {
    const queue = new AsyncEventQueue()
    let resolveFinished
    const finished = new Promise((resolve) => {
      resolveFinished = resolve
    })
    let readyResolve
    const ready = new Promise((resolve) => {
      readyResolve = resolve
    })
    const operation = {
      queue,
      threadId: options.threadId || null,
      turnId: null,
      approvals: new Set(),
      dynamicToolHandler: options.dynamicToolHandler || null,
      ready,
      readyResolve,
      steerTail: Promise.resolve(),
      done: false,
      actualDone: false,
      killTimer: null,
      finish: (remove = true) => {
        if (!operation.done) {
          operation.done = true
          clearTimeout(operation.timer)
          operation.readyResolve()
          queue.end()
        }
        if (remove) operation.removeTracking()
      },
      removeTracking: () => {
        if (operation.threadId) this.operationsByThread.delete(operation.threadId)
        if (operation.turnId) this.operationsByTurn.delete(operation.turnId)
        this.operations.delete(operation)
        this.lastActivityAt = Date.now()
        this.checkHealth()
      },
      finishActual: () => {
        if (operation.actualDone) return
        operation.actualDone = true
        clearTimeout(operation.killTimer)
        operation.killTimer = null
        operation.removeTracking()
        resolveFinished()
      },
      steer: ({ prompt, input, clientUserMessageId } = {}) => {
        const steerInput =
          input ||
          (String(prompt || '').trim()
            ? [{ type: 'text', text: String(prompt), text_elements: [] }]
            : [])
        if (!steerInput.length) {
          return Promise.reject(new Error('Steering input cannot be empty'))
        }

        const task = operation.steerTail.then(async () => {
          await operation.ready
          if (operation.done || !operation.threadId || !operation.turnId) {
            throw new Error('The active turn ended before steering could be submitted')
          }

          const expectedTurnId = operation.turnId
          const result = await this.request('turn/steer', {
            threadId: operation.threadId,
            expectedTurnId,
            input: steerInput,
            ...(clientUserMessageId ? { clientUserMessageId } : {}),
          })
          if (result?.turnId !== expectedTurnId) {
            throw new Error('App-server accepted steering for an unexpected turn')
          }
          return result
        })

        // Serialize steering messages without poisoning the chain when one
        // races with turn completion and is rejected.
        operation.steerTail = task.catch(() => {})
        return task
      },
    }

    this.operations.add(operation)
    this.lastActivityAt = Date.now()
    this.turnCount += 1

    const start = async () => {
      try {
        const opened = await this.openThread(options)
        if (operation.cancelled) {
          operation.finishActual()
          operation.finish()
          return
        }
        const threadId = opened?.thread?.id || options.threadId
        if (!threadId) throw new Error('Codex App Server did not return a thread id')
        operation.threadId = threadId
        this.operationsByThread.set(threadId, operation)
        if (!options.threadId) {
          queue.push({
            type: 'thread.started',
            thread_id: threadId,
            ...(options.forkFromThreadId ? { forked_from_id: options.forkFromThreadId } : {}),
          })
        }

        const injectedItems = []
        if (options.memorySnapshot) {
          injectedItems.push({
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: options.memorySnapshot.text }],
          })
        }
        if (options.innerBatonSnapshot) {
          injectedItems.push({
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: options.innerBatonSnapshot.text }],
          })
        }
        const hasRecentThreadContext = Boolean(
          String(options.recentThreadContext || '').trim()
        )
        if (hasRecentThreadContext) {
          injectedItems.push({
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: options.recentThreadContext }],
          })
        }
        if (injectedItems.length) {
          await this.request('thread/inject_items', {
            threadId,
            items: injectedItems,
          })
        }
        if (operation.cancelled) {
          operation.finishActual()
          operation.finish()
          return
        }
        if (options.memorySnapshot) {
          queue.push({
            type: 'memory.injected',
            thread_id: threadId,
            memory_hash: options.memorySnapshot.hash,
          })
        }
        if (options.innerBatonSnapshot) {
          queue.push({
            type: 'inner_baton.injected',
            thread_id: threadId,
            version: options.innerBatonSnapshot.version,
          })
        }
        if (hasRecentThreadContext) {
          queue.push({
            type: 'recent_context.injected',
            thread_id: threadId,
          })
        }

        const input = Array.isArray(options.input)
          ? [...options.input]
          : [{ type: 'text', text: options.prompt, text_elements: [] }]
        for (const imagePath of options.imagePaths || []) {
          input.push({ type: 'localImage', path: imagePath })
        }
        const turnParams = { threadId, input }
        if (options.workspace) turnParams.cwd = options.workspace
        if (options.model) turnParams.model = options.model
        if (options.effort) turnParams.effort = options.effort
        if (options.outputSchema) turnParams.outputSchema = options.outputSchema
        const result = await this.request('turn/start', turnParams)
        if (operation.cancelled) {
          operation.finishActual()
          operation.finish()
          return
        }
        const turnId = result?.turn?.id
        if (turnId) {
          operation.turnId = turnId
          this.operationsByTurn.set(turnId, operation)
          operation.readyResolve()
        }
      } catch (error) {
        queue.push({ type: 'error', message: error.message })
        operation.finishActual()
        operation.finish()
      }
    }

    operation.timer = setTimeout(() => {
      operation.kill()
    }, config.turnTimeoutMs)
    operation.timer.unref()
    start()

    const generator = queue
    generator.kill = () => operation.kill()
    generator.steer = (request) => operation.steer(request)
    operation.kill = () => {
      if (operation.done) return
      for (const approval of [...operation.approvals]) {
        approval.respond('cancel').catch(() => {})
      }
      if (operation.threadId && operation.turnId) {
        this.request('turn/interrupt', {
          threadId: operation.threadId,
          turnId: operation.turnId,
        }).catch(() => {})
      }
      operation.finish(false)
      operation.killTimer = setTimeout(() => {
        if (!operation.actualDone) void this.recycle('turn cancellation did not complete')
      }, config.turnCancellationGraceMs)
      operation.killTimer.unref()
    }
    operation.killAndWait = async () => {
      operation.kill()
      await finished
    }
    queue.finished = finished
    return generator
  }

  runTurn(options = {}) {
    return this.scheduler.schedule({
      priority: options.priority || 'main',
      start: () => this.runTurnNow(options),
    })
  }

  onSkillsChanged(listener) {
    if (typeof listener !== 'function') throw new Error('skills/changed listener must be a function')
    this.skillsChangedListeners.add(listener)
    return () => this.skillsChangedListeners.delete(listener)
  }

  async listSkills(workspace, { forceReload = false } = {}) {
    const result = await this.request('skills/list', {
      cwds: [workspace],
      forceReload: Boolean(forceReload),
    })
    return result?.data?.find((entry) => entry.cwd === workspace)?.skills || []
  }

  async injectItems({
    threadId,
    workspace,
    items,
    sandbox,
    model,
    effort,
  }) {
    if (!threadId) throw new Error('threadId is required')
    if (!Array.isArray(items) || !items.length) throw new Error('items are required')
    await this.openThread({ workspace, threadId, sandbox, model, effort })
    return this.request('thread/inject_items', { threadId, items })
  }

  async archiveThread(threadId) {
    if (!threadId) return
    return this.request('thread/archive', { threadId })
  }

  close() {
    if (this.child?.exitCode === null) void terminateProcessGroup(this.child)
  }
}

export function createAppServerBackend(options) {
  return new AppServerClient(options)
}

const backend = createAppServerBackend()
export default backend
