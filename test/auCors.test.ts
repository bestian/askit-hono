import assert from 'node:assert/strict'
import test from 'node:test'

import app from '../src/index'

// /au 的 GET CORS 對齊 /cag（OPTIONS 預檢 + 各回應分支都帶 CORS）。
// 用同一組斷言跑過兩條路由，鎖住「兩者 CORS 行為一致」這個對齊：日後任一條
// 漏掉 applyAskCors 或 OPTIONS 註冊，這裡就會紅。打法沿用 capacity/cag 測試的
// app.request(path, init, env, ctx) + 最小 stub env。

const ALLOWED_ORIGIN = 'https://archive.tw'
const UNLISTED_ORIGIN = 'https://evil.example'

// 答案端點（/cag、/au）共用的 CORS 常數；與 src/index.ts 的 ASK_CORS_* 對齊。
const EXPECTED_METHODS = 'GET, OPTIONS'
const EXPECTED_HEADERS = 'Content-Type'
const EXPECTED_MAX_AGE = '600'

// app.request 預設不帶 executionCtx；被擋下的分支會 waitUntil 背景寫 abuse log，
// 故提供 no-op stub（與真實 Worker runtime 一致）。
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext

// 命中即回固定內容的 R2 cache stub（忽略 key）→ GET 走「快取命中」分支回 200。
function cachedBucket(body: string, contentType: string) {
  return {
    async get() {
      return {
        uploaded: new Date(),
        httpMetadata: { contentType },
        async text() {
          return body
        },
      }
    },
    async put() {},
    async delete() {},
  }
}

// 永遠回「超量」的內建限流 stub → 未受信任時 isIpRateLimited 為 true、GET 回 429。
function rateLimitedEnv() {
  return { RATE_LIMITER: { limit: async () => ({ success: false }) } }
}

// 一個短問題，兩條路由共用；ASCII 即可，cache stub 不在意實際 key。
const QUESTION = 'hello'

for (const route of ['cag', 'au'] as const) {
  const path = `/${route}/${QUESTION}`

  test(`OPTIONS ${path} returns CORS preflight headers for archive.tw`, async () => {
    const res = await app.request(
      path,
      { method: 'OPTIONS', headers: { Origin: ALLOWED_ORIGIN } },
      {},
      ctx,
    )

    assert.equal(res.status, 204)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), EXPECTED_METHODS)
    assert.equal(res.headers.get('Access-Control-Allow-Headers'), EXPECTED_HEADERS)
    assert.equal(res.headers.get('Access-Control-Max-Age'), EXPECTED_MAX_AGE)
  })

  test(`OPTIONS ${path} does not echo CORS for unlisted origins`, async () => {
    const res = await app.request(
      path,
      { method: 'OPTIONS', headers: { Origin: UNLISTED_ORIGIN } },
      {},
      ctx,
    )

    assert.equal(res.status, 204)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
  })

  test(`GET ${path} carries CORS headers for archive.tw on a cached answer`, async () => {
    const res = await app.request(
      path,
      { headers: { Origin: ALLOWED_ORIGIN } },
      {
        ASK_CACHE: cachedBucket('cached answer', 'text/markdown; charset=UTF-8'),
      },
      ctx,
    )

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), EXPECTED_METHODS)
    assert.equal(res.headers.get('Access-Control-Allow-Headers'), EXPECTED_HEADERS)
    assert.match(res.headers.get('Vary') ?? '', /\bOrigin\b/)
  })

  test(`GET ${path} does not echo CORS for unlisted origins`, async () => {
    const res = await app.request(
      path,
      { headers: { Origin: UNLISTED_ORIGIN } },
      {
        ASK_CACHE: cachedBucket('cached answer', 'text/markdown; charset=UTF-8'),
      },
      ctx,
    )

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
  })

  test(`GET ${path} carries CORS headers on an early-return (429) for archive.tw`, async () => {
    const res = await app.request(
      path,
      { headers: { Origin: ALLOWED_ORIGIN, 'cf-connecting-ip': '203.0.113.10' } },
      rateLimitedEnv(),
      ctx,
    )

    assert.equal(res.status, 429)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
    assert.equal(res.headers.get('Retry-After'), '3')
  })
}
