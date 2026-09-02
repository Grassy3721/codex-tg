import { config } from '../src/config.js'
import { buildRecentThreadContext } from '../src/context.js'
import {
  archiveCurrentThread,
  getSession,
  getSkillEpisode,
  listCurrentThreadTail,
  queueRestartNotification,
  resetThread,
  saveThreadCarryover,
} from '../src/db.js'

function usage() {
  console.error('Usage: node scripts/migrateInnerBatonThread.js <chat-id>:<topic-id> [--dry-run]')
  process.exitCode = 2
}

const [sessionKey, ...flags] = process.argv.slice(2)
if (!/^[-]?\d+:\d+$/u.test(sessionKey || '') || flags.some((flag) => flag !== '--dry-run')) {
  usage()
} else {
  const dryRun = flags.includes('--dry-run')
  const current = getSession(sessionKey, config.defaultWorkspace)
  const episode = getSkillEpisode(sessionKey)

  if (!current?.thread_id) {
    console.log(JSON.stringify({ ok: true, migrated: false, reason: 'already-fresh', sessionKey }))
  } else if (episode) {
    console.error(JSON.stringify({ ok: false, reason: 'active-skill-episode', sessionKey }))
    process.exitCode = 3
  } else if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      sessionKey,
      sourceThreadId: current.thread_id,
      carryoverTurns: config.recentThreadContextTurns,
    }))
  } else {
    const archived = archiveCurrentThread(sessionKey)
    if (!archived) throw new Error('The current thread disappeared before migration')

    const recentContext = buildRecentThreadContext(
      listCurrentThreadTail(sessionKey, config.recentThreadContextTurns),
      config.recentThreadContextMaxChars
    )
    saveThreadCarryover(sessionKey, archived.thread_id, recentContext)
    resetThread(sessionKey)

    const [chatIdText, topicIdText] = sessionKey.split(':')
    queueRestartNotification(Number(chatIdText), Number(topicIdText) || null)
    console.log(JSON.stringify({
      ok: true,
      migrated: true,
      sessionKey,
      sourceThreadId: archived.thread_id,
      carriedCharacters: recentContext.length,
    }))
  }
}
