/**
 * Cosmetic Telegram requests must never keep a conversational turn active.
 * The underlying promise remains observed after a timeout so a late rejection
 * cannot become unhandled, and callers may clean up late-created messages.
 */
export async function settleCosmeticRequest(
  request,
  { timeoutMs = 4_000, onLate = null } = {}
) {
  const limit = Math.max(1, Math.trunc(Number(timeoutMs) || 4_000))
  let timedOut = false
  let timer = null
  const observed = Promise.resolve(request).then(
    (value) => {
      if (timedOut && typeof onLate === 'function') {
        Promise.resolve(onLate(value)).catch(() => {})
      }
      return { value }
    },
    () => ({ value: null })
  )
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ value: null })
    }, limit)
  })
  const result = await Promise.race([observed, timeout])
  if (timer !== null) clearTimeout(timer)
  return result.value
}
