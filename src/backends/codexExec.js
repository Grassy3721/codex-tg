import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { config } from '../config.js'

const STDERR_KEEP = 4000

/**
 * Build argv for `codex exec`. Kept separate from spawning so both the fresh
 * and resume forms can be checked without starting a real Codex turn.
 */
export function buildArgs({ threadId, sandbox, model, effort, imagePaths = [] }) {
  const mode = sandbox || config.sandbox
  const args = ['exec']

  // `exec` and `exec resume` do NOT take the same flags. Usage is
  //   codex exec [OPTIONS] [PROMPT]
  //   codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
  // and `resume` has no `--sandbox` of its own, so the mode has to go through
  // the generic `-c` config override. Options must precede the session id.
  if (threadId) {
    args.push('resume', '--json', '-c', `sandbox_mode="${mode}"`, '--skip-git-repo-check')
    if (model) args.push('--model', model)
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
    for (const imagePath of imagePaths) args.push('--image', imagePath)
    args.push(threadId)
  } else {
    args.push('--json', '--sandbox', mode, '--skip-git-repo-check')
    if (model) args.push('--model', model)
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
    for (const imagePath of imagePaths) args.push('--image', imagePath)
  }

  args.push('-')
  return args
}

/**
 * Run one Codex turn via `codex exec --json`.
 *
 * The prompt goes over stdin (the `-` sentinel) rather than as an argv element.
 * That sidesteps shell quoting entirely and removes any length ceiling — worth
 * doing since Telegram messages can contain anything.
 *
 * Returns an async generator with an extra `.kill()` method.
 */
export function runTurn({ workspace, threadId, prompt, sandbox, model, effort, imagePaths }) {
  const args = buildArgs({ threadId, sandbox, model, effort, imagePaths })

  const child = spawn(config.codexBin, args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP)
  })

  child.stdin.on('error', () => {}) // EPIPE if codex dies before reading
  child.stdin.end(prompt, 'utf8')

  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }, config.turnTimeoutMs)
  timer.unref()

  async function* iterate() {
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    let sawTerminal = false

    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let event
        try {
          event = JSON.parse(trimmed)
        } catch {
          // Codex writes progress to stderr, so stdout should be pure JSONL.
          // A non-JSON line means something unexpected — surface it rather than
          // silently dropping it.
          yield { type: 'error', message: `Unparseable stdout line: ${trimmed.slice(0, 200)}` }
          continue
        }

        if (event.type === 'turn.completed' || event.type === 'turn.failed') sawTerminal = true
        yield event
      }

      const code = await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode)
        child.once('close', resolve)
      })

      if (!sawTerminal) {
        yield {
          type: 'error',
          message:
            `codex exited with code ${code} without completing the turn.` +
            (stderr ? `\n\n${stderr.trim()}` : ''),
        }
      }
    } finally {
      clearTimeout(timer)
      rl.close()
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }

  const gen = iterate()
  gen.kill = () => {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 3000).unref()
  }
  return gen
}

export default { runTurn }
