import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCacheKey,
  CACHE_TTL_MS,
  getCachedResponse,
  putCachedResponse,
} from '../src/utils/cache'

// 最小 R2Bucket 假物件：以記憶體 Map 模擬 put/get/delete，並可注入 uploaded 時間以測過期。
function createFakeBucket(now = Date.now()) {
  const store = new Map<
    string,
    { body: string; contentType?: string; uploaded: Date }
  >()
  return {
    store,
    async put(
      key: string,
      body: string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      store.set(key, {
        body,
        contentType: opts?.httpMetadata?.contentType,
        uploaded: new Date(now),
      })
    },
    async get(key: string) {
      const entry = store.get(key)
      if (!entry) return null
      return {
        uploaded: entry.uploaded,
        httpMetadata: { contentType: entry.contentType },
        async text() {
          return entry.body
        },
      }
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
}

test('buildCacheKey 區分 scope 且對相同輸入穩定', async () => {
  const ask = await buildCacheKey('ask', '地神香火如何')
  const cag = await buildCacheKey('cag', '地神香火如何')
  assert.ok(ask.startsWith('cache/ask/'))
  assert.ok(cag.startsWith('cache/cag/'))
  assert.notEqual(ask, cag)
  assert.equal(ask, await buildCacheKey('ask', '地神香火如何'))
})

test('buildCacheKey 正規化空白與大小寫', async () => {
  const a = await buildCacheKey('ask', '  Hello   World ')
  const b = await buildCacheKey('ask', 'hello world')
  assert.equal(a, b)
})

test('buildCacheKey 參數順序無關、但參數值不同則 key 不同', async () => {
  const a = await buildCacheKey('cag', 'q', { model: 'm', topK: 6 })
  const b = await buildCacheKey('cag', 'q', { topK: 6, model: 'm' })
  const c = await buildCacheKey('cag', 'q', { model: 'm', topK: 4 })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('put 後 get 命中並保留 contentType', async () => {
  const bucket = createFakeBucket()
  const key = await buildCacheKey('ask', 'q')
  await putCachedResponse(bucket as never, key, '<p>hi</p>', 'text/html; charset=UTF-8')
  const hit = await getCachedResponse(bucket as never, key)
  assert.deepEqual(hit, { body: '<p>hi</p>', contentType: 'text/html; charset=UTF-8' })
})

test('超過 7 天視為未命中並刪除', async () => {
  const stale = Date.now() - CACHE_TTL_MS - 1000
  const bucket = createFakeBucket(stale)
  const key = await buildCacheKey('cag', 'q')
  await putCachedResponse(bucket as never, key, 'old', 'text/markdown')
  const hit = await getCachedResponse(bucket as never, key)
  assert.equal(hit, null)
  assert.equal(bucket.store.has(key), false)
})

test('未綁 bucket 時 get/put 優雅降級', async () => {
  assert.equal(await getCachedResponse(undefined, 'cache/ask/x'), null)
  await putCachedResponse(undefined, 'cache/ask/x', 'body', 'text/plain')
})
