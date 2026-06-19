import assert from 'node:assert/strict'
import test from 'node:test'

import app from '../src/index'

// 受信任呼叫端 token bypass（鏡像 sayit-hono 的 AUDREYT_TRANSCRIPT_TOKEN）：
// 帶有效 `Authorization: Bearer <token>` 的自動化工具，略過限流、黑名單與全域預算；
// 不帶（或 token 不符）時，仍照原本的限流／黑名單路徑被擋下。
//
// 與既有測試（capacity.test.ts）一致：用 app.request(path, init, env) 直接打路由，
// 並以最小的 RATE_LIMITER / ABUSE_DB / RATE_LIMIT_DO stub 觸發各道閘門。

const TOKEN = 'trusted-tooling-token'
const AUTH = { Authorization: `Bearer ${TOKEN}` }
// 非瀏覽器的自動化 User-Agent，外加來源 IP 讓限流／黑名單有 key 可比對。
const AUTOMATED = { 'User-Agent': 'curl/8.7.1', 'cf-connecting-ip': '203.0.113.55' }

// 被擋下的路徑會用 c.executionCtx.waitUntil 在背景寫 abuse log；app.request 預設不帶
// executionCtx，故提供一個 no-op stub（與真實 Worker runtime 行為一致）。
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

// 統一帶上 executionCtx 的 app.request 包裝。
function request(
  path: string,
  init: RequestInit,
  env: Record<string, unknown>,
): Promise<Response> {
  return app.request(path, init, env, ctx)
}

// 永遠回「超量」的內建限流 stub → isIpRateLimited 為 true（未受信任時應 429）。
function rateLimitedEnv(extra: Record<string, unknown> = {}) {
  return {
    RATE_LIMITER: {
      limit: async () => ({ success: false }),
    },
    ...extra,
  }
}

// 永遠命中黑名單的 D1 stub（isBlacklisted 的 SELECT … first() 回傳一列）→ 未受信任時應 403。
function blacklistedEnv(extra: Record<string, unknown> = {}) {
  return {
    ABUSE_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ key: 'ip:203.0.113.55' }),
        }),
      }),
    },
    ...extra,
  }
}

// 受信任路徑穿過閘門後會走到生成階段（檢索→AI）；測試不想打真實 archive.tw，
// 故把 AI binding 設成一拋就回的 stub——讓 streamCagAnswer 快速結束、不依賴網路。
// 受信任的斷言只看「閘門是否被略過」（限流器/黑名單是否被呼叫、是否回 429/403），
// 不看最終生成結果。
const throwingAi = {
  AI: {
    run: async () => {
      throw new Error('stub: no real generation in tests')
    },
  },
}

// ── 限流 bypass ────────────────────────────────────────────────────────────

test('GET /cag/:question is rate limited for an automated request without the token', async () => {
  const res = await request(
    '/cag/' + encodeURIComponent('萌典是什麼'),
    { headers: AUTOMATED },
    rateLimitedEnv(),
  )
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('Retry-After'), '3')
})

test('GET /cag/:question bypasses the rate limit with a valid AUDREYT_TRANSCRIPT_TOKEN', async () => {
  let limiterCalled = false
  const env = {
    AUDREYT_TRANSCRIPT_TOKEN: TOKEN,
    RATE_LIMITER: {
      limit: async () => {
        limiterCalled = true
        return { success: false }
      },
    },
    ...throwingAi,
  }
  const res = await request(
    '/cag/' + encodeURIComponent('萌典是什麼'),
    { headers: { ...AUTOMATED, ...AUTH } },
    env,
  )
  // 受信任 → 不是 429（生成階段因 stub AI 失敗，但已穿過限流閘門）。
  assert.notEqual(res.status, 429)
  // 關鍵：受信任路徑根本不呼叫限流器。
  assert.equal(limiterCalled, false)
})

test('GET /au/:question is rate limited without the token but bypasses with it', async () => {
  const blocked = await request(
    '/au/' + encodeURIComponent('你怎麼看開放政府'),
    { headers: AUTOMATED },
    rateLimitedEnv(),
  )
  assert.equal(blocked.status, 429)

  // 受信任：限流器不應被呼叫（閘門被略過）。
  let limiterCalled = false
  await request(
    '/au/' + encodeURIComponent('你怎麼看開放政府'),
    { headers: { ...AUTOMATED, ...AUTH } },
    {
      AUDREYT_TRANSCRIPT_TOKEN: TOKEN,
      RATE_LIMITER: { limit: async () => { limiterCalled = true; return { success: false } } },
      ...throwingAi,
    },
  )
  assert.equal(limiterCalled, false)
})

test('POST /au is rate limited without the token but bypasses with it', async () => {
  const body = JSON.stringify({ question: '什麼是協作式民主' })
  const blocked = await request(
    '/au',
    { method: 'POST', headers: { ...AUTOMATED, 'Content-Type': 'application/json' }, body },
    rateLimitedEnv(),
  )
  assert.equal(blocked.status, 429)

  // 受信任：限流器不應被呼叫（閘門被略過）。
  let limiterCalled = false
  await request(
    '/au',
    {
      method: 'POST',
      headers: { ...AUTOMATED, ...AUTH, 'Content-Type': 'application/json' },
      body,
    },
    {
      AUDREYT_TRANSCRIPT_TOKEN: TOKEN,
      RATE_LIMITER: { limit: async () => { limiterCalled = true; return { success: false } } },
      ...throwingAi,
    },
  )
  assert.equal(limiterCalled, false)
})

// ── 黑名單 / abuse bypass ──────────────────────────────────────────────────

test('GET /ask/:question is blocked by the blacklist without the token', async () => {
  const res = await request(
    '/ask/' + encodeURIComponent('萌典'),
    { headers: AUTOMATED },
    blacklistedEnv(),
  )
  assert.equal(res.status, 403)
})

test('GET /ask/:question bypasses the blacklist with a valid token', async () => {
  let blacklistChecked = false
  const env = {
    AUDREYT_TRANSCRIPT_TOKEN: TOKEN,
    ABUSE_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            blacklistChecked = true
            return { key: 'ip:203.0.113.55' }
          },
        }),
      }),
    },
  }
  const res = await request(
    '/ask/' + encodeURIComponent('萌典'),
    { headers: { ...AUTOMATED, ...AUTH } },
    env,
  )
  // 受信任 → 不是黑名單 403（無 ASK_INDEX，最終會 404/500，但已穿過黑名單閘門）。
  assert.notEqual(res.status, 403)
  // 關鍵：受信任路徑根本不查黑名單。
  assert.equal(blacklistChecked, false)
})

test('GET /cag/:question bypasses the blacklist with a valid token', async () => {
  const blocked = await request(
    '/cag/' + encodeURIComponent('萌典'),
    { headers: AUTOMATED },
    blacklistedEnv(),
  )
  assert.equal(blocked.status, 403)

  const bypassed = await request(
    '/cag/' + encodeURIComponent('萌典'),
    { headers: { ...AUTOMATED, ...AUTH } },
    blacklistedEnv({ AUDREYT_TRANSCRIPT_TOKEN: TOKEN, ...throwingAi }),
  )
  assert.notEqual(bypassed.status, 403)
})

// ── 全域生成預算 bypass ────────────────────────────────────────────────────

test('GET /cag/:question bypasses the exhausted global generation budget with a valid token', async () => {
  // budget DO 永遠回「配額用罄」；未受信任時 /cag 應回 429（budget 訊息）。
  const budgetExhausted = (extra: Record<string, unknown> = {}) => ({
    RATE_LIMIT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          const url = new URL(String(input))
          if (url.pathname === '/quota') {
            return Response.json({ allowed: false, reason: 'minute', retryAfterSeconds: 42 })
          }
          // per-key 冷卻檢查：放行（讓請求走到 budget 閘門）。
          return Response.json({ allowed: true })
        },
      }),
    },
    ...extra,
  })

  const blocked = await request(
    '/cag/' + encodeURIComponent('萌典是什麼'),
    { headers: AUTOMATED },
    budgetExhausted(),
  )
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get('Retry-After'), '42')

  const bypassed = await request(
    '/cag/' + encodeURIComponent('萌典是什麼'),
    { headers: { ...AUTOMATED, ...AUTH } },
    budgetExhausted({ AUDREYT_TRANSCRIPT_TOKEN: TOKEN, ...throwingAi }),
  )
  // 受信任 → 不被全域預算擋下（生成階段因 stub AI 失敗，但已穿過預算閘門）。
  assert.notEqual(bypassed.status, 429)
})

// ── token 不符 / 缺 secret 時不放行 ─────────────────────────────────────────

test('a wrong bearer token does not bypass the rate limit', async () => {
  const res = await request(
    '/cag/' + encodeURIComponent('萌典是什麼'),
    { headers: { ...AUTOMATED, Authorization: 'Bearer wrong-token' } },
    rateLimitedEnv({ AUDREYT_TRANSCRIPT_TOKEN: TOKEN }),
  )
  assert.equal(res.status, 429)
})

test('the token has no effect when AUDREYT_TRANSCRIPT_TOKEN secret is unset', async () => {
  // secret 未綁時，任何 Bearer 都不應放行（verifyTranscriptToken 無 allowed → false）。
  const res = await request(
    '/cag/' + encodeURIComponent('萌典是什麼'),
    { headers: { ...AUTOMATED, ...AUTH } },
    rateLimitedEnv(),
  )
  assert.equal(res.status, 429)
})
