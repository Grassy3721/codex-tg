import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_USER_IDS = '1'
delete process.env.JOURNAL_COLLECTOR_ENABLED

const { config } = await import('../src/config.js')

test('external journal integration is opt-in by default', () => {
  assert.equal(config.journalCollectorEnabled, false)
})
