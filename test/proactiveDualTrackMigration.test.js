import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_USER_IDS = '1'
const dbPath = `/tmp/codex-tg-dual-track-migration-${process.pid}-${Date.now()}.db`
process.env.DB_PATH = dbPath

const old = new Database(dbPath)
old.exec(`
  CREATE TABLE bridge_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
  CREATE TABLE proactive_rhythm (
    session_key TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    topic_id INTEGER,
    next_wakeup_at INTEGER NOT NULL,
    did TEXT NOT NULL,
    wakeup_reason TEXT NOT NULL,
    consecutive_fallbacks INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,
    last_external_interaction_at INTEGER,
    lease_token TEXT,
    lease_until INTEGER,
    active_slot_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    schedule_mode TEXT NOT NULL DEFAULT 'default',
    schedule_earliest_at INTEGER,
    schedule_latest_at INTEGER,
    schedule_bias TEXT,
    schedule_reason TEXT
  );
`)
const lastInteraction = Date.now() - 60_000
const appointment = Date.now() + 3 * 24 * 60 * 60_000
old.prepare(
  `INSERT INTO proactive_rhythm (
     session_key, chat_id, next_wakeup_at, did, wakeup_reason,
     generation, last_external_interaction_at, created_at, updated_at,
     schedule_mode, schedule_earliest_at, schedule_latest_at, schedule_reason
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(
  '1:0',
  1,
  appointment,
  'legacy exact appointment',
  'exact-appointment',
  7,
  lastInteraction,
  lastInteraction,
  lastInteraction,
  'exact',
  appointment,
  appointment,
  '七夕约会'
)
old.close()

const { getProactiveRhythm } = await import('../src/db.js')

test('legacy exact schedules migrate into an independent appointment track', () => {
  const rhythm = getProactiveRhythm('1:0')
  assert.equal(rhythm.exact_appointments.length, 1)
  assert.equal(rhythm.exact_appointments[0].wakeup_at, appointment)
  assert.equal(rhythm.exact_appointments[0].reason, '七夕约会')
  assert.equal(rhythm.exact_wakeup_at, appointment)
  assert.equal(rhythm.exact_reason, '七夕约会')
  assert.equal(rhythm.schedule_mode, 'default')
  assert.equal(rhythm.wakeup_reason, 'dual-track-migration')
  assert.equal(rhythm.next_wakeup_at, lastInteraction + 120 * 60_000)
  assert.equal(rhythm.generation, 8)
})
