export function resolveActiveThreadId(session, episode = null) {
  const workerThreadId = String(episode?.worker_thread_id || '').trim()
  if (workerThreadId) return workerThreadId

  const sessionThreadId = String(session?.thread_id || '').trim()
  return sessionThreadId || null
}
