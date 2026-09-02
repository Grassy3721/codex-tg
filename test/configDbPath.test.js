import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_USER_IDS = '1'
process.env.DB_PATH = './data/foreign-cwd.db'

test('relative DB_PATH resolves against the repository root from a foreign cwd', async (t) => {
  const foreignCwd = await mkdtemp(path.join(os.tmpdir(), 'codex-db-cwd-'))
  const originalCwd = process.cwd()
  t.after(async () => {
    process.chdir(originalCwd)
    await rm(foreignCwd, { recursive: true, force: true })
  })
  process.chdir(foreignCwd)

  const { config, REPOSITORY_ROOT } = await import('../src/config.js')
  assert.equal(config.dbPath, path.join(REPOSITORY_ROOT, 'data', 'foreign-cwd.db'))
  assert.notEqual(path.dirname(config.dbPath), path.join(foreignCwd, 'data'))
})
