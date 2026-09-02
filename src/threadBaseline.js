/**
 * Load the bridge-owned baseline for a new context window.
 *
 * A missing memory hash means either a new thread or a completed compaction.
 * Fixed profile loading is intentionally independent from evolving memory so a
 * temporary MEMORY.md failure cannot also drop AGENTS.md from the new window.
 */
export async function loadThreadBaseline({
  activeThreadId,
  getThreadMemoryHash,
  buildEvolvingMemorySnapshot,
  buildFixedProfileDeveloperInstructions,
  warn = console.warn,
}) {
  const needsRefresh = !activeThreadId || !getThreadMemoryHash(activeThreadId)
  if (!needsRefresh) {
    return { memorySnapshot: null, developerInstructions: '' }
  }

  let memorySnapshot = null
  try {
    memorySnapshot = await buildEvolvingMemorySnapshot()
  } catch (error) {
    warn('[memory] evolving memory load failed, continuing without:', error.message)
  }

  let developerInstructions = ''
  try {
    developerInstructions = await buildFixedProfileDeveloperInstructions()
  } catch (error) {
    warn('[memory] portrait injection failed, continuing without:', error.message)
  }

  return { memorySnapshot, developerInstructions }
}
