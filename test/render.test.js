import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isQuietSkillRead,
  markdownInline,
  markdownToTelegramHtml,
  telegramMarkdownChunks,
} from '../src/render.js'

test('hides mandatory Skill reads from the conversational status line', () => {
  assert.equal(
    isQuietSkillRead({
      type: 'command_execution',
      command: 'cat /root/workspace/.agents/skills/example/SKILL.md',
    }),
    true
  )
  assert.equal(
    isQuietSkillRead({ type: 'command_execution', command: 'npm run check' }),
    false
  )
})

test('renders common agent Markdown as Telegram HTML', () => {
  assert.equal(
    markdownToTelegramHtml(
      '# Title\n\nThis is **bold**, *soft*, ~~gone~~ and `x < y`.\n\n- [Docs](https://example.com?a=1&b=2)'
    ),
    '<b>Title</b>\n\nThis is <b>bold</b>, <i>soft</i>, <s>gone</s> and <code>x &lt; y</code>.\n\n• <a href="https://example.com?a=1&amp;b=2">Docs</a>'
  )
})

test('escapes raw HTML and refuses unsafe links', () => {
  assert.equal(markdownInline('<b>nope</b>'), '&lt;b&gt;nope&lt;/b&gt;')
  assert.equal(
    markdownInline('[click](javascript:alert(1))'),
    '[click](javascript:alert(1))'
  )
})

test('renders Telegram spoiler markup and allows formatting inside it', () => {
  assert.equal(
    markdownInline('公开 ||**不许偷看** <tag>|| 公开'),
    '公开 <tg-spoiler><b>不许偷看</b> &lt;tag&gt;</tg-spoiler> 公开'
  )
})

test('renders fenced code and blockquotes without interpreting their contents', () => {
  assert.equal(
    markdownToTelegramHtml('```js\nconst tag = "<b>";\n```\n> **quoted**'),
    '<pre><code class="language-js">const tag = "&lt;b&gt;";</code></pre>\n<blockquote><b>quoted</b></blockquote>'
  )
})

test('splits long replies into independently valid-sized HTML messages', () => {
  const source = Array.from({ length: 800 }, (_, i) => `word${i}`).join(' ')
  const chunks = telegramMarkdownChunks(source, 500)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((part) => part.length <= 500))
  assert.equal(chunks.join(''), source)
})
