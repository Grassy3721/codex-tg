import path from 'node:path'

const TG_LIMIT = 4096
const SAFE = 3800 // leave room for wrapper tags

export function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeHtmlAttribute(s = '') {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

function safeLink(url = '') {
  const value = String(url).trim()
  return /^(?:https?:\/\/|tg:\/\/|mailto:)/i.test(value) ? value : null
}

/**
 * Render the small, useful Markdown subset supported by Telegram's HTML mode.
 * Unknown/raw HTML is escaped, so agent prose can never inject Telegram tags.
 */
export function markdownInline(s = '') {
  const input = String(s)
  let out = ''
  let plainStart = 0

  const flushPlain = (end) => {
    if (end > plainStart) out += escapeHtml(input.slice(plainStart, end))
  }

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '\\' && i + 1 < input.length) {
      flushPlain(i)
      out += escapeHtml(input[i + 1])
      i += 1
      plainStart = i + 1
      continue
    }

    if (input[i] === '`') {
      let ticks = 1
      while (input[i + ticks] === '`') ticks += 1
      const marker = '`'.repeat(ticks)
      const end = input.indexOf(marker, i + ticks)
      if (end !== -1) {
        flushPlain(i)
        out += `<code>${escapeHtml(input.slice(i + ticks, end))}</code>`
        i = end + ticks - 1
        plainStart = i + 1
        continue
      }
    }

    const imageOffset = input.startsWith('![', i) ? 1 : 0
    if (input[i + imageOffset] === '[') {
      const labelEnd = input.indexOf('](', i + imageOffset + 1)
      const urlEnd = labelEnd === -1 ? -1 : input.indexOf(')', labelEnd + 2)
      if (labelEnd !== -1 && urlEnd !== -1) {
        const url = safeLink(input.slice(labelEnd + 2, urlEnd))
        if (url) {
          flushPlain(i)
          const label = input.slice(i + imageOffset + 1, labelEnd)
          const prefix = imageOffset ? '🖼 ' : ''
          out += `${prefix}<a href="${escapeHtmlAttribute(url)}">${markdownInline(label)}</a>`
          i = urlEnd
          plainStart = i + 1
          continue
        }
      }
    }

    const formats = [
      ['||', 'tg-spoiler'],
      ['**', 'b'],
      ['__', 'b'],
      ['~~', 's'],
      ['*', 'i'],
      ['_', 'i'],
    ]
    let matched = false
    for (const [marker, tag] of formats) {
      if (!input.startsWith(marker, i)) continue
      if (
        marker.length === 1 &&
        i > 0 &&
        i + 1 < input.length &&
        /\w/.test(input[i - 1]) &&
        /\w/.test(input[i + 1])
      ) {
        continue
      }
      const end = input.indexOf(marker, i + marker.length)
      if (end <= i + marker.length) continue
      flushPlain(i)
      out += `<${tag}>${markdownInline(input.slice(i + marker.length, end))}</${tag}>`
      i = end + marker.length - 1
      plainStart = i + 1
      matched = true
      break
    }
    if (matched) continue
  }

  flushPlain(input.length)
  return out
}

/** Convert agent Markdown into the conservative HTML subset accepted by Telegram. */
export function markdownToTelegramHtml(markdown = '') {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n')
  const out = []

  for (let i = 0; i < lines.length; i += 1) {
    const fence = lines[i].match(/^\s*```([A-Za-z0-9_+.-]*)\s*$/)
    if (fence) {
      const code = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i += 1
      }
      const language = fence[1]
        ? ` class="language-${escapeHtmlAttribute(fence[1])}"`
        : ''
      out.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = lines[i].match(/^\s{0,3}#{1,6}\s+(.+)$/)
    if (heading) {
      out.push(`<b>${markdownInline(heading[1])}</b>`)
      continue
    }

    const quote = lines[i].match(/^\s{0,3}>\s?(.*)$/)
    if (quote) {
      const quoted = [quote[1]]
      while (i + 1 < lines.length) {
        const next = lines[i + 1].match(/^\s{0,3}>\s?(.*)$/)
        if (!next) break
        quoted.push(next[1])
        i += 1
      }
      out.push(`<blockquote>${quoted.map(markdownInline).join('\n')}</blockquote>`)
      continue
    }

    const unordered = lines[i].match(/^(\s*)[-+*]\s+(.+)$/)
    if (unordered) {
      out.push(`${unordered[1]}• ${markdownInline(unordered[2])}`)
      continue
    }

    const ordered = lines[i].match(/^(\s*)(\d+)[.)]\s+(.+)$/)
    if (ordered) {
      out.push(`${ordered[1]}${ordered[2]}. ${markdownInline(ordered[3])}`)
      continue
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      out.push('────────')
      continue
    }

    out.push(markdownInline(lines[i]))
  }

  return out.join('\n')
}

/**
 * Split before rendering so a boundary never lands inside an HTML tag/entity.
 * Huge single blocks may lose formatting at one split, but remain safe and readable.
 */
export function telegramMarkdownChunks(markdown, size = SAFE) {
  const pending = [String(markdown)]
  const out = []

  while (pending.length) {
    const source = pending.shift()
    const html = markdownToTelegramHtml(source)
    if (html.length <= size) {
      if (html.trim()) out.push(html)
      continue
    }

    let cut = source.lastIndexOf('\n', Math.floor(source.length / 2))
    if (cut < source.length * 0.25) cut = source.lastIndexOf(' ', Math.floor(source.length / 2))
    if (cut < 1) cut = Math.floor(source.length / 2)
    pending.unshift(source.slice(0, cut), source.slice(cut))
  }

  return out
}

/** Last-resort fallback when Telegram rejects our HTML: send it as plain text. */
export function stripHtml(s = '') {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Collapse to a single line for the status bar, which has one line to work with. */
export function oneLine(s, max = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Telegram hard-caps messages at 4096 chars. Split on line boundaries where possible. */
export function chunk(text, size = SAFE) {
  const out = []
  let rest = String(text)
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) out.push(rest)
  return out
}

/** Keep the head and tail of long command output; the middle is rarely the interesting part. */
export function truncateMiddle(text, max = 1500) {
  const s = String(text || '')
  if (s.length <= max) return s
  const head = s.slice(0, Math.floor(max * 0.6))
  const tail = s.slice(-Math.floor(max * 0.3))
  return `${head}\n\n… [${s.length - head.length - tail.length} chars omitted] …\n\n${tail}`
}

export function commandRunning(command) {
  return `⚙️ <pre>${escapeHtml(truncateMiddle(command, 300))}</pre>`
}

export function commandDone(item) {
  const ok = item.exit_code === 0
  const icon = ok ? '✅' : '❌'
  const out = truncateMiddle((item.aggregated_output || '').trim())
  const head = `${icon} <pre>${escapeHtml(truncateMiddle(item.command, 300))}</pre>`
  if (!out) return `${head}\n<i>(no output, exit ${item.exit_code})</i>`
  return `${head}\n<pre>${escapeHtml(out)}</pre>`
}

/** Codex wraps every command in `/bin/bash -lc '…'`; the wrapper is pure noise on one line. */
export function shortCommand(command, max = 90) {
  let c = oneLine(command, Number.MAX_SAFE_INTEGER)
  const m = c.match(/^\/bin\/(?:ba)?sh\s+-l?c\s+(.*)$/)
  if (m) {
    c = m[1].trim()
    const quoted = (c.startsWith("'") && c.endsWith("'")) || (c.startsWith('"') && c.endsWith('"'))
    if (quoted) c = c.slice(1, -1)
  }
  return oneLine(c, max)
}

/** Mandatory Skill reads are quick conversational scaffolding, not useful status. */
export function isQuietSkillRead(item) {
  if (item?.type !== 'command_execution') return false
  const command = oneLine(item.command, Number.MAX_SAFE_INTEGER)
  return /(?:^|[\s"'=])cat\s+(?:--\s+)?["']?[^\s"';&|]*\/SKILL\.md["']?(?:\s|$)/.test(
    command
  )
}

/**
 * One line describing what the agent is doing right now, for the status bar.
 * Returns null for item types not worth surfacing.
 */
export function statusFor(item) {
  if (!item) return null
  switch (item.type) {
    case 'command_execution':
      return `⚙️ <code>${escapeHtml(shortCommand(item.command))}</code>`
    case 'file_change': {
      const names = (item.changes || []).map((c) => path.basename(c.path || String(c)))
      if (!names.length) return '📝 <i>改文件中…</i>'
      const head = names.slice(0, 3).join(', ')
      return `📝 <code>${escapeHtml(head)}</code>${names.length > 3 ? ` +${names.length - 3}` : ''}`
    }
    case 'mcp_tool_call':
      return `🔌 <code>${escapeHtml(`${item.server || '?'}.${item.tool || '?'}`)}</code>`
    case 'web_search':
      return `🔍 <i>${escapeHtml(oneLine(item.query || 'search', 80))}</i>`
    case 'reasoning':
      return '🤔 <i>思考中…</i>'
    default:
      return null
  }
}

export { TG_LIMIT }
