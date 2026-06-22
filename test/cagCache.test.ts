import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCagSourceCacheKey,
  CAG_SOURCE_CACHE_TTL_SECONDS,
  getCachedCagSources,
  putCachedCagSources,
} from '../src/utils/cagCache'

test('buildCagSourceCacheKey is stable and parameter-order independent', async () => {
  const a = await buildCagSourceCacheKey({
    question: '  地神香火如何？ ',
    topK: 4,
    retriever: 'vectorize',
    archiveBaseUrl: 'https://archive.tw',
    vectorizeMinScore: 0.45,
  })
  const b = await buildCagSourceCacheKey({
    retriever: 'vectorize',
    vectorizeMinScore: 0.45,
    archiveBaseUrl: 'https://archive.tw',
    topK: 4,
    question: '地神香火如何？',
  })
  assert.equal(a, b)
  assert.match(a, /^v10:cag:src:[0-9a-f]{64}$/)
})

test('getCachedCagSources and putCachedCagSources round-trip sources', async () => {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value)
      assert.equal(options?.expirationTtl, CAG_SOURCE_CACHE_TTL_SECONDS)
    },
  } as unknown as KVNamespace

  const key = 'cag:src:test'
  const sources = [{
    content: '測試內容',
    href: 'https://archive.tw/demo#s1',
    label: '示範',
    sectionId: 1,
  }]

  assert.equal(await getCachedCagSources(kv, key), null)
  await putCachedCagSources(kv, key, sources)
  assert.deepEqual(await getCachedCagSources(kv, key), sources)
})

test('getCachedCagSources rejects malformed payloads', async () => {
  const kv = {
    async get() {
      return JSON.stringify([{ content: 'missing fields' }])
    },
  } as unknown as KVNamespace
  assert.equal(await getCachedCagSources(kv, 'cag:src:bad'), null)
})