import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.ALLOWED_USER_IDS ||= '1'
process.env.CODE_AS_FILE_MIN_CHARS = '100'

const {
  buildTransferContext,
  collectOutboxFiles,
  createTurnDirectory,
  downloadTelegramAttachments,
  shouldSendMarkdown,
} = await import('../src/attachments.js')

test('a Telegram photo is downloaded and validated by its file header', async (t) => {
  const turn = await createTurnDirectory()
  t.after(() => fs.rm(turn.root, { recursive: true, force: true }))

  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ])
  const ctx = {
    telegram: {
      getFileLink: async () => new URL(`data:image/png;base64,${png.toString('base64')}`),
    },
  }
  const messages = [
    {
      message_id: 42,
      photo: [{ file_id: 'small' }, { file_id: 'largest', file_size: png.length }],
    },
  ]

  const files = await downloadTelegramAttachments(
    ctx,
    messages,
    turn,
    new AbortController().signal
  )
  assert.equal(files.length, 1)
  assert.equal(files[0].kind, 'image')
  assert.equal(files[0].mime, 'image/png')
  assert.match(files[0].path, /\.png$/)
  assert.equal(files[0].trust, 'untrusted_user_upload')
})

test('transfer context labels uploads as untrusted and exposes only the turn outbox', () => {
  const context = buildTransferContext(
    [
      {
        kind: 'document',
        path: '/tmp/inbox/note.md',
        mime: 'text/markdown',
        trust: 'untrusted_user_upload',
      },
    ],
    '/tmp/outbox'
  )

  assert.match(context, /untrusted_user_upload/)
  assert.match(context, /\/tmp\/inbox\/note\.md/)
  assert.match(context, /\/tmp\/outbox/)
})

test('outbox collection ignores symbolic links', async (t) => {
  const turn = await createTurnDirectory()
  t.after(() => fs.rm(turn.root, { recursive: true, force: true }))
  await fs.writeFile(`${turn.outbox}/report.txt`, 'result')
  await fs.symlink('/etc/passwd', `${turn.outbox}/escape.txt`)

  const result = await collectOutboxFiles(turn.outbox)
  assert.deepEqual(result.accepted.map((file) => file.relative), ['report.txt'])
})

test('long code-heavy replies prefer Markdown documents', () => {
  const response = `Explanation\n\n\`\`\`js\n${'const value = 1\\n'.repeat(20)}\`\`\``
  assert.equal(shouldSendMarkdown(response), true)
  assert.equal(shouldSendMarkdown('A short answer.'), false)
})
