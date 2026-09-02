export const THREADS_PAGE_SIZE = 5

export function paginateThreads(threads = [], requestedPage = 1, pageSize = THREADS_PAGE_SIZE) {
  const size = Math.max(1, Math.trunc(Number(pageSize)) || THREADS_PAGE_SIZE)
  const totalItems = Array.isArray(threads) ? threads.length : 0
  const totalPages = Math.max(1, Math.ceil(totalItems / size))
  const parsedPage = Math.trunc(Number(requestedPage)) || 1
  const page = Math.min(totalPages, Math.max(1, parsedPage))
  const startIndex = (page - 1) * size

  return {
    page,
    pageSize: size,
    totalItems,
    totalPages,
    startIndex,
    items: (Array.isArray(threads) ? threads : []).slice(startIndex, startIndex + size),
  }
}

export function threadPageKeyboard(page, totalPages) {
  const buttons = []
  if (page > 1) buttons.push({ text: '‹ 上一页', callback_data: `threads:${page - 1}` })
  if (page < totalPages) buttons.push({ text: '下一页 ›', callback_data: `threads:${page + 1}` })
  return buttons.length ? { inline_keyboard: [buttons] } : undefined
}
