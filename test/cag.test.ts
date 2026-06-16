import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'

import Fuse from 'fuse.js'
import app, { ipRateLimitKeyFromIp, resolveWelcomeLang } from '../src/index'
import { en_welcome, zh_welcome } from '../src/line_welcome/follow'
import {
  ASK_FUSE_OPTIONS,
  ASK_INDEX_R2_KEY,
  ASK_INDEX_VERSION,
  manifestKeyForIndexKey,
  type SectionRow,
} from '../src/utils/askIndexFormat'
import {
  buildCagMessages,
  buildCagQueryVariants,
  buildCagRetrievalQueries,
  DEFAULT_CAG_MODEL,
  DEFAULT_TOP_K,
  detectCagAnswerLanguage,
  markdownCitationFootnotes,
  normalizeCagOptions,
  parseArchiveSectionId,
  retrieveCagSources,
} from '../src/utils/cag'
import { NOT_FOUND_REPLY_HTML } from '../src/utils/notFoundReply'
import {
  findClosestMatchingSection,
  formatCagAnswerFlex,
  formatFuseAnswerFlex,
} from '../src/utils/search'
import type { VectorizeBinding } from '../src/utils/vectorize'
import { loadAppTestHooks } from './helpers/loadApp'

type AskIndexBucket = Parameters<typeof findClosestMatchingSection>[0]

function sameRealmJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertSecurityHeaders(response: Response) {
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/)
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=15552000; includeSubDomains')
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin')
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin')
  assert.equal(response.headers.get('Origin-Agent-Cluster'), '?1')
  assert.equal(response.headers.get('X-DNS-Prefetch-Control'), 'off')
  assert.equal(response.headers.get('X-Download-Options'), 'noopen')
  assert.equal(response.headers.get('X-Permitted-Cross-Domain-Policies'), 'none')
  assert.equal(response.headers.get('X-XSS-Protection'), '0')

  const permissionsPolicy = response.headers.get('Permissions-Policy') ?? ''
  assert.match(permissionsPolicy, /camera=\(\)/)
  assert.match(permissionsPolicy, /geolocation=\(\)/)
  assert.match(permissionsPolicy, /microphone=\(\)/)
}

function createAskRows(): SectionRow[] {
  return [
    {
      filename: '2024-01-01-demo',
      nest_filename: null,
      section_id: 123,
      section_speaker: '唐鳳',
      section_content: '地神香火測試內容',
      display_name: '示範會議',
      name: '唐鳳',
    },
  ]
}

function createAskIndexPayload(rows: SectionRow[] = createAskRows()) {
  return {
    v: ASK_INDEX_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    speakerLike: '%唐鳳%',
    rowCount: rows.length,
    rows,
    index: Fuse.createIndex(ASK_FUSE_OPTIONS.keys as string[], rows).toJSON(),
  }
}

function createJsonR2Object(json: string, size = new TextEncoder().encode(json).byteLength) {
  const bytes = new TextEncoder().encode(json)
  return {
    size,
    async text() {
      return json
    },
    async arrayBuffer() {
      return new Uint8Array(bytes).buffer
    },
  }
}

async function sha256HexForText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function createAskIndexManifest(indexKey: string, json: string) {
  const rows = createAskRows()
  return {
    v: ASK_INDEX_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    indexKey,
    indexSha256: await sha256HexForText(json),
    indexBytes: new TextEncoder().encode(json).byteLength,
    speakerLike: '%唐鳳%',
    rowCount: rows.length,
    queriedRowCount: rows.length,
    maxSectionChars: 175,
    yearsBack: 2,
    cutoffDate: '2024-01-01',
    d1Database: 'askit',
    local: false,
  }
}

function createAskIndexBucket() {
  const json = JSON.stringify(createAskIndexPayload())

  return {
    async get(key: string) {
      if (key !== ASK_INDEX_R2_KEY) return null
      return createJsonR2Object(json)
    },
  }
}

function createCachedResponseBucket(body: string, contentType: string) {
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

test('ask index loader rejects oversized R2 objects before reading the body', async () => {
  const indexKey = 'ask-index/oversized-test.json'
  let bodyRead = false
  const bucket = {
    async get(key: string) {
      if (key !== indexKey) return null
      return {
        size: 17 * 1024 * 1024,
        async text() {
          bodyRead = true
          return '{}'
        },
        async arrayBuffer() {
          bodyRead = true
          return new ArrayBuffer(0)
        },
      }
    },
  } as unknown as AskIndexBucket

  await assert.rejects(
    () => findClosestMatchingSection(bucket, '地神', { r2Key: indexKey }),
    /索引過大/,
  )
  assert.equal(bodyRead, false)
})

test('ask index loader validates manifest bytes and sha256 before parsing', async () => {
  const json = JSON.stringify(createAskIndexPayload())

  const sizeMismatchKey = 'ask-index/size-mismatch-test.json'
  const sizeMismatchManifest = {
    ...(await createAskIndexManifest(sizeMismatchKey, json)),
    indexBytes: new TextEncoder().encode(json).byteLength + 1,
  }
  const sizeMismatchBucket = {
    async get(key: string) {
      if (key === manifestKeyForIndexKey(sizeMismatchKey)) {
        return createJsonR2Object(JSON.stringify(sizeMismatchManifest))
      }
      if (key === sizeMismatchKey) return createJsonR2Object(json)
      return null
    },
  } as unknown as AskIndexBucket

  await assert.rejects(
    () => findClosestMatchingSection(sizeMismatchBucket, '地神', { r2Key: sizeMismatchKey }),
    /索引大小不符/,
  )

  const hashMismatchKey = 'ask-index/hash-mismatch-test.json'
  const hashMismatchManifest = {
    ...(await createAskIndexManifest(hashMismatchKey, json)),
    indexSha256: '0'.repeat(64),
  }
  const hashMismatchBucket = {
    async get(key: string) {
      if (key === manifestKeyForIndexKey(hashMismatchKey)) {
        return createJsonR2Object(JSON.stringify(hashMismatchManifest))
      }
      if (key === hashMismatchKey) return createJsonR2Object(json)
      return null
    },
  } as unknown as AskIndexBucket

  await assert.rejects(
    () => findClosestMatchingSection(hashMismatchBucket, '地神', { r2Key: hashMismatchKey }),
    /SHA-256 不符/,
  )
})

test('ask index loader rejects malformed payloads and unexpected manifest keys', async () => {
  const malformedKey = 'ask-index/malformed-payload-test.json'
  const malformedJson = JSON.stringify({
    v: ASK_INDEX_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    speakerLike: '%唐鳳%',
    rowCount: 1,
    rows: [],
    index: {},
  })
  const malformedBucket = {
    async get(key: string) {
      if (key === malformedKey) return createJsonR2Object(malformedJson)
      return null
    },
  } as unknown as AskIndexBucket

  await assert.rejects(
    () => findClosestMatchingSection(malformedBucket, '地神', { r2Key: malformedKey }),
    /payload/,
  )

  const indexKey = 'ask-index/manifest-prefix-test.json'
  const outsideKey = 'evil/index.json'
  const requestedKeys: string[] = []
  const manifestJson = JSON.stringify({
    ...(await createAskIndexManifest(indexKey, JSON.stringify(createAskIndexPayload()))),
    indexKey: outsideKey,
  })
  const manifestKeyBucket = {
    async get(key: string) {
      requestedKeys.push(key)
      if (key === manifestKeyForIndexKey(indexKey)) return createJsonR2Object(manifestJson)
      if (key === outsideKey) return createJsonR2Object(JSON.stringify(createAskIndexPayload()))
      return null
    },
  } as unknown as AskIndexBucket
  const originalConsoleError = console.error
  console.error = () => {}
  try {
    await assert.rejects(
      () => findClosestMatchingSection(manifestKeyBucket, '地神', { r2Key: indexKey }),
      /找不到 R2 物件/,
    )
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(requestedKeys.includes(outsideKey), false)
})


test('home page serves self-hosted scripts with CSP', async () => {
  const response = await app.request('/')
  const html = await response.text()
  const csp = response.headers.get('Content-Security-Policy') ?? ''

  assert.equal(response.status, 200)
  assert.match(html, /<script src="\/vendor\/vue\.global\.prod\.js" defer><\/script>/)
  assert.match(html, /<script src="\/app\.js" defer><\/script>/)
  assert.doesNotMatch(html, /unpkg\.com/)
  assert.doesNotMatch(html, /<script>\s*const/)
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /script-src-attr 'none'/)
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp))
  assertSecurityHeaders(response)
})

test('security headers apply to manual responses, cache hits, and CAG streams', async () => {
  const waitUntilPromises: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise)
    },
    passThroughOnException: () => {},
    props: {},
  }

  const askResponse = await app.request(
    '/ask/%E5%9C%B0%E7%A5%9E',
    undefined,
    { ASK_INDEX: createAskIndexBucket() },
    executionCtx,
  )
  assert.equal(askResponse.status, 200)
  assertSecurityHeaders(askResponse)
  assert.match(await askResponse.text(), /地神香火測試內容/)

  const cachedResponse = await app.request(
    '/ask/%E5%9C%B0%E7%A5%9E',
    undefined,
    {
      ASK_CACHE: createCachedResponseBucket(
        '<!doctype html><p>cached</p>',
        'text/html; charset=UTF-8',
      ),
    },
    executionCtx,
  )
  assert.equal(cachedResponse.status, 200)
  assert.equal(cachedResponse.headers.get('X-Cache'), 'HIT')
  assertSecurityHeaders(cachedResponse)
  assert.equal(await cachedResponse.text(), '<!doctype html><p>cached</p>')

  const streamResponse = await app.request(
    '/cag/%E6%B8%AC%E8%A9%A6',
    undefined,
    {
      AI: {
        run: async (_model: string, input: Record<string, unknown>) => {
          if ('text' in input) return { data: [[0.1, 0.2, 0.3]] }
          return { response: '這是串流回答 [1]' }
        },
      },
      VECTORIZE: {
        query: async () => ({
          matches: [
            {
              id: '123',
              score: 0.9,
              metadata: {
                section_id: 123,
                filename: '2024-01-01-demo',
                content: '測試內容',
                display_name: '示範會議',
              },
            },
          ],
        }),
      },
      CAG_RETRIEVER: 'vectorize',
    },
    executionCtx,
  )
  assert.equal(streamResponse.status, 200)
  assertSecurityHeaders(streamResponse)
  assert.match(await streamResponse.text(), /這是串流回答/)
  await Promise.all(waitUntilPromises)
})

test('homepage parser rejects non-http citation URLs and relative URLs', async () => {
  const { isSafeHttpUrl, parseAnswer } = await loadAppTestHooks()

  assert.equal(isSafeHttpUrl('https://archive.tw/demo#s1'), true)
  assert.equal(isSafeHttpUrl('http://archive.tw/demo#s1'), true)
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false)
  assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isSafeHttpUrl('mailto:test@example.com'), false)
  assert.equal(isSafeHttpUrl('/relative/path'), false)
  assert.equal(isSafeHttpUrl('https://archive.tw/demo"onclick="alert'), false)

  const parsed = parseAnswer([
    '回答 [^1] [^2] [^3] [^4]',
    '',
    '[^1]: [JS](javascript:alert(1))',
    '[^2]: [Data](data:text/html,<script>alert(1)</script>)',
    '[^3]: [Relative](/demo#s1)',
    '[^4]: [OK](https://archive.tw/demo#s1)',
  ].join('\n'))

  assert.deepEqual(sameRealmJson(parsed.sources), [
    { index: 4, label: 'OK', href: 'https://archive.tw/demo#s1' },
  ])
  assert.doesNotMatch(parsed.html, /href="javascript:/i)
  assert.doesNotMatch(parsed.html, /href="data:text\/html/i)
  assert.doesNotMatch(parsed.html, /href="\/relative\/path"/i)
})

test('homepage renders out-of-scope errors as sanitized html with archive.tw link', async () => {
  const { formatErrorHtml } = await loadAppTestHooks()
  const html = formatErrorHtml(NOT_FOUND_REPLY_HTML)

  assert.match(html, /<a href="https:\/\/archive\.tw"/)
  assert.doesNotMatch(html, /<script\b/i)
})

test('public CAG returns html not-found body with archive.tw link when retrieval is empty', async () => {
  const env = {
    AI: {
      run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
    },
    VECTORIZE: {
      query: async () => ({ matches: [] }),
    },
    CAG_RETRIEVER: 'vectorize',
  }

  const response = await app.request('/cag/zzzzzz', undefined, env)

  assert.equal(response.status, 404)
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=UTF-8')
  const body = await response.text()
  assert.equal(body, NOT_FOUND_REPLY_HTML)
  assert.match(body, /<a href="https:\/\/archive\.tw"/)
  assert.doesNotMatch(body, /<script\b/i)
})

test('homepage parser escapes html and markdown link attribute breakout payloads', async () => {
  const { parseAnswer } = await loadAppTestHooks()
  const parsed = parseAnswer([
    '<img src=x onerror=alert(1)>',
    '[click](https://example.com/"onclick="alert)',
    '[^1]',
    '',
    '[^1]: [Quote](https://archive.tw/demo"onclick="alert)',
  ].join('\n'))

  assert.doesNotMatch(parsed.html, /<img/i)
  assert.doesNotMatch(parsed.html, /<a[^>]+onclick/i)
  assert.match(parsed.html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(parsed.html, /href="https:\/\/example\.com\/&amp;quot;/)
  assert.deepEqual(sameRealmJson(parsed.sources), [])
})

async function streamToString(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += value
  }
}

async function signLineBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
}

test('buildCagQueryVariants keeps useful Chinese retrieval terms', () => {
  const variants = buildCagQueryVariants('用 #zh-tw 回答：地神香火如何')
  assert.equal(variants[0], '地神香火如何')
  assert.ok(variants.includes('地神'))
  assert.ok(variants.includes('香火'))
})

test('buildCagRetrievalQueries returns primary and fallback search terms', () => {
  const queries = buildCagRetrievalQueries('用 #zh-tw 回答：地神香火如何')
  assert.equal(queries.primary, '地神香火如何')
  assert.equal(queries.fallback, '地神香火')
})

const EN_STOPWORD_SAMPLE = new Set([
  'what', 'who', 'which', 'when', 'where', 'why', 'how',
  'is', 'are', 'do', 'does', 'did', 'can', 'will', 'would', 'should',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'about',
  'your', 'you', 'my', 'we', 'us', 'our', 'it', 'this', 'that',
  'and', 'or', 'not', 'see', 'think', 'view', 'opinion',
])

function assertNoBareStopwordVariants(variants: string[]) {
  for (const variant of variants) {
    assert.ok(
      !EN_STOPWORD_SAMPLE.has(variant.toLowerCase()),
      `variant must not be a bare stopword: ${JSON.stringify(variant)}`,
    )
  }
}

test('buildCagQueryVariants strips English question words down to content terms', () => {
  const variants = buildCagQueryVariants('What is Plurality?')
  assert.deepEqual(variants, ['What is Plurality', 'Plurality'])
  assertNoBareStopwordVariants(variants.slice(1))

  const queries = buildCagRetrievalQueries('What is Plurality?')
  assert.equal(queries.primary, 'Plurality')
  assert.equal(queries.fallback, 'Plurality')
})

test('buildCagRetrievalQueries leads Latin-only questions with the content phrase', () => {
  // archive.tw search is verbatim phrase matching — the full question never hits.
  const openGov = buildCagRetrievalQueries('How do you see open government?')
  assert.equal(openGov.primary, 'open government')
  assert.equal(openGov.fallback, 'government')

  // Non-verbatim phrase remainder: fallback is the longest single content token
  // (stable sort — first of the equal-longest wins).
  const plurality = buildCagRetrievalQueries('Why does Plurality matter for democracy?')
  assert.equal(plurality.primary, 'Plurality matter democracy')
  assert.equal(plurality.fallback, 'Plurality')

  // zh questions keep the original behaviour: full cleaned text first.
  const zh = buildCagRetrievalQueries('用 #zh-tw 回答：地神香火如何')
  assert.equal(zh.primary, '地神香火如何')
  assert.equal(zh.fallback, '地神香火')
})

test('buildCagQueryVariants keeps ALL-CAPS acronyms that collide with stopwords', () => {
  const variants = buildCagQueryVariants('What is your view on US-China relations?')
  assert.ok(variants.includes('US-China relations'), 'US must survive in the remainder phrase')
  assert.ok(variants.includes('US-China'), 'the hyphenated token must survive')
  for (const variant of variants) {
    assert.ok(!/^[^A-Za-z0-9一-鿿]/.test(variant), `variant must not start with punctuation: ${JSON.stringify(variant)}`)
  }
})

test('buildCagQueryVariants keeps multi-word English remainder before single tokens', () => {
  const variants = buildCagQueryVariants('How do you see open government?')
  const remainderIndex = variants.indexOf('open government')
  assert.ok(remainderIndex >= 0, 'must include stripped remainder "open government"')
  for (const [index, variant] of variants.entries()) {
    if (variant.includes(' ')) continue
    assert.ok(
      index > remainderIndex,
      `single token ${JSON.stringify(variant)} must come after the remainder`,
    )
  }
  assertNoBareStopwordVariants(variants.slice(1))
})

test('buildCagQueryVariants keeps short uppercase tokens like AI', () => {
  const variants = buildCagQueryVariants('Will AI control us?')
  assert.ok(variants.includes('AI'), 'ALL-CAPS 2-char tokens must survive the length rule')
  assert.ok(variants.includes('AI control'), 'must include the stripped non-stopword remainder')
  assert.ok(!variants.includes('us'), 'short lowercase stopword tokens must be dropped')
  assert.ok(!variants.includes('Will'), 'auxiliary question words must be dropped')
  assertNoBareStopwordVariants(variants.slice(1))
})

test('normalizeCagOptions defaults topK to tightened profile', () => {
  const options = normalizeCagOptions()
  assert.equal(options.topK, DEFAULT_TOP_K)
})

test('buildCagMessages steers the answer language only when answerLanguage=en', () => {
  const source = { content: '內容', href: 'https://archive.tw/x#s1', label: 'x — 唐鳳', sectionId: 1 }
  const zhSystem = buildCagMessages('What is Plurality?', [source])[0].content
  assert.match(zhSystem, /Use Traditional Chinese/)
  assert.doesNotMatch(zhSystem, /Answer in English/)

  const enSystem = buildCagMessages('What is Plurality?', [source], [], undefined, 'en')[0].content
  assert.match(enSystem, /Answer in English/)
  assert.doesNotMatch(enSystem, /Use Traditional Chinese/)
  assert.equal(normalizeCagOptions({ answerLanguage: 'en' }).answerLanguage, 'en')
})

test('detectCagAnswerLanguage flags English-only questions (issue #37)', () => {
  // 只有英文與符號 → en
  assert.equal(detectCagAnswerLanguage('What is Plurality?'), 'en')
  assert.equal(detectCagAnswerLanguage('Who is Audrey Tang?'), 'en')
  assert.equal(detectCagAnswerLanguage('  AI & web3: what now?!  '), 'en')
  assert.equal(detectCagAnswerLanguage('G7 2024 summit'), 'en')
})

test('detectCagAnswerLanguage leaves anything with Han characters as default zh', () => {
  assert.equal(detectCagAnswerLanguage('什麼是多元宇宙'), undefined)
  // 中英混雜只要含漢字就走預設繁中
  assert.equal(detectCagAnswerLanguage('Plurality 是什麼'), undefined)
  assert.equal(detectCagAnswerLanguage('唐鳳 Audrey Tang'), undefined)
})

test('detectCagAnswerLanguage treats letter-free input as default zh', () => {
  // 無拉丁字母（純符號／數字／空白）不算「英文」，沿用預設繁中
  assert.equal(detectCagAnswerLanguage(''), undefined)
  assert.equal(detectCagAnswerLanguage('   '), undefined)
  assert.equal(detectCagAnswerLanguage('123 + 456 = ?'), undefined)
  assert.equal(detectCagAnswerLanguage('🙏🙏🙏'), undefined)
})

test('resolveWelcomeLang maps profile.language to a welcome language (issue #31)', () => {
  // 以 zh 開頭一律繁中
  assert.equal(resolveWelcomeLang('zh-TW'), 'zh-Hant')
  assert.equal(resolveWelcomeLang('zh-Hant'), 'zh-Hant')
  assert.equal(resolveWelcomeLang('zh-Hans'), 'zh-Hant')
  assert.equal(resolveWelcomeLang('zh-CN'), 'zh-Hant')
  // 其餘語言用英文
  assert.equal(resolveWelcomeLang('en'), 'en')
  assert.equal(resolveWelcomeLang('en-US'), 'en')
  assert.equal(resolveWelcomeLang('ja'), 'en')
  assert.equal(resolveWelcomeLang('ko'), 'en')
  // language 缺席（未授權／非認證帳號）預設繁中
  assert.equal(resolveWelcomeLang(undefined), 'zh-Hant')
  assert.equal(resolveWelcomeLang(''), 'zh-Hant')
})

test('formatCagAnswerFlex localises the source labels per language (issue #38)', () => {
  const sources = [
    {
      content: 'Plurality means collaborative diversity.',
      href: 'https://archive.tw/2024-01-01-plurality#s1',
      label: '2024-01-01 Plurality talk — Audrey Tang',
      sectionId: 1,
    },
  ]

  // 預設（繁中）維持既有字樣
  const zh = JSON.stringify(formatCagAnswerFlex('多元宇宙是什麼 [1]', sources))
  assert.match(zh, /出處 1/)
  assert.match(zh, /前往來源/)
  assert.doesNotMatch(zh, /Source 1/)

  // 全英文提問換成短英文字
  const en = JSON.stringify(formatCagAnswerFlex('Answer [1]', sources, 'en'))
  assert.match(en, /Source 1/)
  assert.match(en, /"label":"Visit"/)
  assert.doesNotMatch(en, /出處/)
  assert.doesNotMatch(en, /前往來源/)
})

test('formatFuseAnswerFlex forwards the language to the source labels (issue #38)', () => {
  const results = [
    {
      content: 'Plurality means collaborative diversity.',
      filename: '2024-01-01-plurality',
      nest_filename: null,
      section_id: 1,
      display_name: '2024-01-01 Plurality talk',
      section_speaker: 'Audrey Tang',
      name: 'Audrey Tang',
    },
  ]

  const en = JSON.stringify(formatFuseAnswerFlex(results, 'en'))
  assert.match(en, /Source 1/)
  assert.match(en, /"label":"Visit"/)
  assert.doesNotMatch(en, /出處/)

  const zh = JSON.stringify(formatFuseAnswerFlex(results))
  assert.match(zh, /出處 1/)
  assert.match(zh, /前往來源/)
})

test('parseArchiveSectionId extracts archive anchors', () => {
  assert.equal(parseArchiveSectionId('https://archive.tw/a/b#s619731'), 619731)
  assert.equal(parseArchiveSectionId('/demo#s42'), 42)
  assert.equal(parseArchiveSectionId('/demo'), null)
})

test('normalizeCagOptions returns effective parameters used by CAG', () => {
  const options = normalizeCagOptions({
    topK: 999,
    citableTopK: 999,
    maxCompletionTokens: 9999,
    archiveBaseUrl: 'https://archive.tw/',
    retriever: 'vectorize',
    vectorizeMinScore: 2,
  })
  assert.equal(options.topK, 8)
  assert.equal(options.citableTopK, 8)
  assert.equal(options.maxCompletionTokens, 4096)
  assert.equal(options.archiveBaseUrl, 'https://archive.tw')
  assert.equal(options.retriever, 'vectorize')
  assert.equal(options.vectorizeMinScore, 2)

  const minimums = normalizeCagOptions({
    topK: 0,
    citableTopK: 0,
    maxCompletionTokens: 0,
  })
  assert.equal(minimums.topK, 1)
  assert.equal(minimums.citableTopK, 1)
  assert.equal(minimums.maxCompletionTokens, 1)
})

test('public CAG endpoint always uses fixed Gemma model', async () => {
  const aiCalls: { model: string; input: Record<string, unknown> }[] = []
  const ai = {
    run: async (model: string, input: Record<string, unknown>) => {
      aiCalls.push({ model, input })
      if ('text' in input) return { data: [[0.1, 0.2, 0.3]] }
      return { response: '測試回答 [1]' }
    },
  }
  const vectorize: VectorizeBinding = {
    query: async () => ({
      matches: [
        {
          id: '123',
          score: 0.9,
          metadata: {
            section_id: 123,
            filename: '2024-01-01-demo',
            content: '測試內容',
            display_name: '示範會議',
          },
        },
      ],
    }),
  }
  const env = {
    AI: ai,
    VECTORIZE: vectorize,
    CAG_RETRIEVER: 'vectorize',
  }
  const executionCtx = {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
    props: {},
  }

  const getResponse = await app.request(
    '/cag/%E6%B8%AC%E8%A9%A6?model=@cf/attacker/expensive-model',
    undefined,
    env,
    executionCtx,
  )
  assert.equal(getResponse.status, 200)
  await getResponse.text()

  const chatModels = aiCalls
    .filter(({ input }) => Array.isArray(input.messages))
    .map(({ model }) => model)
  assert.deepEqual(chatModels, [DEFAULT_CAG_MODEL])
})

test('question endpoints reject questions over 100 characters before retrieval or AI', async () => {
  const message = '您的問題字數過長，請縮短問題的長度，謝謝!'
  const longQuestion = '長'.repeat(101)
  const aiCalls: { model: string; input: Record<string, unknown> }[] = []
  const env = {
    AI: {
      run: async (model: string, input: Record<string, unknown>) => {
        aiCalls.push({ model, input })
        return { response: '不應該被呼叫' }
      },
    },
  }

  const askResponse = await app.request(
    `/ask/${encodeURIComponent(longQuestion)}`,
    undefined,
    env,
  )
  assert.equal(askResponse.status, 400)
  assert.equal(await askResponse.text(), message)

  const getCagResponse = await app.request(
    `/cag/${encodeURIComponent(longQuestion)}`,
    undefined,
    env,
  )
  assert.equal(getCagResponse.status, 400)
  assert.equal(await getCagResponse.text(), message)
  assert.equal(aiCalls.length, 0)
})

test('ask not-found replies wait until the rate-limit cooldown has elapsed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  let settled = false
  const responsePromise = app
    .request(
      `/ask/${encodeURIComponent('zzzzzz')}`,
      undefined,
      { ASK_INDEX: createAskIndexBucket() },
    )
    .then((response) => {
      settled = true
      return response
    })

  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  assert.equal(settled, false)

  const response = await resolveAfterCooldown(responsePromise, t)
  assert.equal(response.status, 404)
  assert.equal(Date.now(), 10_000)
})

test('webhook rejects oversized request bodies', async () => {
  const oversizedQuestion = '長'.repeat(33 * 1024)

  const webhookResponse = await app.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ message: { type: 'text', text: oversizedQuestion } }] }),
  })
  assert.equal(webhookResponse.status, 413)
  assert.equal(await webhookResponse.text(), 'Request body too large')
})

test('IPv6 rate limit keys are bucketed by /64 prefix', () => {
  assert.equal(ipRateLimitKeyFromIp('203.0.113.10'), 'ip:203.0.113.10')
  assert.equal(
    ipRateLimitKeyFromIp('2001:db8:abcd:0012::1'),
    'ip6:2001:db8:abcd:12::/64',
  )
  assert.equal(
    ipRateLimitKeyFromIp('2001:0db8:abcd:12:ffff::abcd'),
    'ip6:2001:db8:abcd:12::/64',
  )
})

test('global generation budget blocks uncached CAG before AI', async () => {
  const aiCalls: Record<string, unknown>[] = []
  const quotaUrls: string[] = []
  const env = {
    AI: {
      run: async (_model: string, input: Record<string, unknown>) => {
        aiCalls.push(input)
        return { response: '不應該被呼叫' }
      },
    },
    RATE_LIMIT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          quotaUrls.push(String(input))
          return Response.json({
            allowed: false,
            reason: 'minute',
            retryAfterSeconds: 17,
          })
        },
      }),
    },
  }

  const response = await app.request('/cag/%E6%B8%AC%E8%A9%A6', undefined, env)

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('Retry-After'), '17')
  assert.equal(await response.text(), '目前服務量已達上限，請稍後再試，謝謝')
  assert.equal(aiCalls.length, 0)
  assert.equal(new URL(quotaUrls[0]).pathname, '/quota')
})

async function resolveAfterCooldown<T>(promise: Promise<T>, t: TestContext): Promise<T> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  t.mock.timers.tick(10_000)
  return promise
}

test('public CAG does not cache blank, short, or known-bad streamed answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const badAnswers = [
    '   ',
    '太短',
    '查詢發生錯誤，請稍後再試',
  ]

  for (const answer of badAnswers) {
    const cachedBodies: string[] = []
    const waitUntilPromises: Promise<unknown>[] = []
    const env = {
      ASK_CACHE: {
        async get() {
          return null
        },
        async put(_key: string, body: string) {
          cachedBodies.push(body)
        },
      },
      AI: {
        run: async (_model: string, input: Record<string, unknown>) => {
          if ('text' in input) return { data: [[0.1, 0.2, 0.3]] }
          return { response: answer }
        },
      },
      VECTORIZE: {
        query: async () => ({
          matches: [
            {
              id: '123',
              score: 0.9,
              metadata: {
                section_id: 123,
                filename: '2024-01-01-demo',
                content: '測試內容',
                display_name: '示範會議',
              },
            },
          ],
        }),
      },
      CAG_RETRIEVER: 'vectorize',
    }

    const responsePromise = app.request(
      '/cag/%E6%B8%AC%E8%A9%A6',
      undefined,
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(promise)
        },
        passThroughOnException: () => {},
        props: {},
      },
    )
    const response = await resolveAfterCooldown(responsePromise, t)

    assert.equal(response.status, 200)
    await response.text()
    await Promise.all(waitUntilPromises)
    assert.deepEqual(cachedBodies, [])
  }
})

test('webhook replies with length warning for questions over 100 characters', async () => {
  const message = '您的問題字數過長，請縮短問題的長度，謝謝!'
  const secret = 'test-secret'
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        timestamp: Date.now(),
        source: { userId: 'line-user' },
        message: { type: 'text', text: '長'.repeat(101) },
      },
    ],
  })
  const signature = await signLineBody(secret, body)
  const fetchCalls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const waitUntilPromises: Promise<unknown>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return new Response('{}', { status: 200 })
  }

  try {
    const response = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-line-signature': signature,
        },
        body,
      },
      {
        LINE_CHANNEL_SECRET: secret,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        AI: {
          run: async () => {
            throw new Error('AI should not be called for overlong questions')
          },
        },
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
    assert.equal(await response.text(), 'OK')
    await Promise.all(waitUntilPromises)

    assert.equal(fetchCalls.length, 1)
    assert.equal(String(fetchCalls[0].input), 'https://api.line.me/v2/bot/message/reply')
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      replyToken: 'reply-token',
      messages: [{ type: 'text', text: message }],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('webhook rate limits group messages without userId by groupId', async () => {
  const secret = 'test-secret'
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        timestamp: Date.now(),
        source: { type: 'group', groupId: 'group-123' },
        message: { type: 'text', text: '地神香火如何' },
      },
    ],
  })
  const signature = await signLineBody(secret, body)
  const rateLimitKeys: string[] = []
  const fetchCalls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const waitUntilPromises: Promise<unknown>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return new Response('{}', { status: 200 })
  }

  try {
    const response = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-line-signature': signature,
        },
        body,
      },
      {
        LINE_CHANNEL_SECRET: secret,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        AI: {
          run: async () => {
            throw new Error('AI should not be called when webhook is rate limited')
          },
        },
        RATE_LIMITER: {
          limit: async ({ key }) => {
            rateLimitKeys.push(key)
            return { success: false }
          },
        },
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
    assert.equal(await response.text(), 'OK')
    await Promise.all(waitUntilPromises)

    assert.deepEqual(rateLimitKeys, ['line:group:group-123'])
    assert.equal(fetchCalls.length, 1)
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      replyToken: 'reply-token',
      messages: [{ type: 'text', text: '您的發問過於頻繁，請稍候約 3 秒再試，謝謝 🙏' }],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('webhook drops individual user messages without a userId (issue #39)', async () => {
  // 1:1 個人聊天未授權 profile → 無 userId、無 groupId/roomId，落入 'line:anonymous'：
  // 無從個別限流、也無從加入黑名單，直接 ack 丟棄，不生成、不回覆。
  const secret = 'test-secret'
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        timestamp: Date.now(),
        source: { type: 'user' },
        message: { type: 'text', text: 'What is Plurality?' },
      },
    ],
  })
  const signature = await signLineBody(secret, body)
  const fetchCalls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const waitUntilPromises: Promise<unknown>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return new Response('{}', { status: 200 })
  }

  try {
    const response = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-line-signature': signature,
        },
        body,
      },
      {
        LINE_CHANNEL_SECRET: secret,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        AI: {
          run: async () => {
            throw new Error('AI must not be called for identity-less users')
          },
        },
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
    assert.equal(await response.text(), 'OK')
    await Promise.all(waitUntilPromises)

    // 完全不外呼：沒有 reply、沒有載入動畫、沒有任何生成。
    assert.equal(fetchCalls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('webhook answers all-English questions in English (issue #37)', async () => {
  const secret = 'test-secret'
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        timestamp: Date.now(),
        source: { userId: 'line-user' },
        message: { type: 'text', text: 'What is Plurality?' },
      },
    ],
  })
  const signature = await signLineBody(secret, body)
  const completionMessages: { role: string; content: string }[][] = []
  const fetchCalls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const waitUntilPromises: Promise<unknown>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return new Response('{}', { status: 200 })
  }

  try {
    const response = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-line-signature': signature,
        },
        body,
      },
      {
        LINE_CHANNEL_SECRET: secret,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        CAG_RETRIEVER: 'vectorize',
        VECTORIZE: {
          query: async () => ({
            matches: [
              {
                score: 0.95,
                metadata: {
                  filename: '2024-01-01-plurality',
                  content: 'Plurality means collaborative diversity.',
                  section_id: 123,
                  display_name: '2024-01-01 Plurality talk',
                  speaker: 'Audrey Tang',
                },
              },
            ],
          }),
        },
        AI: {
          run: async (_model: string, input: Record<string, unknown>) => {
            if ('text' in input) return { data: [[0.1, 0.2, 0.3]] }
            completionMessages.push(input.messages as { role: string; content: string }[])
            return 'Plurality is collaborative diversity. [1]'
          },
        },
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
    assert.equal(await response.text(), 'OK')
    await Promise.all(waitUntilPromises)

    // 模型收到的指示確實切到英文：system 要求英文作答，user 帶英文版回答指示。
    assert.equal(completionMessages.length, 1)
    const [system, user] = completionMessages[0]
    assert.match(system.content, /Answer in English/)
    assert.doesNotMatch(system.content, /Use Traditional Chinese/)
    assert.match(user.content, /Answer in English in 3–5 concise sentences/)

    // 回覆確實送出英文答案。
    const replyCall = fetchCalls.find(
      (call) => String(call.input) === 'https://api.line.me/v2/bot/message/reply',
    )
    assert.ok(replyCall, 'expected a LINE reply call')
    const replyBody = JSON.parse(String(replyCall.init?.body))
    assert.equal(replyBody.replyToken, 'reply-token')
    const messagesJson = JSON.stringify(replyBody.messages)
    assert.match(messagesJson, /Plurality is collaborative diversity/)
    // 出處標籤也跟著英文（issue #38）。
    assert.match(messagesJson, /Source 1/)
    assert.match(messagesJson, /"label":"Visit"/)
    assert.doesNotMatch(messagesJson, /出處/)
    assert.doesNotMatch(messagesJson, /前往來源/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('webhook localises the length warning for all-English questions (issue #37)', async () => {
  const secret = 'test-secret'
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        timestamp: Date.now(),
        source: { userId: 'line-user' },
        message: { type: 'text', text: `${'a'.repeat(101)}?` },
      },
    ],
  })
  const signature = await signLineBody(secret, body)
  const fetchCalls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const waitUntilPromises: Promise<unknown>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return new Response('{}', { status: 200 })
  }

  try {
    const response = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-line-signature': signature,
        },
        body,
      },
      {
        LINE_CHANNEL_SECRET: secret,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        AI: {
          run: async () => {
            throw new Error('AI should not be called for overlong questions')
          },
        },
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
    await Promise.all(waitUntilPromises)

    assert.equal(fetchCalls.length, 1)
    assert.deepEqual(JSON.parse(String(fetchCalls[0].init?.body)), {
      replyToken: 'reply-token',
      messages: [
        {
          type: 'text',
          text: 'Your question is too long — please shorten it and try again. Thank you!',
        },
      ],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

// 加好友 follow event 雙語歡迎（issue #31）的整合測試共用骨架：
// 簽章、mock profile / reply fetch，回傳呼叫到的 fetch 與狀態碼。
async function runFollowWebhook(options: {
  source: Record<string, unknown>
  profileLanguage?: string
  profileStatus?: number
}): Promise<{
  status: number
  fetchCalls: { url: string; init?: RequestInit }[]
}> {
  const secret = 'test-secret'
  const body = JSON.stringify({
    destination: 'Uxxxxxxxxxx',
    events: [
      {
        type: 'follow',
        replyToken: 'reply-token',
        timestamp: Date.now(),
        mode: 'active',
        webhookEventId: '01FZ74A0TDDPYRVKNK77XKC3ZR',
        deliveryContext: { isRedelivery: false },
        source: options.source,
      },
    ],
  })
  const signature = await signLineBody(secret, body)
  const fetchCalls: { url: string; init?: RequestInit }[] = []
  const waitUntilPromises: Promise<unknown>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    fetchCalls.push({ url, init })
    if (url.includes('/v2/bot/profile/')) {
      if (options.profileStatus && options.profileStatus !== 200) {
        return new Response('{}', { status: options.profileStatus })
      }
      return Response.json({
        userId: 'line-user',
        displayName: 'Tester',
        ...(options.profileLanguage ? { language: options.profileLanguage } : {}),
      })
    }
    return new Response('{}', { status: 200 })
  }

  try {
    const response = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-line-signature': signature,
        },
        body,
      },
      {
        LINE_CHANNEL_SECRET: secret,
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        AI: {
          run: async () => {
            throw new Error('AI must not be called for follow events')
          },
        },
      },
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(promise)
        },
        passThroughOnException: () => {},
        props: {},
      },
    )
    const status = response.status
    assert.equal(await response.text(), 'OK')
    await Promise.all(waitUntilPromises)
    return { status, fetchCalls }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('webhook follow event sends the English welcome for en profiles (issue #31)', async () => {
  const { status, fetchCalls } = await runFollowWebhook({
    source: { type: 'user', userId: 'line-user' },
    profileLanguage: 'en',
  })
  assert.equal(status, 200)

  // 先以正確 endpoint + Bearer 取 profile。
  const profileCall = fetchCalls.find((call) => call.url.includes('/v2/bot/profile/'))
  assert.ok(profileCall, 'expected a Get profile call')
  assert.equal(profileCall.url, 'https://api.line.me/v2/bot/profile/line-user')
  assert.equal(
    (profileCall.init?.headers as Record<string, string>).Authorization,
    'Bearer line-token',
  )

  // 再回英文歡迎 Flex。
  const replyCall = fetchCalls.find(
    (call) => call.url === 'https://api.line.me/v2/bot/message/reply',
  )
  assert.ok(replyCall, 'expected a reply call')
  const replyBody = JSON.parse(String(replyCall.init?.body))
  assert.equal(replyBody.replyToken, 'reply-token')
  assert.equal(replyBody.messages.length, 1)
  assert.equal(replyBody.messages[0].type, 'flex')
  assert.equal(replyBody.messages[0].altText, 'Welcome to Ask Audrey!')
  assert.deepEqual(replyBody.messages[0].contents, en_welcome)
})

test('webhook follow event sends the Chinese welcome for zh profiles (issue #31)', async () => {
  const { fetchCalls } = await runFollowWebhook({
    source: { type: 'user', userId: 'line-user' },
    profileLanguage: 'zh-TW',
  })
  const replyCall = fetchCalls.find(
    (call) => call.url === 'https://api.line.me/v2/bot/message/reply',
  )
  assert.ok(replyCall, 'expected a reply call')
  const replyBody = JSON.parse(String(replyCall.init?.body))
  assert.equal(replyBody.messages[0].altText, '歡迎加入鳳問！')
  assert.deepEqual(replyBody.messages[0].contents, zh_welcome)
})

test('webhook follow event defaults to Chinese when profile has no language (issue #31)', async () => {
  // 非認證帳號 profile 不含 language → 預設繁中。
  const { fetchCalls } = await runFollowWebhook({
    source: { type: 'user', userId: 'line-user' },
  })
  const replyCall = fetchCalls.find(
    (call) => call.url === 'https://api.line.me/v2/bot/message/reply',
  )
  assert.ok(replyCall, 'expected a reply call')
  const replyBody = JSON.parse(String(replyCall.init?.body))
  assert.deepEqual(replyBody.messages[0].contents, zh_welcome)
})

test('webhook follow event defaults to Chinese when the profile fetch fails (issue #31)', async () => {
  const { fetchCalls } = await runFollowWebhook({
    source: { type: 'user', userId: 'line-user' },
    profileStatus: 404,
  })
  const replyCall = fetchCalls.find(
    (call) => call.url === 'https://api.line.me/v2/bot/message/reply',
  )
  assert.ok(replyCall, 'expected a reply call')
  const replyBody = JSON.parse(String(replyCall.init?.body))
  assert.deepEqual(replyBody.messages[0].contents, zh_welcome)
})

test('webhook follow event without userId is dropped — no profile fetch, no reply (issue #31)', async () => {
  // 無 userId：讀不到語言偏好、也無從限流，直接 ack 丟棄。
  const { status, fetchCalls } = await runFollowWebhook({
    source: { type: 'user' },
  })
  assert.equal(status, 200)
  assert.equal(fetchCalls.length, 0)
})

test('markdownCitationFootnotes rewrites comma-separated citations', async () => {
  const input = new ReadableStream<string>({
    start(controller) {
      controller.enqueue('see [2, 3, 4]')
      controller.close()
    },
  })
  const output = await streamToString(
    input.pipeThrough(markdownCitationFootnotes([
      '[One](https://archive.tw/one#s1)',
      '[Two](https://archive.tw/two#s2)',
      '[Three](https://archive.tw/three#s3)',
      '[Four](https://archive.tw/four#s4)',
    ])),
  )
  assert.equal(
    output,
    'see [^2], [^3], [^4]\n\n[^2]: [Two](https://archive.tw/two#s2)\n[^3]: [Three](https://archive.tw/three#s3)\n[^4]: [Four](https://archive.tw/four#s4)\n',
  )
})

test('markdownCitationFootnotes rewrites numbered citations and appends used notes', async () => {
  const input = new ReadableStream<string>({
    start(controller) {
      controller.enqueue('A [1] B [99] C [2]')
      controller.close()
    },
  })
  const output = await streamToString(
    input.pipeThrough(markdownCitationFootnotes([
      '[One](https://archive.tw/one#s1)',
      '[Two](https://archive.tw/two#s2)',
    ])),
  )
  assert.equal(
    output,
    'A [^1] B [99] C [^2]\n\n[^1]: [One](https://archive.tw/one#s1)\n[^2]: [Two](https://archive.tw/two#s2)\n',
  )
})

test('retrieveCagSources searches archive and hydrates sections with neighbors', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    requests.push(url.toString())
    if (url.pathname === '/api/search.json') {
      return Response.json({
        results: [
          {
            title: 'Demo Speech',
            url: '/demo#s123',
            speaker: '唐鳳',
            snippet: '地神',
          },
        ],
      })
    }
    if (url.pathname === '/api/section/123') {
      return Response.json({
        section_id: 123,
        section_content: '<p>中段</p>',
        previous_content: '<p>前段</p>',
        next_content: '<p>後段</p>',
        display_name: 'Demo Speech',
        name: '唐鳳',
      })
    }
    return new Response('not found', { status: 404 })
  }

  try {
    const sources = await retrieveCagSources('地神香火如何', {
      archiveBaseUrl: 'https://archive.tw',
      topK: 2,
    })
    assert.equal(sources.length, 1)
    assert.equal(sources[0].href, 'https://archive.tw/demo#s123')
    assert.equal(sources[0].label, 'Demo Speech — 唐鳳')
    assert.match(sources[0].content, /前段/)
    assert.match(sources[0].content, /中段/)
    assert.match(sources[0].content, /後段/)
    assert.ok(requests.some((url) => url.includes('/api/search.json?q=%E5%9C%B0%E7%A5%9E')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('retrieveCagSources rejects archive result URLs outside archive origin', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    requests.push(url.toString())
    if (url.pathname === '/api/search.json') {
      return Response.json({
        results: [
          {
            title: 'External',
            url: 'https://evil.test/demo#s666',
            snippet: '不應使用',
          },
          {
            title: 'Script',
            url: 'javascript:alert(1)',
            snippet: '不應使用',
          },
          {
            title: 'Protocol Relative',
            url: '//evil.test/demo#s777',
            snippet: '不應使用',
          },
          {
            title: 'Demo Speech',
            url: 'https://archive.tw/demo#s123',
            speaker: '唐鳳',
            snippet: '地神',
          },
        ],
      })
    }
    if (url.pathname === '/api/section/123') {
      return Response.json({
        section_id: 123,
        section_content: '<p>合法同源內容</p>',
        display_name: 'Demo Speech',
        name: '唐鳳',
      })
    }
    return new Response('not found', { status: 404 })
  }

  try {
    const sources = await retrieveCagSources('地神香火如何', {
      archiveBaseUrl: 'https://archive.tw',
      topK: 4,
    })

    assert.equal(sources.length, 1)
    assert.equal(sources[0].href, 'https://archive.tw/demo#s123')
    assert.match(sources[0].content, /合法同源內容/)
    assert.ok(!requests.some((url) => url.includes('/api/section/666')))
    assert.ok(!requests.some((url) => url.includes('/api/section/777')))
  } finally {
    globalThis.fetch = originalFetch
  }
})
