import assert from 'node:assert/strict'
import test from 'node:test'

import app, { capacityFraction, capacityStatus, RateLimiterDO } from '../src/index'

// ── capacityFraction（純函式）─────────────────────────────────────────────
// 取分鐘/每日兩窗較緊者的剩餘占比，夾在 [0,1]、向下取到小數兩位（issue #40）。

test('capacityFraction reports full capacity when both windows are empty', () => {
  assert.equal(capacityFraction(0, 30, 0, 1000), 1)
})

test('capacityFraction binds on the more-constrained window', () => {
  // 分鐘窗剩 7/10 = 0.7、每日窗剩 50/100 = 0.5 → 取較緊者 0.5。
  assert.equal(capacityFraction(3, 10, 50, 100), 0.5)
})

test('capacityFraction floors to two decimals (never rounds up)', () => {
  // 2/3 = 0.666… → 向下取到 0.66，寧可低估不可高估。
  assert.equal(capacityFraction(1, 3, 0, 1000), 0.66)
})

test('capacityFraction clamps to 0 when a window is exhausted or overshot', () => {
  assert.equal(capacityFraction(30, 30, 0, 1000), 0)
  assert.equal(capacityFraction(40, 30, 0, 1000), 0)
})

test('capacityFraction returns 0 for a non-positive limit instead of NaN', () => {
  assert.equal(capacityFraction(0, 0, 0, 1000), 0)
})

test('capacityStatus maps capacity to coarse public states', () => {
  assert.equal(capacityStatus(1), 'available')
  assert.equal(capacityStatus(0.6), 'available')
  assert.equal(capacityStatus(0.59), 'busy')
  assert.equal(capacityStatus(0.3), 'busy')
  assert.equal(capacityStatus(0.29), 'full')
  assert.equal(capacityStatus(0), 'full')
})

// ── RateLimiterDO /capacity（唯讀、不消耗額度）────────────────────────────

function fakeBudgetState(initial: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const writes: string[] = []
  const storage = {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      writes.push(key)
      store.set(key, value)
    },
  }
  return { storage, writes }
}

test('RateLimiterDO /capacity reads buckets without consuming budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const { storage, writes } = fakeBudgetState({
    'quota:minute': { windowStartMs: 0, count: 3 },
    'quota:day': { windowStartMs: 0, count: 50 },
  })
  const doInstance = new RateLimiterDO({ storage } as unknown as DurableObjectState)

  const res = await doInstance.fetch(
    new Request('https://rate-limit/capacity?minute_limit=10&day_limit=100'),
  )

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { capacity: 0.5 })
  // 關鍵：唯讀，沒有任何寫回 → 不增計數、不消耗額度。
  assert.deepEqual(writes, [])
})

test('RateLimiterDO /capacity treats rolled-over windows as empty', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const { storage, writes } = fakeBudgetState({
    // 舊視窗（前一分鐘）的計數，視窗已輪替 → 計數視為 0。
    'quota:minute': { windowStartMs: -60_000, count: 9 },
    'quota:day': { windowStartMs: 0, count: 0 },
  })
  const doInstance = new RateLimiterDO({ storage } as unknown as DurableObjectState)

  const res = await doInstance.fetch(
    new Request('https://rate-limit/capacity?minute_limit=10&day_limit=100'),
  )

  assert.deepEqual(await res.json(), { capacity: 1 })
  assert.deepEqual(writes, [])
})

// ── GET /capacity 端點 ────────────────────────────────────────────────────

test('GET /capacity returns the budget DO capacity as a coarse status', async () => {
  const fetched: string[] = []
  const env = {
    RATE_LIMIT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          fetched.push(String(input))
          return Response.json({ capacity: 0.42 })
        },
      }),
    },
  }

  const res = await app.request('/capacity', undefined, env)

  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=5, s-maxage=5')
  assert.deepEqual(await res.json(), { status: 'busy' })
  // 打到 budget DO 的唯讀 /capacity，並帶上目前的分鐘/每日上限。
  const url = new URL(fetched[0])
  assert.equal(url.pathname, '/capacity')
  assert.equal(url.searchParams.get('minute_limit'), '30')
  assert.equal(url.searchParams.get('day_limit'), '1000')
})

test('GET /capacity forwards configured generation limits to the DO', async () => {
  const fetched: string[] = []
  const env = {
    GLOBAL_GENERATION_LIMIT_PER_MINUTE: '12',
    GLOBAL_GENERATION_LIMIT_PER_DAY: '500',
    RATE_LIMIT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          fetched.push(String(input))
          return Response.json({ capacity: 0.9 })
        },
      }),
    },
  }

  const res = await app.request('/capacity', undefined, env)
  assert.equal(res.status, 200)
  const url = new URL(fetched[0])
  assert.equal(url.searchParams.get('minute_limit'), '12')
  assert.equal(url.searchParams.get('day_limit'), '500')
})

test('GET /capacity reports full capacity when no budget DO is bound', async () => {
  const res = await app.request('/capacity', undefined, {})
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'available' })
})

test('GET /capacity is rate limited with an independent per-IP key and window', async () => {
  const seen: { key: string }[] = []
  const env = {
    RATE_LIMITER: {
      limit: async (options: { key: string }) => {
        seen.push(options)
        return { success: false }
      },
    },
  }
  const res = await app.request(
    '/capacity',
    { headers: { 'cf-connecting-ip': '203.0.113.10' } },
    env,
  )
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('Retry-After'), '5')
  assert.deepEqual(seen, [{ key: 'capacity:ip:203.0.113.10' }])
})

test('GET /capacity uses the independent DO key and window when the precise limiter runs', async () => {
  const calls: { id: string; url: string }[] = []
  const env = {
    RATE_LIMIT_DO: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (input: RequestInfo | URL) => {
          const url = String(input)
          calls.push({ id, url })
          if (id.startsWith('capacity:')) return Response.json({ allowed: true })
          return Response.json({ capacity: 0.7 })
        },
      }),
    },
  }

  const res = await app.request(
    '/capacity',
    { headers: { 'cf-connecting-ip': '203.0.113.10' } },
    env,
  )

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'available' })
  assert.equal(calls[0].id, 'capacity:ip:203.0.113.10')
  assert.equal(new URL(calls[0].url).searchParams.get('window_ms'), '5000')
  assert.equal(calls[1].id, 'global:generation-budget')
})

test('robots.txt disallows the /capacity endpoint to crawlers', async () => {
  const res = await app.request('/robots.txt')
  const body = await res.text()
  assert.match(body, /^Disallow: \/capacity$/m)
})
