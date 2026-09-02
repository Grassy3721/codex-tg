import test from 'node:test'
import assert from 'node:assert/strict'

// config.js intentionally refuses to boot without an authenticated bot config.
// argv construction itself does not need real credentials.
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'

const { buildArgs } = await import('../src/backends/codexExec.js')

test('fresh turns pass model and reasoning effort to codex exec', () => {
  assert.deepEqual(
    buildArgs({
      sandbox: 'workspace-write',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    }),
    [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-',
    ]
  )
})

test('resume options precede the thread id and prompt sentinel', () => {
  assert.deepEqual(
    buildArgs({
      threadId: 'thread-123',
      sandbox: 'read-only',
      model: 'gpt-5.6-terra',
      effort: 'ultra',
    }),
    [
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="read-only"',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.6-terra',
      '-c',
      'model_reasoning_effort="ultra"',
      'thread-123',
      '-',
    ]
  )
})

test('image paths are attached before a resumed thread id', () => {
  assert.deepEqual(
    buildArgs({
      threadId: 'thread-123',
      sandbox: 'workspace-write',
      imagePaths: ['/tmp/one.png', '/tmp/two.jpg'],
    }),
    [
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      '--skip-git-repo-check',
      '--image',
      '/tmp/one.png',
      '--image',
      '/tmp/two.jpg',
      'thread-123',
      '-',
    ]
  )
})

test('empty overrides leave Codex defaults untouched', () => {
  assert.deepEqual(buildArgs({ sandbox: 'workspace-write', model: '', effort: '' }), [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '-',
  ])
})
