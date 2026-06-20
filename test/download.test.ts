import assert from 'node:assert/strict'
import test from 'node:test'

import { loadAppTestHooks } from './helpers/loadApp'

test('copyMarkdownText writes the exact Markdown to Clipboard API', async () => {
  const { copyMarkdownText } = await loadAppTestHooks()
  const markdown = '回答 [^1]\n\n[^1]: [來源](https://archive.tw/demo#s1)'
  let copied = ''
  const ok = await copyMarkdownText(markdown, {
    clipboard: {
      writeText: async (text: string) => {
        copied = text
      },
    },
  })

  assert.equal(ok, true)
  assert.equal(copied, markdown)
})

test('copyMarkdownText returns false when Clipboard API rejects and no fallback is available', async () => {
  const { copyMarkdownText } = await loadAppTestHooks()
  const ok = await copyMarkdownText('raw markdown', {
    clipboard: {
      writeText: async () => {
        throw new Error('clipboard blocked')
      },
    },
  })

  assert.equal(ok, false)
})

test('copy strings stay in the zh-Hant/en tables and download labels are gone', async () => {
  const { STRINGS } = await loadAppTestHooks()

  assert.equal(String(STRINGS['zh-Hant'].copyMarkdown), '複製 Markdown')
  assert.equal(String(STRINGS['zh-Hant'].copiedMarkdown), '已複製')
  assert.equal(String(STRINGS['zh-Hant'].copyFailed), '無法複製，請手動選取文字')
  assert.equal('download' in STRINGS['zh-Hant'], false)

  assert.equal(String(STRINGS.en.copyMarkdown), 'Copy Markdown')
  assert.equal(String(STRINGS.en.copiedMarkdown), 'Copied')
  assert.equal(String(STRINGS.en.copyFailed), 'Could not copy. Select the answer and copy manually.')
  assert.equal('download' in STRINGS.en, false)
})
