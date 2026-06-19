import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import app, { WEB_MESSAGES, webMessage } from '../src/index'
import {
  NOT_FOUND_REPLY_HTML,
  NOT_FOUND_REPLY_HTML_EN,
} from '../src/utils/notFoundReply'

test('zh-Hant web messages stay byte-identical to the historical literals', () => {
  const zh = WEB_MESSAGES['zh-Hant']
  assert.equal(
    zh.notFound,
    '您的問題超出了資料庫的範圍，\n逐字稿網站連結如下：https://archive.tw',
  )
  assert.equal(zh.rateLimited, '您的發問過於頻繁，請稍候約 3 秒再試，謝謝 🙏')
  assert.equal(zh.tooLong, '您的問題字數過長，請縮短問題的長度，謝謝!')
  assert.equal(zh.budget, '目前服務量已達上限，請稍後再試，謝謝')
})

test('en web messages carry the agreed wording', () => {
  const en = WEB_MESSAGES.en
  assert.equal(
    en.notFound,
    'Your question is outside the scope of this archive.\nBrowse the transcripts at https://archive.tw',
  )
  assert.equal(
    en.rateLimited,
    'You are asking a bit too quickly — please wait about 3 seconds and try again 🙏',
  )
  assert.equal(
    en.tooLong,
    'Your question is too long — please shorten it and try again. Thank you!',
  )
  assert.equal(
    en.budget,
    'The service has reached its generation budget for now — please try again later 🙏',
  )
})

test('zh-Hant and en web message tables stay in key parity', () => {
  assert.deepEqual(
    Object.keys(WEB_MESSAGES['zh-Hant']).sort(),
    Object.keys(WEB_MESSAGES.en).sort(),
  )
})

test('webMessage helper resolves keys per language', () => {
  assert.equal(webMessage('tooLong', 'en'), WEB_MESSAGES.en.tooLong)
  assert.equal(webMessage('tooLong', 'zh-Hant'), WEB_MESSAGES['zh-Hant'].tooLong)
  assert.equal(webMessage('notFound', 'en'), WEB_MESSAGES.en.notFound)
  assert.equal(webMessage('budget', 'zh-Hant'), WEB_MESSAGES['zh-Hant'].budget)
})

test('web app submits questions to the Audrey skill endpoint', async () => {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  assert.ok(appJs.includes("fetch('/au/' + encodeURIComponent(query)"))
  assert.equal(appJs.includes("fetch('/cag/' + encodeURIComponent(query)"), false)
})

test('GET /cag/:question localises the too-long guard via ?lang=en', async () => {
  const longQuestion = encodeURIComponent('問'.repeat(101))

  const en = await app.request(`/cag/${longQuestion}?lang=en`)
  assert.equal(en.status, 400)
  assert.equal(await en.text(), WEB_MESSAGES.en.tooLong)

  const zh = await app.request(`/cag/${longQuestion}`)
  assert.equal(zh.status, 400)
  assert.equal(await zh.text(), WEB_MESSAGES['zh-Hant'].tooLong)
})

test('GET /cag/:question localises the global-budget message via ?lang=en', async () => {
  const makeEnv = () => ({
    AI: {
      run: async () => {
        throw new Error('AI should not be called when the budget is exhausted')
      },
    },
    RATE_LIMIT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          Response.json({
            allowed: false,
            reason: 'minute',
            retryAfterSeconds: 17,
          }),
      }),
    },
  })

  const en = await app.request(
    '/cag/%E6%B8%AC%E8%A9%A6?lang=en',
    undefined,
    makeEnv(),
  )
  assert.equal(en.status, 429)
  assert.equal(en.headers.get('Retry-After'), '17')
  assert.equal(await en.text(), WEB_MESSAGES.en.budget)

  const zh = await app.request('/cag/%E6%B8%AC%E8%A9%A6', undefined, makeEnv())
  assert.equal(zh.status, 429)
  assert.equal(await zh.text(), WEB_MESSAGES['zh-Hant'].budget)
})

test('GET /cag/:question localises the not-found 404 via ?lang=en', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ results: [] })
  const makeEnv = () => ({
    AI: {
      run: async (_model: string, input: Record<string, unknown>) => {
        if ('text' in input) return { data: [[0.1, 0.2, 0.3]] }
        throw new Error('completion should not run without sources')
      },
    },
    VECTORIZE: {
      query: async () => ({ matches: [] }),
    },
    CAG_RETRIEVER: 'vectorize',
  })

  try {
    const en = await app.request(
      '/cag/%E6%B8%AC%E8%A9%A6?lang=en',
      undefined,
      makeEnv(),
    )
    assert.equal(en.status, 404)
    assert.equal(await en.text(), NOT_FOUND_REPLY_HTML_EN)

    // zh 行為不變：沿用 streamCagAnswer 既有的 404 HTML 內文（issue #29）。
    const zh = await app.request('/cag/%E6%B8%AC%E8%A9%A6', undefined, makeEnv())
    assert.equal(zh.status, 404)
    assert.equal(await zh.text(), NOT_FOUND_REPLY_HTML)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /cag/:question localises the rate-limit message via ?lang=en', async () => {
  const makeEnv = () => ({
    RATE_LIMITER: {
      limit: async () => ({ success: false }),
    },
  })
  const headers = { 'cf-connecting-ip': '203.0.113.10' }
  // 限流路徑會呼叫 reportAbuse → c.executionCtx.waitUntil，測試需提供 ctx。
  const waitUntilPromises: Promise<unknown>[] = []
  const makeCtx = () => ({
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise)
    },
    passThroughOnException: () => {},
    props: {},
  })

  const en = await app.request(
    '/cag/%E6%B8%AC%E8%A9%A6?lang=en',
    { headers },
    makeEnv(),
    makeCtx(),
  )
  assert.equal(en.status, 429)
  assert.equal(en.headers.get('Retry-After'), '3')
  assert.equal(await en.text(), WEB_MESSAGES.en.rateLimited)

  const zh = await app.request('/cag/%E6%B8%AC%E8%A9%A6', { headers }, makeEnv(), makeCtx())
  assert.equal(zh.status, 429)
  assert.equal(await zh.text(), WEB_MESSAGES['zh-Hant'].rateLimited)
  await Promise.all(waitUntilPromises)
})

test('GET /cag falls back to archive retrieval for Han-free questions when Vectorize is empty', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/search.json')) {
      return Response.json({
        results: [{
          title: '2024-01-01 Plurality talk',
          url: '/2024-01-01-plurality-talk#s123',
          date: '2024-01-01',
          speaker: 'Audrey Tang',
          snippet: 'Plurality is collaborative diversity',
        }],
      })
    }
    if (url.includes('/api/section/123')) {
      return Response.json({
        section_id: 123,
        section_content: 'Plurality means collaborative diversity across social differences.',
        display_name: '2024-01-01 Plurality talk',
        name: 'Audrey Tang',
      })
    }
    return new Response('not found', { status: 404 })
  }
  const waitUntilPromises: Promise<unknown>[] = []
  try {
    const response = await app.request(
      '/cag/What%20is%20Plurality%3F?lang=en',
      undefined,
      {
        AI: {
          run: async (_model: string, input: Record<string, unknown>) => {
            if ('text' in input) return { data: [[0.1, 0.2, 0.3]] }
            return 'Plurality is collaborative diversity. [1]'
          },
        },
        VECTORIZE: { query: async () => ({ matches: [] }) },
        CAG_RETRIEVER: 'vectorize',
      },
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(promise)
        },
        passThroughOnException: () => {},
        props: {},
      },
    )
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /Plurality is collaborative diversity/)
    assert.match(text, /\[\^1\]/)
    await Promise.all(waitUntilPromises)
  } finally {
    globalThis.fetch = originalFetch
  }
})
