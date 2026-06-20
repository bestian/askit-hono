import assert from 'node:assert/strict'
import test from 'node:test'

import { extractIndexKeys } from '../src/utils/bigramKeys'

test('extractIndexKeys: 萌典 → has 萌典', () => {
  assert.ok(extractIndexKeys('萌典').has('萌典'))
})

test('extractIndexKeys: 我們的萌典松 → has 萌典 and 典松', () => {
  const keys = extractIndexKeys('我們的萌典松')
  assert.ok(keys.has('萌典'), '應含 萌典')
  assert.ok(keys.has('典松'), '應含 典松')
  // 整個 Han run 是一條，故也有 我們、們的、的萌
  assert.ok(keys.has('我們'))
  assert.ok(keys.has('們的'))
  assert.ok(keys.has('的萌'))
})

test('extractIndexKeys: Plurality → whole lowercased token, no 1-char keys', () => {
  const keys = extractIndexKeys('Plurality')
  assert.ok(keys.has('plurality'))
  for (const k of keys) {
    assert.ok(k.length >= 2, `不應有 1-char key: ${k}`)
  }
})

test('extractIndexKeys: single Han char → empty set', () => {
  assert.equal(extractIndexKeys('萌').size, 0)
  assert.equal(extractIndexKeys('').size, 0)
})

test('extractIndexKeys: punctuation/spaces break Han runs — no cross-run bigram', () => {
  // 「萌、典」被頓號切成兩個 1-char Han run，皆不足以成 bigram，故無 萌典。
  const keys = extractIndexKeys('萌、典')
  assert.equal(keys.size, 0)
  // 萌 典（空格分隔）同理。
  assert.equal(extractIndexKeys('萌 典').size, 0)
})

test('extractIndexKeys: Latin token must be >= 2 chars', () => {
  const keys = extractIndexKeys('a 萌典 AI')
  // 'a' 單字元拉丁不算；'AI' 雙字元 → 'ai'
  assert.ok(!keys.has('a'))
  assert.ok(keys.has('ai'))
  assert.ok(keys.has('萌典'))
})
