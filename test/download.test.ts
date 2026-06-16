import assert from 'node:assert/strict'
import test from 'node:test'

import { loadAppTestHooks } from './helpers/loadApp'

test('buildDownloadFilename uses ans-{question}-{date}.md shape', async () => {
  const { buildDownloadFilename } = await loadAppTestHooks()
  const date = new Date(2026, 5, 16) // 2026-06-16 (month is 0-based)
  assert.equal(
    buildDownloadFilename('什麼是仁工智慧', date),
    'ans-什麼是仁工智慧-2026-06-16.md',
  )
})

test('buildDownloadFilename strips filesystem-reserved characters', async () => {
  const { buildDownloadFilename } = await loadAppTestHooks()
  const date = new Date(2026, 0, 2) // 2026-01-02, checks zero padding
  assert.equal(
    buildDownloadFilename('a/b:c*?"<>|\\d', date),
    'ans-abcd-2026-01-02.md',
  )
})

test('buildDownloadFilename collapses whitespace and trims', async () => {
  const { buildDownloadFilename } = await loadAppTestHooks()
  const date = new Date(2026, 11, 31)
  assert.equal(
    buildDownloadFilename('  open\tgovernment\n  ', date),
    'ans-open government-2026-12-31.md',
  )
})

test('buildDownloadFilename falls back when the question is empty', async () => {
  const { buildDownloadFilename } = await loadAppTestHooks()
  const date = new Date(2026, 5, 16)
  assert.equal(buildDownloadFilename('   ', date, 'answer'), 'ans-answer-2026-06-16.md')
  assert.equal(buildDownloadFilename('', date), 'ans-answer-2026-06-16.md')
})

test('sanitizeFilenamePart caps very long questions at 80 chars', async () => {
  const { sanitizeFilenamePart } = await loadAppTestHooks()
  assert.equal(sanitizeFilenamePart('x'.repeat(200)).length, 80)
})

test('download strings stay in the zh-Hant/en tables', async () => {
  const { STRINGS } = await loadAppTestHooks()
  assert.equal(String(STRINGS['zh-Hant'].download), '下載 Markdown')
  assert.equal(String(STRINGS.en.download), 'Download Markdown')
})
