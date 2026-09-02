import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

export const PROACTIVE_EXACT_APPOINTMENT_LIMIT = 3

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })

const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    key                TEXT PRIMARY KEY,   -- "<chatId>:<topicId>"
    thread_id          TEXT,               -- codex thread/session id, null = next turn starts fresh
    workspace          TEXT NOT NULL,
    model              TEXT,               -- null = use CODEX_MODEL / Codex default
    effort             TEXT,               -- null = use CODEX_REASONING_EFFORT / Codex default
    turn_count         INTEGER NOT NULL DEFAULT 0,
    context_message_id INTEGER NOT NULL DEFAULT 0,
    thread_started_at  INTEGER NOT NULL,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS thread_history (
    session_key  TEXT NOT NULL,
    thread_id    TEXT NOT NULL,
    workspace    TEXT NOT NULL,
    preview      TEXT,
    turn_count   INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY (session_key, thread_id)
  );

  CREATE INDEX IF NOT EXISTS thread_history_recent
    ON thread_history(session_key, last_used_at DESC);

  CREATE TABLE IF NOT EXISTS restart_notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      INTEGER NOT NULL,
    topic_id     INTEGER,
    requested_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key  TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    processed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS memory_events_pending
    ON memory_events(processed_at, id);

  CREATE TABLE IF NOT EXISTS thread_memory_state (
    thread_id    TEXT PRIMARY KEY,
    memory_hash  TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id           TEXT NOT NULL UNIQUE,
    session_key         TEXT NOT NULL,
    chat_id             INTEGER,
    topic_id            INTEGER,
    telegram_message_id INTEGER,
    conversation_turn_id TEXT,
    role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content             TEXT NOT NULL,
    sent_at             INTEGER NOT NULL,
    created_at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS conversation_messages_window
    ON conversation_messages(sent_at, id);

  CREATE TABLE IF NOT EXISTS thread_carryovers (
    session_key     TEXT PRIMARY KEY,
    source_thread_id TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS journal_collector_runs (
    task_name         TEXT NOT NULL,
    target_date       TEXT NOT NULL,
    window_start      INTEGER NOT NULL,
    window_end        INTEGER NOT NULL,
    first_message_id  INTEGER,
    last_message_id   INTEGER,
    message_count     INTEGER NOT NULL DEFAULT 0,
    message_hash      TEXT NOT NULL,
    event_count       INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    error             TEXT,
    started_at        INTEGER NOT NULL,
    completed_at      INTEGER,
    PRIMARY KEY (task_name, target_date)
  );

  CREATE TABLE IF NOT EXISTS journal_collector_events (
    task_name       TEXT NOT NULL,
    target_date     TEXT NOT NULL,
    event_hash      TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags_json       TEXT NOT NULL,
    evidence_json   TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'written', 'failed')),
    error           TEXT,
    created_at      INTEGER NOT NULL,
    written_at      INTEGER,
    PRIMARY KEY (task_name, target_date, event_hash)
  );

  CREATE TABLE IF NOT EXISTS bridge_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS proactive_wakes (
    slot_key     TEXT PRIMARY KEY,
    session_key  TEXT NOT NULL,
    chat_id      INTEGER NOT NULL,
    topic_id     INTEGER,
    exact_appointment_id INTEGER,
    status       TEXT NOT NULL CHECK (
      status IN ('running', 'sent', 'silent', 'interrupted', 'failed')
    ),
    message_id   INTEGER,
    error        TEXT,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS proactive_rhythm (
    session_key                 TEXT PRIMARY KEY,
    chat_id                     INTEGER NOT NULL,
    topic_id                    INTEGER,
    next_wakeup_at              INTEGER NOT NULL,
    did                         TEXT NOT NULL,
    wakeup_reason               TEXT NOT NULL,
    consecutive_fallbacks       INTEGER NOT NULL DEFAULT 0,
    generation                  INTEGER NOT NULL DEFAULT 0,
    last_external_interaction_at INTEGER,
    lease_token                 TEXT,
    lease_until                 INTEGER,
    active_slot_key             TEXT,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS proactive_rhythm_due
    ON proactive_rhythm(next_wakeup_at, lease_until);

  CREATE TABLE IF NOT EXISTS proactive_exact_appointments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    wakeup_at   INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (session_key, wakeup_at)
  );

  CREATE INDEX IF NOT EXISTS proactive_exact_appointments_due
    ON proactive_exact_appointments(session_key, wakeup_at, id);

  CREATE TABLE IF NOT EXISTS skill_episodes (
    session_key      TEXT PRIMARY KEY,
    skill_name       TEXT NOT NULL,
    skill_path       TEXT NOT NULL,
    parent_thread_id TEXT,
    worker_thread_id TEXT NOT NULL,
    needs_reload     INTEGER NOT NULL DEFAULT 0,
    started_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inner_batons (
    session_key      TEXT PRIMARY KEY,
    state_json       TEXT NOT NULL,
    version          INTEGER NOT NULL DEFAULT 0,
    source_thread_id TEXT,
    source_turn_id   TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inner_baton_thread_state (
    thread_id    TEXT PRIMARY KEY,
    session_key  TEXT NOT NULL,
    version      INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
`)

// Preserve the useful conversation history already collected by the older
// long-term-memory reviewer. These rows have synthetic evidence ids because
// that table predates Telegram message-id capture.
db.exec(`
  INSERT OR IGNORE INTO conversation_messages (
    source_id, session_key, role, content, sent_at, created_at
  )
  SELECT
    'bridge-memory:' || id,
    session_key,
    role,
    content,
    created_at,
    created_at
  FROM memory_events
  WHERE NOT EXISTS (
    SELECT 1 FROM bridge_migrations
    WHERE name = 'conversation-messages-memory-events-v1'
  );

  INSERT OR IGNORE INTO bridge_migrations (name, applied_at)
  VALUES ('conversation-messages-memory-events-v1', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
`)

// Existing installs predate per-session model settings. SQLite has no
// `ADD COLUMN IF NOT EXISTS`, so inspect the schema before migrating.
const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name))
if (!columns.has('model')) db.exec('ALTER TABLE sessions ADD COLUMN model TEXT')
if (!columns.has('effort')) db.exec('ALTER TABLE sessions ADD COLUMN effort TEXT')
if (!columns.has('context_message_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN context_message_id INTEGER NOT NULL DEFAULT 0')
}
if (!columns.has('thread_started_at')) {
  db.exec('ALTER TABLE sessions ADD COLUMN thread_started_at INTEGER')
  db.exec(`
    UPDATE sessions
    SET thread_started_at = COALESCE(updated_at, created_at)
    WHERE thread_started_at IS NULL
  `)
}

const conversationColumns = new Set(
  db.prepare('PRAGMA table_info(conversation_messages)').all().map((column) => column.name)
)
if (!conversationColumns.has('conversation_turn_id')) {
  db.exec('ALTER TABLE conversation_messages ADD COLUMN conversation_turn_id TEXT')
}
db.exec(`
  CREATE INDEX IF NOT EXISTS conversation_messages_turn
  ON conversation_messages(session_key, conversation_turn_id, id)
`)

const proactiveRhythmColumns = new Set(
  db.prepare('PRAGMA table_info(proactive_rhythm)').all().map((column) => column.name)
)
if (!proactiveRhythmColumns.has('schedule_mode')) {
  db.exec("ALTER TABLE proactive_rhythm ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'default'")
}
if (!proactiveRhythmColumns.has('schedule_earliest_at')) {
  db.exec('ALTER TABLE proactive_rhythm ADD COLUMN schedule_earliest_at INTEGER')
}
if (!proactiveRhythmColumns.has('schedule_latest_at')) {
  db.exec('ALTER TABLE proactive_rhythm ADD COLUMN schedule_latest_at INTEGER')
}
if (!proactiveRhythmColumns.has('schedule_bias')) {
  db.exec('ALTER TABLE proactive_rhythm ADD COLUMN schedule_bias TEXT')
}
if (!proactiveRhythmColumns.has('schedule_reason')) {
  db.exec('ALTER TABLE proactive_rhythm ADD COLUMN schedule_reason TEXT')
}
if (!proactiveRhythmColumns.has('exact_wakeup_at')) {
  db.exec('ALTER TABLE proactive_rhythm ADD COLUMN exact_wakeup_at INTEGER')
}
if (!proactiveRhythmColumns.has('exact_reason')) {
  db.exec('ALTER TABLE proactive_rhythm ADD COLUMN exact_reason TEXT')
}

const proactiveWakeColumns = new Set(
  db.prepare('PRAGMA table_info(proactive_wakes)').all().map((column) => column.name)
)
if (!proactiveWakeColumns.has('exact_appointment_id')) {
  db.exec('ALTER TABLE proactive_wakes ADD COLUMN exact_appointment_id INTEGER')
}

// Exact appointments used to replace the ordinary adaptive rhythm. Preserve
// those appointments, but restore a separate flexible track so a promise days
// in the future cannot silence every spontaneous wake until then.
const dualTrackMigration = db.prepare(
  "SELECT 1 FROM bridge_migrations WHERE name = 'proactive-rhythm-dual-track-v1'"
).get()
if (!dualTrackMigration) {
  const migrationNow = Date.now()
  db.transaction(() => {
    db.prepare(
      `UPDATE proactive_rhythm
       SET exact_wakeup_at = next_wakeup_at,
           exact_reason = schedule_reason,
           next_wakeup_at = MAX(
             COALESCE(last_external_interaction_at, @now) + 7200000,
             @now + 600000
           ),
           wakeup_reason = 'dual-track-migration',
           schedule_mode = 'default',
           schedule_earliest_at = NULL,
           schedule_latest_at = NULL,
           schedule_bias = NULL,
           schedule_reason = NULL,
           generation = generation + 1,
           lease_token = NULL,
           lease_until = NULL,
           active_slot_key = NULL,
           updated_at = @now
       WHERE schedule_mode = 'exact'
         AND exact_wakeup_at IS NULL`
    ).run({ now: migrationNow })
    db.prepare(
      `INSERT INTO bridge_migrations (name, applied_at)
       VALUES ('proactive-rhythm-dual-track-v1', ?)`
    ).run(migrationNow)
  })()
}

// Move the legacy single exact slot into a small appointment queue. Keeping
// appointments in their own rows makes ordering and one-at-a-time consumption
// explicit while preserving the independent flexible rhythm.
const exactQueueMigration = db.prepare(
  "SELECT 1 FROM bridge_migrations WHERE name = 'proactive-exact-queue-v1'"
).get()
if (!exactQueueMigration) {
  const migrationNow = Date.now()
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO proactive_exact_appointments (
         session_key, wakeup_at, reason, created_at, updated_at
       )
       SELECT session_key, exact_wakeup_at,
              COALESCE(exact_reason, '已经明确约好的返回时间'),
              @now, @now
       FROM proactive_rhythm
       WHERE exact_wakeup_at IS NOT NULL`
    ).run({ now: migrationNow })
    db.prepare(
      `UPDATE proactive_rhythm
       SET exact_wakeup_at = NULL,
           exact_reason = NULL
       WHERE exact_wakeup_at IS NOT NULL`
    ).run()
    db.prepare(
      `INSERT INTO bridge_migrations (name, applied_at)
       VALUES ('proactive-exact-queue-v1', ?)`
    ).run(migrationNow)
  })()
}

const stmt = {
  get: db.prepare('SELECT * FROM sessions WHERE key = ?'),
  insert: db.prepare(
    `INSERT INTO sessions (
       key, thread_id, workspace, turn_count, context_message_id,
       thread_started_at, created_at, updated_at
     ) VALUES (
       @key, NULL, @workspace, 0, @contextMessageId,
       @now, @now, @now
     )`
  ),
  setThread: db.prepare(
    'UPDATE sessions SET thread_id = ?, turn_count = turn_count + 1, updated_at = ? WHERE key = ?'
  ),
  bumpTurn: db.prepare(
    'UPDATE sessions SET turn_count = turn_count + 1, updated_at = ? WHERE key = ?'
  ),
  setWorkspace: db.prepare(
    `UPDATE sessions
     SET workspace = ?, thread_id = NULL, turn_count = 0,
         context_message_id = ?, thread_started_at = ?, updated_at = ?
     WHERE key = ?`
  ),
  reset: db.prepare(
    `UPDATE sessions
     SET thread_id = NULL, turn_count = 0,
         context_message_id = ?, thread_started_at = ?, updated_at = ?
     WHERE key = ?`
  ),
  maxConversationMessageId: db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS id FROM conversation_messages WHERE session_key = ?'
  ),
  firstConversationPreview: db.prepare(
    `SELECT content
     FROM conversation_messages
     WHERE session_key = ? AND role = 'user' AND id > ?
     ORDER BY id
     LIMIT 1`
  ),
  upsertThreadHistory: db.prepare(
    `INSERT INTO thread_history (
       session_key, thread_id, workspace, preview, turn_count,
       first_seen_at, last_used_at
     ) VALUES (
       @sessionKey, @threadId, @workspace, @preview, @turnCount,
       @firstSeenAt, @lastUsedAt
     )
     ON CONFLICT(session_key, thread_id) DO UPDATE SET
       workspace = excluded.workspace,
       preview = CASE
         WHEN thread_history.preview IS NULL OR thread_history.preview = ''
         THEN excluded.preview
         ELSE thread_history.preview
       END,
       turn_count = excluded.turn_count,
       first_seen_at = MIN(thread_history.first_seen_at, excluded.first_seen_at),
       last_used_at = excluded.last_used_at`
  ),
  listThreadHistory: db.prepare(
    `SELECT session_key, thread_id, workspace, preview, turn_count,
            first_seen_at, last_used_at
     FROM thread_history
     WHERE session_key = ? AND (? IS NULL OR thread_id != ?)
     ORDER BY last_used_at DESC, thread_id`
  ),
  getThreadHistory: db.prepare(
    `SELECT session_key, thread_id, workspace, preview, turn_count,
            first_seen_at, last_used_at
     FROM thread_history
     WHERE session_key = ? AND thread_id = ?`
  ),
  resumeThread: db.prepare(
    `UPDATE sessions
     SET thread_id = ?, workspace = ?, turn_count = ?,
         context_message_id = ?, thread_started_at = ?,
         updated_at = ?
     WHERE key = ?`
  ),
  touchThreadHistory: db.prepare(
    `UPDATE thread_history SET last_used_at = ?
     WHERE session_key = ? AND thread_id = ?`
  ),
  setModel: db.prepare('UPDATE sessions SET model = ?, updated_at = ? WHERE key = ?'),
  setEffort: db.prepare('UPDATE sessions SET effort = ?, updated_at = ? WHERE key = ?'),
  queueRestart: db.prepare(
    'INSERT INTO restart_notifications (chat_id, topic_id, requested_at) VALUES (?, ?, ?)'
  ),
  listRestarts: db.prepare(
    'SELECT id, chat_id, topic_id, requested_at FROM restart_notifications ORDER BY id'
  ),
  deleteRestart: db.prepare('DELETE FROM restart_notifications WHERE id = ?'),
  addMemoryEvent: db.prepare(
    'INSERT INTO memory_events (session_key, role, content, created_at) VALUES (?, ?, ?, ?)'
  ),
  countPendingMemoryUsers: db.prepare(
    `SELECT COUNT(*) AS count FROM memory_events
     WHERE processed_at IS NULL AND role = 'user'`
  ),
  listPendingMemoryEvents: db.prepare(
    `SELECT id, session_key, role, content, created_at
     FROM memory_events
     WHERE processed_at IS NULL
     ORDER BY id
     LIMIT ?`
  ),
  markMemoryEventsProcessed: db.prepare(
    `UPDATE memory_events SET processed_at = ?
     WHERE id = ? AND processed_at IS NULL`
  ),
  getThreadMemoryHash: db.prepare(
    'SELECT memory_hash FROM thread_memory_state WHERE thread_id = ?'
  ),
  setThreadMemoryHash: db.prepare(
    `INSERT INTO thread_memory_state (thread_id, memory_hash, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       memory_hash = excluded.memory_hash,
       updated_at = excluded.updated_at`
  ),
  clearThreadMemoryHash: db.prepare(
    'DELETE FROM thread_memory_state WHERE thread_id = ?'
  ),
  addConversationMessage: db.prepare(
    `INSERT OR IGNORE INTO conversation_messages (
       source_id, session_key, chat_id, topic_id, telegram_message_id,
       conversation_turn_id, role, content, sent_at, created_at
     ) VALUES (
       @sourceId, @sessionKey, @chatId, @topicId, @telegramMessageId,
       @conversationTurnId, @role, @content, @sentAt, @createdAt
     )`
  ),
  assignConversationMessageTurn: db.prepare(
    `UPDATE conversation_messages
     SET conversation_turn_id = COALESCE(conversation_turn_id, ?)
     WHERE source_id = ?`
  ),
  listConversationMessages: db.prepare(
    `SELECT id, source_id, session_key, chat_id, topic_id, telegram_message_id,
            role, content, sent_at
     FROM conversation_messages
     WHERE sent_at >= ? AND sent_at < ?
     ORDER BY sent_at, id`
  ),
  listRecentConversationMessages: db.prepare(
    `SELECT role, content, sent_at
     FROM conversation_messages
     WHERE session_key = ? AND id > ?
     ORDER BY sent_at DESC, id DESC
     LIMIT ?`
  ),
  listRecentUserMessages: db.prepare(
    `SELECT role, content, sent_at, telegram_message_id
     FROM conversation_messages
     WHERE session_key = ?
       AND id > ?
       AND role = 'user'
       AND sent_at >= ?
     ORDER BY sent_at DESC, id DESC
     LIMIT ?`
  ),
  listCurrentThreadTail: db.prepare(
    `WITH user_rows AS (
       SELECT id,
              COALESCE(conversation_turn_id, 'legacy:' || id) AS turn_key
       FROM conversation_messages
       WHERE session_key = @sessionKey
         AND id > @afterId
         AND role = 'user'
     ),
     recent_user_turns AS (
       SELECT turn_key, MIN(id) AS first_id, MAX(id) AS last_id
       FROM user_rows
       GROUP BY turn_key
       ORDER BY last_id DESC
       LIMIT @userTurns
     )
     SELECT role, content, sent_at, conversation_turn_id
     FROM conversation_messages
     WHERE session_key = @sessionKey
       AND id > @afterId
       AND id >= (SELECT MIN(first_id) FROM recent_user_turns)
     ORDER BY id`
  ),
  saveThreadCarryover: db.prepare(
    `INSERT INTO thread_carryovers (
       session_key, source_thread_id, content, created_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET
       source_thread_id = excluded.source_thread_id,
       content = excluded.content,
       created_at = excluded.created_at`
  ),
  getThreadCarryover: db.prepare(
    `SELECT session_key, source_thread_id, content, created_at
     FROM thread_carryovers WHERE session_key = ?`
  ),
  clearThreadCarryover: db.prepare(
    'DELETE FROM thread_carryovers WHERE session_key = ?'
  ),
  getJournalRun: db.prepare(
    `SELECT * FROM journal_collector_runs
     WHERE task_name = ? AND target_date = ?`
  ),
  upsertJournalRun: db.prepare(
    `INSERT INTO journal_collector_runs (
       task_name, target_date, window_start, window_end,
       first_message_id, last_message_id, message_count, message_hash,
       event_count, status, error, started_at, completed_at
     ) VALUES (
       @taskName, @targetDate, @windowStart, @windowEnd,
       @firstMessageId, @lastMessageId, @messageCount, @messageHash,
       @eventCount, @status, @error, @startedAt, @completedAt
     )
     ON CONFLICT(task_name, target_date) DO UPDATE SET
       window_start = excluded.window_start,
       window_end = excluded.window_end,
       first_message_id = excluded.first_message_id,
       last_message_id = excluded.last_message_id,
       message_count = excluded.message_count,
       message_hash = excluded.message_hash,
       event_count = excluded.event_count,
       status = excluded.status,
       error = excluded.error,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at`
  ),
  getJournalEvent: db.prepare(
    `SELECT * FROM journal_collector_events
     WHERE task_name = ? AND target_date = ? AND event_hash = ?`
  ),
  upsertJournalEvent: db.prepare(
    `INSERT INTO journal_collector_events (
       task_name, target_date, event_hash, content, tags_json,
       evidence_json, status, error, created_at, written_at
     ) VALUES (
       @taskName, @targetDate, @eventHash, @content, @tagsJson,
       @evidenceJson, @status, @error, @createdAt, @writtenAt
     )
     ON CONFLICT(task_name, target_date, event_hash) DO UPDATE SET
       content = excluded.content,
       tags_json = excluded.tags_json,
       evidence_json = excluded.evidence_json,
       status = excluded.status,
       error = excluded.error,
       written_at = excluded.written_at`
  ),
  claimProactiveWake: db.prepare(
    `INSERT OR IGNORE INTO proactive_wakes (
       slot_key, session_key, chat_id, topic_id, exact_appointment_id,
       status, started_at
     ) VALUES (?, ?, ?, ?, ?, 'running', ?)`
  ),
  finishProactiveWake: db.prepare(
    `UPDATE proactive_wakes
     SET status = ?, message_id = ?, error = ?, completed_at = ?
     WHERE slot_key = ?`
  ),
  getProactiveRhythm: db.prepare(
    'SELECT * FROM proactive_rhythm WHERE session_key = ?'
  ),
  listExactAppointments: db.prepare(
    `SELECT id, wakeup_at, reason, created_at, updated_at
     FROM proactive_exact_appointments
     WHERE session_key = ?
     ORDER BY wakeup_at, id`
  ),
  insertExactAppointment: db.prepare(
    `INSERT INTO proactive_exact_appointments (
       session_key, wakeup_at, reason, created_at, updated_at
     ) VALUES (
       @sessionKey, @nextWakeupAt, @scheduleReason, @now, @now
     )
     ON CONFLICT(session_key, wakeup_at) DO UPDATE SET
       reason = excluded.reason,
       updated_at = excluded.updated_at`
  ),
  deleteExactAppointment: db.prepare(
    'DELETE FROM proactive_exact_appointments WHERE session_key = ? AND id = ?'
  ),
  deleteClaimedExactAppointment: db.prepare(
    `DELETE FROM proactive_exact_appointments
     WHERE @wakeKind = 'exact'
       AND session_key = @sessionKey
       AND id = (
         SELECT exact_appointment_id
         FROM proactive_wakes
         WHERE slot_key = @slotKey
       )`
  ),
  ensureProactiveRhythm: db.prepare(
    `INSERT OR IGNORE INTO proactive_rhythm (
       session_key, chat_id, topic_id, next_wakeup_at, did, wakeup_reason,
       consecutive_fallbacks, generation, created_at, updated_at
     ) VALUES (
       @sessionKey, @chatId, @topicId, @nextWakeupAt, @did, @wakeupReason,
       0, 0, @now, @now
     )`
  ),
  claimProactiveRhythm: db.prepare(
    `UPDATE proactive_rhythm
     SET lease_token = @leaseToken,
         lease_until = @leaseUntil,
         active_slot_key = @slotKey,
         updated_at = @now
     WHERE session_key = @sessionKey
       AND generation = @generation
       AND (
         (
           @wakeKind = 'exact'
           AND EXISTS (
             SELECT 1
             FROM proactive_exact_appointments
             WHERE session_key = @sessionKey
               AND id = @dueAppointmentId
               AND wakeup_at = @dueWakeupAt
           )
         )
         OR (
           @wakeKind = 'flexible'
           AND next_wakeup_at = @dueWakeupAt
           AND NOT EXISTS (
             SELECT 1
             FROM proactive_exact_appointments
             WHERE session_key = @sessionKey
               AND wakeup_at <= @dueWakeupAt
           )
         )
       )
       AND @dueWakeupAt <= @now
       AND (lease_until IS NULL OR lease_until <= @now)`
  ),
  renewProactiveRhythmLease: db.prepare(
    `UPDATE proactive_rhythm
     SET lease_until = @leaseUntil,
         updated_at = @now
     WHERE session_key = @sessionKey
       AND generation = @generation
       AND lease_token = @leaseToken
       AND active_slot_key = @slotKey`
  ),
  completeProactiveRhythm: db.prepare(
    `UPDATE proactive_rhythm
     SET next_wakeup_at = @nextWakeupAt,
         did = @did,
         wakeup_reason = @wakeupReason,
         schedule_mode = @scheduleMode,
         schedule_earliest_at = @scheduleEarliestAt,
         schedule_latest_at = @scheduleLatestAt,
         schedule_bias = @scheduleBias,
         schedule_reason = @scheduleReason,
         consecutive_fallbacks = CASE
           WHEN @usedFallback THEN consecutive_fallbacks + 1
           ELSE 0
         END,
         generation = generation + 1,
         lease_token = NULL,
         lease_until = NULL,
         active_slot_key = NULL,
         updated_at = @now
     WHERE session_key = @sessionKey AND lease_token = @leaseToken`
  ),
  setProactiveSchedule: db.prepare(
    `UPDATE proactive_rhythm
     SET next_wakeup_at = @nextWakeupAt,
         wakeup_reason = @wakeupReason,
         schedule_mode = @scheduleMode,
         schedule_earliest_at = @scheduleEarliestAt,
         schedule_latest_at = @scheduleLatestAt,
         schedule_bias = @scheduleBias,
         schedule_reason = @scheduleReason,
         generation = generation + 1,
         lease_token = NULL,
         lease_until = NULL,
         active_slot_key = NULL,
         updated_at = @now
     WHERE session_key = @sessionKey
       AND generation = @generation
       AND (lease_until IS NULL OR lease_until <= @now)`
  ),
  touchExactProactiveSchedule: db.prepare(
    `UPDATE proactive_rhythm
     SET generation = generation + 1,
         lease_token = NULL,
         lease_until = NULL,
         active_slot_key = NULL,
         updated_at = @now
     WHERE session_key = @sessionKey
       AND generation = @generation
       AND (lease_until IS NULL OR lease_until <= @now)`
  ),
  releaseExactProactiveSchedule: db.prepare(
    `UPDATE proactive_rhythm
     SET next_wakeup_at = @nextWakeupAt,
         wakeup_reason = @wakeupReason,
         schedule_mode = @scheduleMode,
         schedule_earliest_at = @scheduleEarliestAt,
         schedule_latest_at = @scheduleLatestAt,
         schedule_bias = @scheduleBias,
         schedule_reason = @scheduleReason,
         generation = generation + 1,
         lease_token = NULL,
         lease_until = NULL,
         active_slot_key = NULL,
         updated_at = @now
     WHERE session_key = @sessionKey
       AND generation = @generation
       AND (lease_until IS NULL OR lease_until <= @now)`
  ),
  noteProactiveInteraction: db.prepare(
    `UPDATE proactive_rhythm
     SET last_external_interaction_at = CASE
           WHEN last_external_interaction_at IS NULL
             OR last_external_interaction_at < @interactionAt
           THEN @interactionAt
           ELSE last_external_interaction_at
         END,
         next_wakeup_at = CASE
           WHEN schedule_mode = 'default' AND next_wakeup_at < @deferUntil
           THEN @deferUntil
           ELSE next_wakeup_at
         END,
         wakeup_reason = CASE
           WHEN schedule_mode = 'default' AND next_wakeup_at < @deferUntil
           THEN 'external-interaction'
           ELSE wakeup_reason
         END,
         generation = generation + 1,
         lease_token = NULL,
         lease_until = NULL,
         active_slot_key = NULL,
         updated_at = @now
     WHERE session_key = @sessionKey
       AND (lease_until IS NULL OR lease_until <= @now)`
  ),
  getSkillEpisode: db.prepare(
    'SELECT * FROM skill_episodes WHERE session_key = ?'
  ),
  upsertSkillEpisode: db.prepare(
    `INSERT INTO skill_episodes (
       session_key, skill_name, skill_path, parent_thread_id,
       worker_thread_id, needs_reload, started_at, updated_at
     ) VALUES (
       @sessionKey, @skillName, @skillPath, @parentThreadId,
       @workerThreadId, @needsReload, @now, @now
     )
     ON CONFLICT(session_key) DO UPDATE SET
       skill_name = excluded.skill_name,
       skill_path = excluded.skill_path,
       parent_thread_id = excluded.parent_thread_id,
       worker_thread_id = excluded.worker_thread_id,
       needs_reload = excluded.needs_reload,
       started_at = excluded.started_at,
       updated_at = excluded.updated_at`
  ),
  touchSkillEpisode: db.prepare(
    `UPDATE skill_episodes
     SET needs_reload = CASE WHEN ? THEN 0 ELSE needs_reload END,
         updated_at = ?
     WHERE session_key = ?`
  ),
  markSkillEpisodeReload: db.prepare(
    'UPDATE skill_episodes SET needs_reload = 1, updated_at = ? WHERE session_key = ?'
  ),
  markAllSkillEpisodesReload: db.prepare(
    'UPDATE skill_episodes SET needs_reload = 1, updated_at = ?'
  ),
  deleteSkillEpisode: db.prepare(
    'DELETE FROM skill_episodes WHERE session_key = ?'
  ),
  getInnerBaton: db.prepare(
    'SELECT * FROM inner_batons WHERE session_key = ?'
  ),
  ensureInnerBaton: db.prepare(
    `INSERT OR IGNORE INTO inner_batons (
       session_key, state_json, version, created_at, updated_at
     ) VALUES (?, '{"locked":[],"pending":[],"private":[],"next":null}', 0, ?, ?)`
  ),
  updateInnerBaton: db.prepare(
    `UPDATE inner_batons
     SET state_json = ?, version = ?, source_thread_id = ?, source_turn_id = ?, updated_at = ?
     WHERE session_key = ? AND version = ?`
  ),
  getThreadInnerBatonVersion: db.prepare(
    'SELECT version FROM inner_baton_thread_state WHERE thread_id = ?'
  ),
  setThreadInnerBatonVersion: db.prepare(
    `INSERT INTO inner_baton_thread_state (thread_id, session_key, version, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       session_key = excluded.session_key,
       version = excluded.version,
       updated_at = excluded.updated_at`
  ),
  clearThreadInnerBatonVersion: db.prepare(
    'DELETE FROM inner_baton_thread_state WHERE thread_id = ?'
  ),
}

const compareAndSetInnerBatonTx = db.transaction(
  ({ sessionKey: key, expectedVersion, stateJson, sourceThreadId, sourceTurnId, now }) => {
    stmt.ensureInnerBaton.run(key, now, now)
    const current = stmt.getInnerBaton.get(key)
    if (Number(current.version) !== expectedVersion) {
      return { ok: false, record: current }
    }
    const nextVersion = expectedVersion + 1
    const changed = stmt.updateInnerBaton.run(
      stateJson,
      nextVersion,
      sourceThreadId,
      sourceTurnId,
      now,
      key,
      expectedVersion
    ).changes
    if (changed !== 1) return { ok: false, record: stmt.getInnerBaton.get(key) }
    return { ok: true, record: stmt.getInnerBaton.get(key) }
  }
)

function hydrateProactiveRhythm(rhythm) {
  if (!rhythm) return null
  const appointments = stmt.listExactAppointments.all(String(rhythm.session_key))
  const first = appointments[0] || null
  return {
    ...rhythm,
    exact_appointments: appointments,
    // Keep the earliest appointment mirrored in the old public fields so
    // callers and injected state from the single-slot version remain legible.
    exact_wakeup_at: first?.wakeup_at ?? null,
    exact_reason: first?.reason ?? null,
  }
}

function loadProactiveRhythm(key) {
  return hydrateProactiveRhythm(stmt.getProactiveRhythm.get(String(key)) || null)
}

export function getNextProactiveWake(rhythm) {
  if (!rhythm) return null
  const flexibleAt = Number(rhythm.next_wakeup_at)
  const appointment = Array.isArray(rhythm.exact_appointments)
    ? rhythm.exact_appointments[0]
    : rhythm.exact_wakeup_at == null
      ? null
      : {
          id: null,
          wakeup_at: rhythm.exact_wakeup_at,
          reason: rhythm.exact_reason,
        }
  const exactAt = appointment == null
    ? Number.POSITIVE_INFINITY
    : Number(appointment.wakeup_at)
  if (Number.isFinite(exactAt) && exactAt <= flexibleAt) {
    return {
      kind: 'exact',
      at: exactAt,
      appointmentId: appointment.id == null ? null : Number(appointment.id),
      reason: appointment.reason || null,
    }
  }
  return Number.isFinite(flexibleAt) ? { kind: 'flexible', at: flexibleAt } : null
}

const claimDueProactiveWakeTx = db.transaction(
  ({ sessionKey: key, now, leaseMs }) => {
    const state = loadProactiveRhythm(key)
    const due = getNextProactiveWake(state)
    if (!due || due.at > now) return null
    if (state.lease_until != null && Number(state.lease_until) > now) return null

    if (state.active_slot_key) {
      stmt.finishProactiveWake.run(
        'failed',
        null,
        'Proactive wake lease expired before completion',
        now,
        state.active_slot_key
      )
    }

    const leaseToken = crypto.randomUUID()
    const slotKey = [
      'rhythm',
      encodeURIComponent(key),
      Number(state.generation) || 0,
      due.kind,
      due.at,
      leaseToken,
    ].join(':')
    const claimed = stmt.claimProactiveRhythm.run({
      sessionKey: key,
      generation: Number(state.generation) || 0,
      wakeKind: due.kind,
      dueWakeupAt: due.at,
      dueAppointmentId: due.appointmentId ?? null,
      leaseToken,
      leaseUntil: now + leaseMs,
      slotKey,
      now,
    }).changes
    if (!claimed) return null

    stmt.claimProactiveWake.run(
      slotKey,
      key,
      Number(state.chat_id),
      state.topic_id == null ? null : Number(state.topic_id),
      due.appointmentId ?? null,
      now
    )
    return {
      ...state,
      next_wakeup_at: due.at,
      wakeup_reason: due.kind === 'exact' ? 'exact-appointment' : state.wakeup_reason,
      schedule_mode: due.kind === 'exact' ? 'exact' : state.schedule_mode,
      schedule_reason: due.kind === 'exact' ? due.reason : state.schedule_reason,
      wake_kind: due.kind,
      exact_appointment_id: due.appointmentId,
      slot_key: slotKey,
      lease_token: leaseToken,
      lease_until: now + leaseMs,
    }
  }
)

const setProactiveScheduleTx = db.transaction(
  ({ sessionKey: key, schedule, now }) => {
    const state = loadProactiveRhythm(key)
    if (!state) return { status: 'missing', rhythm: null }
    if (state.lease_until != null && Number(state.lease_until) > now) {
      return { status: 'leased', rhythm: state }
    }
    const appointments = state.exact_appointments || []
    if (schedule.releaseExact && appointments.length === 0) {
      return { status: 'no-exact-to-release', rhythm: state }
    }
    let releaseTarget = null
    if (schedule.releaseExact) {
      if (schedule.releaseExactAt != null) {
        releaseTarget = appointments.find(
          (appointment) => Number(appointment.wakeup_at) === Number(schedule.releaseExactAt)
        )
        if (!releaseTarget) return { status: 'exact-to-release-not-found', rhythm: state }
      } else if (appointments.length === 1) {
        releaseTarget = appointments[0]
      } else {
        return { status: 'exact-release-ambiguous', rhythm: state }
      }
    }
    if (schedule.scheduleMode === 'exact') {
      const existing = appointments.find(
        (appointment) => Number(appointment.wakeup_at) === Number(schedule.nextWakeupAt)
      )
      if (!existing && appointments.length >= PROACTIVE_EXACT_APPOINTMENT_LIMIT) {
        return { status: 'exact-capacity-reached', rhythm: state }
      }
    }
    if (state.active_slot_key) {
      stmt.finishProactiveWake.run(
        'failed',
        null,
        'Proactive wake schedule was superseded after its lease expired',
        now,
        state.active_slot_key
      )
    }

    const writer = schedule.releaseExact
      ? stmt.releaseExactProactiveSchedule
      : schedule.scheduleMode === 'exact'
        ? stmt.touchExactProactiveSchedule
        : stmt.setProactiveSchedule
    const changed = writer.run({
      sessionKey: key,
      generation: Number(state.generation) || 0,
      ...schedule,
      now,
    }).changes
    if (changed && schedule.scheduleMode === 'exact') {
      stmt.insertExactAppointment.run({ sessionKey: key, ...schedule, now })
    }
    if (changed && releaseTarget) {
      stmt.deleteExactAppointment.run(key, Number(releaseTarget.id))
    }
    return {
      status: changed ? 'scheduled' : 'stale',
      rhythm: loadProactiveRhythm(key),
    }
  }
)

const noteProactiveInteractionTx = db.transaction(
  ({ sessionKey: key, interactionAt, deferUntil, now }) => {
    const state = stmt.getProactiveRhythm.get(key)
    if (!state) return false
    if (state.lease_until != null && Number(state.lease_until) > now) return false
    if (state.active_slot_key) {
      stmt.finishProactiveWake.run(
        'failed',
        null,
        'Proactive wake was superseded by new user activity after its lease expired',
        now,
        state.active_slot_key
      )
    }
    return stmt.noteProactiveInteraction.run({
      sessionKey: key,
      interactionAt,
      deferUntil,
      now,
    }).changes > 0
  }
)

const completeProactiveWakeTx = db.transaction(
  ({
    sessionKey: key,
    slotKey,
    leaseToken,
    status,
    messageId,
    error,
    nextWakeupAt,
    did,
    wakeupReason,
    scheduleMode,
    scheduleEarliestAt,
    scheduleLatestAt,
    scheduleBias,
    scheduleReason,
    wakeKind,
    usedFallback,
    now,
  }) => {
    const rhythmChanged = stmt.completeProactiveRhythm.run({
      sessionKey: key,
      leaseToken,
      nextWakeupAt,
      did,
      wakeupReason,
      scheduleMode,
      scheduleEarliestAt,
      scheduleLatestAt,
      scheduleBias,
      scheduleReason,
      wakeKind,
      usedFallback: usedFallback ? 1 : 0,
      now,
    }).changes
    if (rhythmChanged) {
      stmt.deleteClaimedExactAppointment.run({
        sessionKey: key,
        slotKey,
        wakeKind,
      })
    }
    stmt.finishProactiveWake.run(
      status,
      messageId,
      error,
      now,
      slotKey
    )
    return rhythmChanged > 0
  }
)

export function sessionKey(chatId, topicId) {
  return `${chatId}:${topicId ?? 0}`
}

export function getSession(key, defaultWorkspace) {
  let row = stmt.get.get(key)
  if (!row) {
    stmt.insert.run({
      key,
      workspace: defaultWorkspace,
      contextMessageId: stmt.maxConversationMessageId.get(key).id,
      now: Date.now(),
    })
    row = stmt.get.get(key)
  }
  return row
}

/** Called after a turn produces a thread_id (first turn) or completes (later turns). */
export function recordTurn(key, threadId) {
  if (threadId) stmt.setThread.run(threadId, Date.now(), key)
  else stmt.bumpTurn.run(Date.now(), key)
}

/** Changing workspace always starts a fresh thread — context from another repo is noise. */
export function setWorkspace(key, workspace) {
  const now = Date.now()
  stmt.clearThreadCarryover.run(key)
  stmt.setWorkspace.run(
    workspace,
    stmt.maxConversationMessageId.get(key).id,
    now,
    now,
    key
  )
}

export function resetThread(key) {
  const now = Date.now()
  stmt.reset.run(stmt.maxConversationMessageId.get(key).id, now, now, key)
}

export function archiveCurrentThread(key) {
  const session = stmt.get.get(key)
  if (!session?.thread_id) return null
  const preview =
    stmt.firstConversationPreview.get(key, Number(session.context_message_id) || 0)?.content ||
    null
  const archived = {
    sessionKey: key,
    threadId: session.thread_id,
    workspace: session.workspace,
    preview: preview ? String(preview).replace(/\s+/gu, ' ').trim().slice(0, 160) : null,
    turnCount: Number(session.turn_count) || 0,
    firstSeenAt: Number(session.thread_started_at) || Number(session.created_at) || Date.now(),
    lastUsedAt: Date.now(),
  }
  stmt.upsertThreadHistory.run(archived)
  return stmt.getThreadHistory.get(key, session.thread_id) || null
}

export function listThreadHistory(key) {
  const currentThreadId = stmt.get.get(key)?.thread_id || null
  return stmt.listThreadHistory.all(key, currentThreadId, currentThreadId)
}

export function resumeThread(key, threadId) {
  const target = stmt.getThreadHistory.get(key, String(threadId || ''))
  if (!target) return null
  const now = Date.now()
  stmt.clearThreadCarryover.run(key)
  stmt.resumeThread.run(
    target.thread_id,
    target.workspace,
    Number(target.turn_count) || 0,
    stmt.maxConversationMessageId.get(key).id,
    Number(target.first_seen_at) || now,
    now,
    key
  )
  stmt.touchThreadHistory.run(now, key, target.thread_id)
  return getSession(key, target.workspace)
}

export function setModel(key, model) {
  stmt.setModel.run(model || null, Date.now(), key)
}

export function setEffort(key, effort) {
  stmt.setEffort.run(effort || null, Date.now(), key)
}

export function queueRestartNotification(chatId, topicId) {
  return stmt.queueRestart.run(chatId, topicId ?? null, Date.now()).lastInsertRowid
}

export function getRestartNotifications() {
  return stmt.listRestarts.all()
}

export function deleteRestartNotification(id) {
  stmt.deleteRestart.run(id)
}

export function claimProactiveWake(slotKey, key, chatId, topicId = null) {
  return (
    stmt.claimProactiveWake.run(slotKey, key, chatId, topicId, null, Date.now()).changes > 0
  )
}

export function finishProactiveWake(
  slotKey,
  { status, messageId = null, error = null } = {}
) {
  if (!['sent', 'silent', 'interrupted', 'failed'].includes(status)) {
    throw new Error(`Invalid proactive wake status: ${status}`)
  }
  return (
    stmt.finishProactiveWake.run(
      status,
      messageId,
      error ? String(error).slice(0, 2000) : null,
      Date.now(),
      slotKey
    ).changes > 0
  )
}

export function ensureProactiveRhythm({
  sessionKey: key,
  chatId,
  topicId = null,
  nextWakeupAt,
  did = 'No previous adaptive wake has run.',
  wakeupReason = 'bootstrap',
  now = Date.now(),
}) {
  if (!key || !Number.isFinite(Number(chatId))) {
    throw new Error('sessionKey and chatId are required for proactive rhythm')
  }
  const wakeAt = Math.trunc(Number(nextWakeupAt))
  if (!Number.isFinite(wakeAt)) throw new Error('nextWakeupAt must be finite')
  stmt.ensureProactiveRhythm.run({
    sessionKey: String(key),
    chatId: Math.trunc(Number(chatId)),
    topicId: topicId == null ? null : Math.trunc(Number(topicId)),
    nextWakeupAt: wakeAt,
    did: String(did || 'No previous adaptive wake has run.').slice(0, 500),
    wakeupReason: String(wakeupReason || 'bootstrap').slice(0, 80),
    now: Math.trunc(Number(now) || Date.now()),
  })
  return loadProactiveRhythm(key)
}

export function getProactiveRhythm(key) {
  return loadProactiveRhythm(key)
}

export function claimDueProactiveWake(key, now = Date.now(), leaseMs = 20 * 60_000) {
  const at = Math.trunc(Number(now) || Date.now())
  const lease = Math.max(60_000, Math.trunc(Number(leaseMs) || 20 * 60_000))
  return claimDueProactiveWakeTx({ sessionKey: String(key), now: at, leaseMs: lease })
}

export function renewProactiveWakeLease({
  sessionKey: key,
  slotKey,
  leaseToken,
  generation,
  now = Date.now(),
  leaseMs = 20 * 60_000,
}) {
  const at = Math.trunc(Number(now) || Date.now())
  const lease = Math.max(60_000, Math.trunc(Number(leaseMs) || 20 * 60_000))
  return stmt.renewProactiveRhythmLease.run({
    sessionKey: String(key),
    slotKey: String(slotKey),
    leaseToken: String(leaseToken),
    generation: Math.trunc(Number(generation) || 0),
    leaseUntil: at + lease,
    now: at,
  }).changes > 0
}

export function completeProactiveWake({
  sessionKey: key,
  slotKey,
  leaseToken,
  status,
  messageId = null,
  error = null,
  nextWakeupAt,
  did,
  wakeupReason = 'scheduled',
  scheduleMode = 'default',
  scheduleEarliestAt = null,
  scheduleLatestAt = null,
  scheduleBias = null,
  scheduleReason = null,
  wakeKind = 'flexible',
  usedFallback = false,
  now = Date.now(),
}) {
  if (!['sent', 'silent', 'interrupted', 'failed'].includes(status)) {
    throw new Error(`Invalid proactive wake status: ${status}`)
  }
  if (!key || !slotKey || !leaseToken) {
    throw new Error('A claimed proactive wake is required for completion')
  }
  const wakeAt = Math.trunc(Number(nextWakeupAt))
  if (!Number.isFinite(wakeAt)) throw new Error('nextWakeupAt must be finite')
  return completeProactiveWakeTx({
    sessionKey: String(key),
    slotKey: String(slotKey),
    leaseToken: String(leaseToken),
    status,
    messageId: messageId == null ? null : Number(messageId),
    error: error ? String(error).slice(0, 2000) : null,
    nextWakeupAt: wakeAt,
    did: String(did || 'Completed a wake without a causal baton.').slice(0, 500),
    wakeupReason: String(wakeupReason || 'scheduled').slice(0, 80),
    scheduleMode: ['exact', 'window', 'default'].includes(scheduleMode)
      ? scheduleMode
      : 'default',
    scheduleEarliestAt:
      scheduleEarliestAt == null ? null : Math.trunc(Number(scheduleEarliestAt)),
    scheduleLatestAt:
      scheduleLatestAt == null ? null : Math.trunc(Number(scheduleLatestAt)),
    scheduleBias: ['early', 'center', 'late'].includes(scheduleBias)
      ? scheduleBias
      : null,
    scheduleReason: scheduleReason ? String(scheduleReason).slice(0, 500) : null,
    wakeKind: wakeKind === 'exact' ? 'exact' : 'flexible',
    usedFallback: Boolean(usedFallback),
    now: Math.trunc(Number(now) || Date.now()),
  })
}

export function setProactiveSchedule(key, schedule, now = Date.now()) {
  if (!key || !schedule || typeof schedule !== 'object') {
    throw new Error('session key and schedule are required')
  }
  const scheduleMode = String(schedule.scheduleMode || '')
  if (!['exact', 'window', 'default'].includes(scheduleMode)) {
    throw new Error(`Invalid proactive schedule mode: ${scheduleMode}`)
  }
  const nextWakeupAt = Math.trunc(Number(schedule.nextWakeupAt))
  if (!Number.isFinite(nextWakeupAt)) throw new Error('nextWakeupAt must be finite')
  const at = Math.trunc(Number(now) || Date.now())
  return setProactiveScheduleTx({
    sessionKey: String(key),
    schedule: {
      nextWakeupAt,
      wakeupReason: String(schedule.wakeupReason || `${scheduleMode}-scheduled`).slice(0, 80),
      scheduleMode,
      scheduleEarliestAt:
        schedule.scheduleEarliestAt == null
          ? null
          : Math.trunc(Number(schedule.scheduleEarliestAt)),
      scheduleLatestAt:
        schedule.scheduleLatestAt == null
          ? null
          : Math.trunc(Number(schedule.scheduleLatestAt)),
      scheduleBias: ['early', 'center', 'late'].includes(schedule.scheduleBias)
        ? schedule.scheduleBias
        : null,
      scheduleReason: schedule.scheduleReason
        ? String(schedule.scheduleReason).slice(0, 500)
        : null,
      releaseExact: Boolean(schedule.releaseExact),
      releaseExactAt:
        schedule.releaseExactAt == null
          ? null
          : Math.trunc(Number(schedule.releaseExactAt)),
    },
    now: at,
  })
}

export function noteProactiveInteraction(key, interactionAt, deferUntil, now = Date.now()) {
  const at = Math.trunc(Number(interactionAt) || Date.now())
  const until = Math.max(at, Math.trunc(Number(deferUntil) || at))
  return noteProactiveInteractionTx({
    sessionKey: String(key),
    interactionAt: at,
    deferUntil: until,
    now: Math.trunc(Number(now) || Date.now()),
  })
}

export function getSkillEpisode(key) {
  return stmt.getSkillEpisode.get(key) || null
}

export function saveSkillEpisode({
  sessionKey: key,
  skillName,
  skillPath,
  parentThreadId = null,
  workerThreadId,
  needsReload = false,
}) {
  if (!key || !skillName || !skillPath || !workerThreadId) {
    throw new Error('Incomplete skill episode')
  }
  const now = Date.now()
  stmt.upsertSkillEpisode.run({
    sessionKey: key,
    skillName,
    skillPath,
    parentThreadId,
    workerThreadId,
    needsReload: needsReload ? 1 : 0,
    now,
  })
  return getSkillEpisode(key)
}

export function touchSkillEpisode(key, { reloaded = false } = {}) {
  return stmt.touchSkillEpisode.run(reloaded ? 1 : 0, Date.now(), key).changes > 0
}

export function markSkillEpisodeReload(key) {
  return stmt.markSkillEpisodeReload.run(Date.now(), key).changes > 0
}

export function markAllSkillEpisodesReload() {
  return stmt.markAllSkillEpisodesReload.run(Date.now()).changes
}

export function deleteSkillEpisode(key) {
  return stmt.deleteSkillEpisode.run(key).changes > 0
}

export function getInnerBatonRecord(key) {
  return stmt.getInnerBaton.get(String(key)) || null
}

export function ensureInnerBatonRecord(key) {
  const value = String(key)
  const now = Date.now()
  stmt.ensureInnerBaton.run(value, now, now)
  return getInnerBatonRecord(value)
}

export function compareAndSetInnerBaton({
  sessionKey: key,
  expectedVersion,
  stateJson,
  sourceThreadId = null,
  sourceTurnId = null,
}) {
  const result = compareAndSetInnerBatonTx({
    sessionKey: String(key),
    expectedVersion: Math.max(0, Math.trunc(Number(expectedVersion) || 0)),
    stateJson: String(stateJson),
    sourceThreadId: sourceThreadId ? String(sourceThreadId) : null,
    sourceTurnId: sourceTurnId ? String(sourceTurnId) : null,
    now: Date.now(),
  })
  return result
}

export function getThreadInnerBatonVersion(threadId) {
  if (!threadId) return null
  const value = stmt.getThreadInnerBatonVersion.get(String(threadId))?.version
  return value == null ? null : Number(value)
}

export function setThreadInnerBatonVersion(threadId, key, version) {
  if (!threadId || !key || !Number.isSafeInteger(Number(version))) {
    throw new Error('threadId, sessionKey, and version are required')
  }
  stmt.setThreadInnerBatonVersion.run(
    String(threadId),
    String(key),
    Number(version),
    Date.now()
  )
}

export function clearThreadInnerBatonVersion(threadId) {
  if (!threadId) return false
  return stmt.clearThreadInnerBatonVersion.run(String(threadId)).changes > 0
}

export function addMemoryEvent(session, role, content) {
  if (!['user', 'assistant'].includes(role)) throw new Error(`Invalid memory event role: ${role}`)
  const value = String(content || '').trim()
  if (!value) return null
  return stmt.addMemoryEvent.run(session, role, value.slice(0, 12_000), Date.now()).lastInsertRowid
}

export function countPendingMemoryUserMessages() {
  return stmt.countPendingMemoryUsers.get().count
}

export function listPendingMemoryEvents(limit = 100) {
  return stmt.listPendingMemoryEvents.all(Math.max(1, Math.min(500, Number(limit) || 100)))
}

const markMemoryEventsProcessedTx = db.transaction((ids, now) => {
  for (const id of ids) stmt.markMemoryEventsProcessed.run(now, id)
})

export function markMemoryEventsProcessed(ids) {
  const values = [...new Set(ids.map(Number).filter(Number.isInteger))]
  if (values.length) markMemoryEventsProcessedTx(values, Date.now())
}

export function getThreadMemoryHash(threadId) {
  if (!threadId) return null
  return stmt.getThreadMemoryHash.get(threadId)?.memory_hash || null
}

export function setThreadMemoryHash(threadId, memoryHash) {
  if (!threadId || !memoryHash) throw new Error('threadId and memoryHash are required')
  stmt.setThreadMemoryHash.run(threadId, memoryHash, Date.now())
}

export function clearThreadMemoryHash(threadId) {
  if (!threadId) return false
  return stmt.clearThreadMemoryHash.run(threadId).changes > 0
}

export function addConversationMessage({
  sourceId,
  sessionKey: key,
  chatId = null,
  topicId = null,
  telegramMessageId = null,
  conversationTurnId = null,
  role,
  content,
  sentAt = Date.now(),
}) {
  if (!sourceId || !key) throw new Error('sourceId and sessionKey are required')
  if (!['user', 'assistant'].includes(role)) {
    throw new Error(`Invalid conversation role: ${role}`)
  }
  const value = String(content || '').trim()
  if (!value) return null
  const nullableInteger = (input) => {
    if (input === null || input === undefined || input === '') return null
    const number = Number(input)
    return Number.isSafeInteger(number) ? number : null
  }
  const result = stmt.addConversationMessage.run({
    sourceId: String(sourceId),
    sessionKey: String(key),
    chatId: nullableInteger(chatId),
    topicId: nullableInteger(topicId),
    telegramMessageId: nullableInteger(telegramMessageId),
    conversationTurnId: conversationTurnId ? String(conversationTurnId) : null,
    role,
    content: value.slice(0, 24_000),
    sentAt: Math.trunc(Number(sentAt) || Date.now()),
    createdAt: Date.now(),
  })
  return result.changes ? result.lastInsertRowid : null
}

export function assignConversationMessageTurn(sourceId, conversationTurnId) {
  if (!sourceId || !conversationTurnId) return false
  return stmt.assignConversationMessageTurn.run(
    String(conversationTurnId),
    String(sourceId)
  ).changes > 0
}

export function listConversationMessages(startMs, endMs) {
  const start = Math.trunc(Number(startMs))
  const end = Math.trunc(Number(endMs))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('Invalid conversation-message window')
  }
  return stmt.listConversationMessages.all(start, end)
}

export function listRecentConversationMessages(key, limit = 6, afterId = 0) {
  const rows = stmt.listRecentConversationMessages.all(
    String(key),
    Math.max(0, Number(afterId) || 0),
    Math.max(1, Math.min(20, Number(limit) || 6))
  )
  return rows.reverse()
}

export function listRecentUserMessages(key, { limit = 3, afterId = 0, sinceMs = 0 } = {}) {
  const rows = stmt.listRecentUserMessages.all(
    String(key),
    Math.max(0, Number(afterId) || 0),
    Math.max(0, Number(sinceMs) || 0),
    Math.max(1, Math.min(20, Number(limit) || 3))
  )
  return rows.reverse()
}

export function listCurrentThreadTail(key, userTurns = 10) {
  const session = stmt.get.get(String(key))
  if (!session?.thread_id) return []
  return stmt.listCurrentThreadTail.all({
    sessionKey: String(key),
    afterId: Math.max(0, Number(session.context_message_id) || 0),
    userTurns: Math.max(1, Math.min(20, Number(userTurns) || 10)),
  })
}

export function saveThreadCarryover(key, sourceThreadId, content) {
  const value = String(content || '').trim()
  if (!sourceThreadId || !value) {
    stmt.clearThreadCarryover.run(String(key))
    return null
  }
  stmt.saveThreadCarryover.run(
    String(key),
    String(sourceThreadId),
    value,
    Date.now()
  )
  return getThreadCarryover(key)
}

export function getThreadCarryover(key) {
  return stmt.getThreadCarryover.get(String(key)) || null
}

export function clearThreadCarryover(key) {
  return stmt.clearThreadCarryover.run(String(key)).changes > 0
}

export function getJournalCollectorRun(taskName, targetDate) {
  return stmt.getJournalRun.get(taskName, targetDate) || null
}

export function saveJournalCollectorRun(run) {
  stmt.upsertJournalRun.run(run)
}

export function getJournalCollectorEvent(taskName, targetDate, eventHash) {
  return stmt.getJournalEvent.get(taskName, targetDate, eventHash) || null
}

export function saveJournalCollectorEvent(event) {
  stmt.upsertJournalEvent.run(event)
}

export default db
