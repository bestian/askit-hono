import { Hono, type Context } from 'hono'

import { renderHomePage } from './pages/home'
import { renderPrivacyPolicyPage } from './pages/privacy'
import { renderTermsOfUsePage } from './pages/terms'
import {
  type CagAnswer,
  type CagRetriever,
  type CagSource,
  DEFAULT_CAG_MODEL,
  generateCagAnswer,
  getCagStatus,
  normalizeCagOptions,
  streamCagAnswer,
} from './utils/cag'
import {
  buildCacheKey,
  getCachedResponse,
  putCachedResponse,
} from './utils/cache'
import {
  DEFAULT_VECTORIZE_MIN_COSINE_SCORE,
  type VectorizeBinding,
} from './utils/vectorize'
import {
  findClosestMatchingSection,
  findClosestMatchingSections,
  findRandomSection,
  formatAskAnswerHtml,
  formatCagAnswerFlex,
  formatFuseAnswerFlex,
  isRandomAskQuestion,
  type LineReplyMessage,
} from './utils/search'

// Cloudflare Workers 內建 Rate Limiting binding 的最小型別（@cloudflare/workers-types 未必有）。
// limit() 不是 subrequest、in-memory、零有感延遲，用作便宜的第一層洪水防護。
type RateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string
  ASK_MODEL?: string
  ASK_ARCHIVE_BASE_URL?: string
  // CAG 檢索器預設值：'vectorize'（語意）或 'archive'（archive.tw 即時搜尋）。
  // 未設定時預設 'vectorize'；無 VECTORIZE binding 時自動回退 archive。
  CAG_RETRIEVER?: string
  CAG_VECTORIZE_MIN_SCORE?: string
  ASK_INDEX: R2Bucket
  // 答案快取 bucket（issue #25）：相同問題 7 天內直接取用，未綁時優雅降級。
  ASK_CACHE?: R2Bucket
  AI: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>
  }
  // Vectorize 語意索引 binding；尚未建立索引前可不綁（程式會回退 archive）。
  VECTORIZE?: VectorizeBinding
  // 防連續濫用限流（兩層）：
  //   第一層 RATE_LIMITER —— 內建限流，便宜、概略、per-PoP，擋明顯洪水（門檻設很寬）。
  //   第二層 RATE_LIMIT_DO —— Durable Object，精準、強一致，做「同一人 N 秒最多 1 次」冷卻。
  // 任一未綁時，該層自動跳過（dev/測試仍可運作）。
  RATE_LIMITER?: RateLimiter
  RATE_LIMIT_DO?: DurableObjectNamespace
}

const DEFAULT_CAG_RETRIEVER: CagRetriever = 'vectorize'

function resolveCagRetriever(
  ...values: (string | undefined)[]
): CagRetriever {
  for (const value of values) {
    if (value === 'vectorize' || value === 'archive') return value
  }
  return DEFAULT_CAG_RETRIEVER
}

function resolveVectorizeMinScore(
  ...values: (number | string | undefined)[]
): number {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : parseOptionalNumber(value)
    if (parsed !== undefined) return Math.max(0, Math.min(1, parsed))
  }
  return DEFAULT_VECTORIZE_MIN_COSINE_SCORE
}

type LineMessageEvent = {
  type: string
  replyToken: string
  timestamp: number
  source: { userId?: string; type: string }
  message?: { type: string; text?: string }
}

type LineWebhookBody = {
  events?: LineMessageEvent[]
}

const LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply'
const LINE_LOADING_ENDPOINT = 'https://api.line.me/v2/bot/chat/loading/start'
const REPLY_TOKEN_TTL_MS = 50_000
// CAG 在 webhook 走非同步回覆（ctx.waitUntil），慢工作須在回 200 之後約 30 秒內完成。
// 檢索 top-k=6 餵給模型當「背景脈絡」以提升答案品質，但只引用／顯示前 6 筆最相符來源
// （對齊 formatCagAnswerFlex 的 4 格出處、引註 [1][2][3][4][5][6] 一一對應）。
// 預設檢索器為 Vectorize，來源是 ≤100 字短段落，6 筆 prompt 仍小、延遲可控。
// max_tokens=240 控制回答長度、避免被截斷。
const WEBHOOK_CAG_TOP_K = 4
const WEBHOOK_CAG_CITE_TOP_K = 4
const WEBHOOK_CAG_MAX_COMPLETION_TOKENS = 240
// LINE 載入動畫秒數需為 5～60 的 5 倍數，且僅 1:1 聊天有效。
const WEBHOOK_LOADING_SECONDS = 30
// 要求模型在 token 預算內「把話講完」，避免回答被 max_completion_tokens 從中截斷。
const WEBHOOK_CAG_ANSWER_INSTRUCTION =
  '請以繁體中文用 3～5 句話簡潔作答，全文控制在約 200 字內並完整收尾，' +
  '於陳述具體事實時標註 [1]、[2] 等來源編號。'
const NOT_FOUND_REPLY = '您的問題超出了資料庫的範圍，\n逐字稿網站連結如下：https://archive.tw'
const ERROR_REPLY = '查詢發生錯誤，請稍後再試'
// 限流冷卻視窗：同一使用者於此毫秒數內最多 1 次（對齊首頁送出鈕的 10 秒冷卻）。
const RATE_LIMIT_WINDOW_MS = 10_000
// 限流（同一使用者 10 秒內最多 1 次）觸發時的回覆訊息。
const RATE_LIMIT_HTTP_MESSAGE = '您的發問過於頻繁，請稍候約 10 秒再試，謝謝 🙏'
const RATE_LIMIT_LINE_REPLY = '您的發問過於頻繁，請稍候約 10 秒再試，謝謝 🙏'
const ROBOTS_TXT = `User-agent: *
Disallow: /ask/
Disallow: /cag/
Disallow: /webhook
`

const app = new Hono<{ Bindings: Bindings }>()

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

// 用快取內容組出回應（命中時走這條，不跑檢索與 AI）。
function respondFromCache(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'X-Cache': 'HIT' },
  })
}

// 把串流回應「分流」：一份照常串給使用者，一份在背景累積成完整文字後寫入快取。
// 只快取 200 成功回應；非 200（如 404 查無範圍）或無 body 時原樣回傳、不快取。
function cacheStreamingResponse(
  c: Context<{ Bindings: Bindings }>,
  cacheKey: string,
  response: Response,
): Response {
  if (response.status !== 200 || !response.body) return response
  const [toClient, toCache] = response.body.tee()
  const contentType =
    response.headers.get('Content-Type') || 'text/markdown; charset=UTF-8'
  c.executionCtx.waitUntil(
    readStreamToString(toCache)
      .then((text) => putCachedResponse(c.env.ASK_CACHE, cacheKey, text, contentType))
      .catch((e) => console.error('快取串流寫入失敗:', e)),
  )
  return new Response(toClient, {
    status: response.status,
    headers: response.headers,
  })
}

// 兩層單人限流，回 true 代表「應被擋下」（兩層共用同一個 key）：
//   第一層（便宜、概略）：內建 limit()，非 subrequest、in-memory、零有感延遲。
//     太頻繁就直接擋下，根本不碰下游 DO —— 順手保護單一 DO 實例不被洪水打爆。
//     門檻刻意設得比「1 次/N 秒」寬很多，正常使用者碰不到，只有狂刷會中。
//   第二層（精準、強一致）：每個 key 一顆 Durable Object（idFromName 路由），
//     物件內以「上次通過時間」判斷是否仍在冷卻視窗內，做真正的逐人冷卻。
// 任一層未綁（dev/測試）或 DO 檢查發生錯誤時，該層放行，以免誤擋正常使用者。
async function isRateLimited(env: Bindings, key: string): Promise<boolean> {
  // 第一層：內建限流（免費、零延遲）。太頻繁直接擋，不付 DO 成本。
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key })
    if (!success) return true
  }

  // 第二層：DO 精準冷卻。
  const ns = env.RATE_LIMIT_DO
  if (!ns) return false
  try {
    const stub = ns.get(ns.idFromName(key))
    const res = await stub.fetch(
      `https://rate-limit/?window_ms=${RATE_LIMIT_WINDOW_MS}`,
    )
    const data = (await res.json()) as { allowed: boolean }
    return !data.allowed
  } catch (e) {
    console.error('限流檢查失敗，放行:', e)
    return false
  }
}

// /ask、/cag 沒有登入身分，只能以來源 IP 當限流 key（同一 NAT 會共用額度）。
// 取不到 IP（例如本機 wrangler dev）時不限流，以免誤擋正常使用者。
async function isIpRateLimited(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const ip = c.req.header('cf-connecting-ip')
  if (!ip) return false
  return isRateLimited(c.env, `ip:${ip}`)
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

// 未提供時回 undefined（沿用「全部可引用」的預設行為）。
function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

// HMAC-SHA256(channelSecret, rawBody), base64-encoded.
// LINE 平台會在 x-line-signature 帶上同樣的值，需以等長時間比對防止 timing attack。
async function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const macBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  )
  const expected = btoa(String.fromCharCode(...new Uint8Array(macBuf)))

  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

// 用 replyToken 送出「唯一一次」回覆（reply token 為一次性，只能呼叫 Reply API 一次）。
async function replyToLine(
  env: Bindings,
  replyToken: string,
  message: LineReplyMessage,
): Promise<void> {
  const res = await fetch(LINE_REPLY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [message] }),
  })
  if (!res.ok) {
    console.error('LINE Reply API 錯誤:', res.status, await res.text())
  }
}

// 顯示「輸入中…」載入動畫；不是訊息、不會消耗 reply token，僅 1:1 聊天（有 userId）有效。
async function startLineLoading(
  env: Bindings,
  userId: string | undefined,
): Promise<void> {
  if (!userId) return
  try {
    const res = await fetch(LINE_LOADING_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        chatId: userId,
        loadingSeconds: WEBHOOK_LOADING_SECONDS,
      }),
    })
    if (!res.ok) {
      console.error('LINE 載入動畫失敗:', res.status, await res.text())
    }
  } catch (e) {
    console.error('LINE 載入動畫例外:', e)
  }
}

// Fuse 退路：CAG 失敗或查無結果時，改用預建索引的前兩則最相近段落回覆。
async function replyWithFuseFallback(
  env: Bindings,
  replyToken: string,
  question: string,
): Promise<void> {
  try {
    const hits = await findClosestMatchingSections(env.ASK_INDEX, question, {
      limit: 2,
    })
    await replyToLine(
      env,
      replyToken,
      hits.length > 0
        ? formatFuseAnswerFlex(hits)
        : { type: 'text', text: NOT_FOUND_REPLY },
    )
  } catch (e) {
    console.error('Fuse fallback 失敗:', e)
    await replyToLine(env, replyToken, { type: 'text', text: ERROR_REPLY })
  }
}

// 安全網：max_completion_tokens 仍可能從句中截斷回答，故回退到最後一個完整句子的結尾，
// 讓使用者看到的是「完整收尾」而非半句。找不到句尾標點時原樣保留。
const SENTENCE_ENDERS = '。！？!?…'
function trimToCompleteSentence(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return trimmed
  const last = trimmed[trimmed.length - 1]
  if (SENTENCE_ENDERS.includes(last) || '」』）)'.includes(last)) return trimmed
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (SENTENCE_ENDERS.includes(trimmed[i])) return trimmed.slice(0, i + 1)
  }
  return trimmed
}

// 模型常把答案寫成單一段落（句子用「。」相連、無換行），在 LINE Flex 會擠成一團。
// 於每個句尾標點（含其後緊接的引號／括號）之後插入換行，讓每句獨立一行；對既有換行具冪等性。
// LINE Flex text 在 wrap:true 下會把 \n 呈現為換行。
function splitSentencesToLines(text: string): string {
  return text
    .replace(/([。！？!?…]+[」』）)】\]]*)[ \t]*\n?[ \t]*/gu, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 背景處理（在 ctx.waitUntil 內）：載入動畫 → CAG 生成 → 用 replyToken 回覆一次。
async function replyWithCag(
  env: Bindings,
  replyToken: string,
  userId: string | undefined,
  question: string,
): Promise<void> {
  const retriever = resolveCagRetriever(env.CAG_RETRIEVER)
  const model = env.ASK_MODEL || DEFAULT_CAG_MODEL
  // 快取：相同問題（retriever／model 相同）7 天內直接用快取的答案與來源回覆，不跑檢索與 AI。
  const cacheKey = await buildCacheKey('webhook', question, { retriever, model })
  const cached = await getCachedResponse(env.ASK_CACHE, cacheKey)
  if (cached) {
    try {
      const { answer, sources } = JSON.parse(cached.body) as {
        answer: string
        sources: CagSource[]
      }
      await replyToLine(env, replyToken, formatCagAnswerFlex(answer, sources))
      return
    } catch (e) {
      console.error('webhook 快取解析失敗，改為重新生成:', e)
    }
  }

  await startLineLoading(env, userId)

  let cag: CagAnswer | null = null
  let cagFailed = false
  try {
    cag = await generateCagAnswer(env.AI, question, {
      archiveBaseUrl: env.ASK_ARCHIVE_BASE_URL,
      model,
      topK: WEBHOOK_CAG_TOP_K,
      citableTopK: WEBHOOK_CAG_CITE_TOP_K,
      maxCompletionTokens: WEBHOOK_CAG_MAX_COMPLETION_TOKENS,
      answerInstruction: WEBHOOK_CAG_ANSWER_INSTRUCTION,
      retriever,
      vectorize: env.VECTORIZE,
      vectorizeMinScore: resolveVectorizeMinScore(env.CAG_VECTORIZE_MIN_SCORE),
    })
  } catch (e) {
    cagFailed = true
    console.error('CAG 生成失敗，改用 Fuse fallback:', e)
  }

  if (!cag || cag.answer.trim() === '') {
    if (!cagFailed && retriever === 'vectorize' && env.VECTORIZE) {
      await replyToLine(env, replyToken, { type: 'text', text: NOT_FOUND_REPLY })
      return
    }
    await replyWithFuseFallback(env, replyToken, question)
    return
  }
  const answer = splitSentencesToLines(trimToCompleteSentence(cag.answer))
  await replyToLine(env, replyToken, formatCagAnswerFlex(answer, cag.sources))
  // 成功生成才寫入快取（answer + sources），供下次相同問題直接取用。
  await putCachedResponse(
    env.ASK_CACHE,
    cacheKey,
    JSON.stringify({ answer, sources: cag.sources }),
    'application/json; charset=UTF-8',
  )
}

app.get('/', (c) => {
  return c.html(renderHomePage())
})

app.get('/privacy', (c) => {
  return c.html(renderPrivacyPolicyPage())
})

app.get('/terms', (c) => {
  return c.html(renderTermsOfUsePage())
})

app.get('/robot.txt', (c) => {
  return c.text(ROBOTS_TXT)
})

app.get('/robots.txt', (c) => {
  return c.text(ROBOTS_TXT)
})

app.get('/ask/:question', async (c) => {
  if (await isIpRateLimited(c)) {
    return c.text(RATE_LIMIT_HTTP_MESSAGE, 429, { 'Retry-After': '10' })
  }
  const question = decodeRouteParam(c.req.param('question'))
  // 隨機問題每次都要不同結果，不快取；其餘相同問題 7 天內直接取用。
  const random = isRandomAskQuestion(question)
  const cacheKey = random ? null : await buildCacheKey('ask', question)

  if (cacheKey) {
    const cached = await getCachedResponse(c.env.ASK_CACHE, cacheKey)
    if (cached) return respondFromCache(cached.body, cached.contentType)
  }

  try {
    const hit = random
      ? await findRandomSection(c.env.ASK_INDEX)
      : await findClosestMatchingSection(c.env.ASK_INDEX, question)
    if (!hit) {
      return c.text('您的問題超出了資料庫的範圍，\n逐字稿網站連結如下：https://archive.tw', 404)
    }
    const body = formatAskAnswerHtml(hit)
    const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"/><title>Ask</title></head><body><p>${body}</p></body></html>`
    const contentType = 'text/html; charset=UTF-8'
    if (cacheKey) {
      c.executionCtx.waitUntil(
        putCachedResponse(c.env.ASK_CACHE, cacheKey, html, contentType),
      )
    }
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': contentType },
    })
  } catch (e) {
    console.error(e)
    return c.text('查詢發生錯誤', 500)
  }
})

app.get('/cag/status', (c) => {
  return c.json(getCagStatus({
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    model: c.env.ASK_MODEL || DEFAULT_CAG_MODEL,
    retriever: resolveCagRetriever(c.req.query('retriever'), c.env.CAG_RETRIEVER),
    vectorizeBound: Boolean(c.env.VECTORIZE),
    vectorizeMinScore: resolveVectorizeMinScore(
      c.req.query('min_score') ?? c.req.query('minScore'),
      c.env.CAG_VECTORIZE_MIN_SCORE,
    ),
  }))
})

app.get('/cag/:question', async (c) => {
  if (await isIpRateLimited(c)) {
    return c.text(RATE_LIMIT_HTTP_MESSAGE, 429, { 'Retry-After': '10' })
  }
  const question = decodeRouteParam(c.req.param('question'))
  const model = c.req.query('model') || c.env.ASK_MODEL || DEFAULT_CAG_MODEL
  const topK = parsePositiveInteger(c.req.query('top_k') ?? c.req.query('topK'), 6)
  const citableTopK = parseOptionalPositiveInteger(
    c.req.query('cite_top_k') ?? c.req.query('citeTopK'),
  )
  const maxCompletionTokens = parsePositiveInteger(
    c.req.query('max_tokens') ?? c.req.query('maxTokens'),
    900,
  )
  const retriever = resolveCagRetriever(c.req.query('retriever'), c.env.CAG_RETRIEVER)
  const vectorizeMinScore = resolveVectorizeMinScore(
    c.req.query('min_score') ?? c.req.query('minScore'),
    c.env.CAG_VECTORIZE_MIN_SCORE,
  )
  const cagOptions = normalizeCagOptions({
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    model,
    topK,
    citableTopK,
    maxCompletionTokens,
    retriever,
    vectorize: c.env.VECTORIZE,
    vectorizeMinScore,
  })

  // 快取 key 納入實際生效的參數（含 clamp/default 後的值），避免用超大參數繞過快取。
  const cacheKey = await buildCacheKey('cag', question, {
    archiveBaseUrl: cagOptions.archiveBaseUrl,
    model: cagOptions.model,
    topK: cagOptions.topK,
    citableTopK: cagOptions.citableTopK,
    maxCompletionTokens: cagOptions.maxCompletionTokens,
    retriever: cagOptions.retriever,
    vectorizeMinScore: cagOptions.vectorizeMinScore,
  })
  const cached = await getCachedResponse(c.env.ASK_CACHE, cacheKey)
  if (cached) return respondFromCache(cached.body, cached.contentType)

  const response = await streamCagAnswer(c.env.AI, question, cagOptions)
  return cacheStreamingResponse(c, cacheKey, response)
})

app.post('/cag', async (c) => {
  if (await isIpRateLimited(c)) {
    return c.text(RATE_LIMIT_HTTP_MESSAGE, 429, { 'Retry-After': '10' })
  }
  let payload: { question?: unknown; topK?: unknown; top_k?: unknown; citableTopK?: unknown; cite_top_k?: unknown; model?: unknown; maxTokens?: unknown; max_tokens?: unknown; retriever?: unknown; minScore?: unknown; min_score?: unknown }
  try {
    payload = await c.req.json()
  } catch {
    return c.text('Invalid JSON payload', 400)
  }

  const question = typeof payload.question === 'string' ? payload.question : ''
  if (question.trim() === '') {
    return c.text('question is required', 400)
  }

  const topK = typeof payload.topK === 'number'
    ? payload.topK
    : typeof payload.top_k === 'number'
      ? payload.top_k
      : 6
  const maxCompletionTokens = typeof payload.maxTokens === 'number'
    ? payload.maxTokens
    : typeof payload.max_tokens === 'number'
      ? payload.max_tokens
      : 900
  const model = typeof payload.model === 'string'
    ? payload.model
    : c.env.ASK_MODEL || DEFAULT_CAG_MODEL
  const citableTopK = typeof payload.citableTopK === 'number'
    ? payload.citableTopK
    : typeof payload.cite_top_k === 'number'
      ? payload.cite_top_k
      : undefined
  const vectorizeMinScore = typeof payload.minScore === 'number'
    ? payload.minScore
    : typeof payload.min_score === 'number'
      ? payload.min_score
      : resolveVectorizeMinScore(c.env.CAG_VECTORIZE_MIN_SCORE)

  const retriever = resolveCagRetriever(
    typeof payload.retriever === 'string' ? payload.retriever : undefined,
    c.env.CAG_RETRIEVER,
  )
  const cagOptions = normalizeCagOptions({
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    model,
    topK,
    citableTopK,
    maxCompletionTokens,
    retriever,
    vectorize: c.env.VECTORIZE,
    vectorizeMinScore,
  })

  // 快取 key 納入實際生效的參數（含 clamp/default 後的值），避免用超大參數繞過快取。
  const cacheKey = await buildCacheKey('cag', question, {
    archiveBaseUrl: cagOptions.archiveBaseUrl,
    model: cagOptions.model,
    topK: cagOptions.topK,
    citableTopK: cagOptions.citableTopK,
    maxCompletionTokens: cagOptions.maxCompletionTokens,
    retriever: cagOptions.retriever,
    vectorizeMinScore: cagOptions.vectorizeMinScore,
  })
  const cached = await getCachedResponse(c.env.ASK_CACHE, cacheKey)
  if (cached) return respondFromCache(cached.body, cached.contentType)

  const response = await streamCagAnswer(c.env.AI, question, cagOptions)
  return cacheStreamingResponse(c, cacheKey, response)
})

app.post('/webhook', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-line-signature')

  const ok = await verifyLineSignature(
    c.env.LINE_CHANNEL_SECRET,
    rawBody,
    signature,
  )
  if (!ok) {
    console.error('簽章驗證失敗')
    return c.text('Invalid signature', 401)
  }

  let body: LineWebhookBody
  try {
    body = JSON.parse(rawBody) as LineWebhookBody
  } catch {
    return c.text('Invalid JSON payload', 400)
  }

  const event = body.events?.[0]
  if (!event || event.type !== 'message' || event.message?.type !== 'text') {
    return c.text('OK', 200)
  }

  // 事件若已逾時（多半是 LINE 重送的舊事件），直接 ack，不再嘗試回覆。
  if (Date.now() - event.timestamp > REPLY_TOKEN_TTL_MS) {
    console.error('事件已逾時，略過回覆')
    return c.text('OK', 200)
  }

  const replyToken = event.replyToken
  const userId = event.source.userId
  const userText = event.message.text ?? ''

  // 防連續濫用：同一 userId 10 秒內第 2 則訊息，只回個提示，不再做昂貴的 CAG 生成。
  // （仍須回 200 ack，並用一次性 reply token 送出提示。）
  if (userId && (await isRateLimited(c.env, `line:${userId}`))) {
    c.executionCtx.waitUntil(
      replyToLine(c.env, replyToken, { type: 'text', text: RATE_LIMIT_LINE_REPLY }),
    )
    return c.text('OK', 200)
  }

  // 關鍵：CAG 生成需數秒到十幾秒，超過 LINE 對 webhook 的「2 秒內回 2xx」限制，
  // 因此把慢工作交給 ctx.waitUntil 背景執行（回應後最多 30 秒預算），handler 立刻 ack。
  // reply token 約 1 分鐘有效，留待背景用 Reply API 送出「唯一一次」回覆。
  c.executionCtx.waitUntil(replyWithCag(c.env, replyToken, userId, userText))

  return c.text('OK', 200)
})

// 限流用 Durable Object：每個 key（line:<userId> 或 ip:<ip>）透過 idFromName 路由到
// 同一顆全域唯一實例，單執行緒、強一致。只在記憶體保留「上次通過時間」即可——即使實例
// 被回收，最壞情況也只是視窗內多放行一個請求，無安全疑慮，故不需動用 storage。
export class RateLimiterDO {
  private lastAllowedMs = 0

  async fetch(req: Request): Promise<Response> {
    const windowMs =
      Number(new URL(req.url).searchParams.get('window_ms')) || RATE_LIMIT_WINDOW_MS
    const now = Date.now()
    if (now - this.lastAllowedMs < windowMs) {
      return Response.json({ allowed: false })
    }
    this.lastAllowedMs = now
    return Response.json({ allowed: true })
  }
}

export default app
