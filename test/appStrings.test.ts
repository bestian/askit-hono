import assert from 'node:assert/strict'
import test from 'node:test'

import { loadAppTestHooks } from './helpers/loadApp'

test('app.js zh-Hant and en string tables stay in parity', async () => {
  const { STRINGS: strings } = await loadAppTestHooks()
  const zh = strings['zh-Hant']
  const en = strings.en
  assert.ok(zh && en, 'STRINGS must expose zh-Hant and en')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.equal((zh.samples as string[]).length, (en.samples as string[]).length)
  assert.match(String(en.submit), /^Ask$/)
})
