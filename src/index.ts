import { Hono } from 'hono'

import { renderHomePage } from './pages/home'
import { renderPrivacyPolicyPage } from './pages/privacy'
import { renderTermsOfUsePage } from './pages/terms'
import {
  type CagAnswer,
  type CagRetriever,
  DEFAULT_CAG_MODEL,
  generateCagAnswer,
  getCagStatus,
  streamCagAnswer,
} from './utils/cag'
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
  AI: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>
  }
  // Vectorize 語意索引 binding；尚未建立索引前可不綁（程式會回退 archive）。
  VECTORIZE?: VectorizeBinding
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
const NOT_FOUND_REPLY = '找不到符合條件的段落，請上\nhttps://archive.tw'
const ERROR_REPLY = '查詢發生錯誤，請稍後再試'
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
  await startLineLoading(env, userId)

  let cag: CagAnswer | null = null
  let cagFailed = false
  const retriever = resolveCagRetriever(env.CAG_RETRIEVER)
  try {
    cag = await generateCagAnswer(env.AI, question, {
      archiveBaseUrl: env.ASK_ARCHIVE_BASE_URL,
      model: env.ASK_MODEL || DEFAULT_CAG_MODEL,
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
  const question = decodeRouteParam(c.req.param('question'))

  try {
    const hit = isRandomAskQuestion(question)
      ? await findRandomSection(c.env.ASK_INDEX)
      : await findClosestMatchingSection(c.env.ASK_INDEX, question)
    if (!hit) {
      return c.text('找不到符合條件的段落', 404)
    }
    const body = formatAskAnswerHtml(hit)
    return new Response(
      `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"/><title>Ask</title></head><body><p>${body}</p></body></html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      },
    )
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
  const question = decodeRouteParam(c.req.param('question'))
  return streamCagAnswer(c.env.AI, question, {
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    model: c.req.query('model') || c.env.ASK_MODEL || DEFAULT_CAG_MODEL,
    topK: parsePositiveInteger(c.req.query('top_k') ?? c.req.query('topK'), 6),
    citableTopK: parseOptionalPositiveInteger(
      c.req.query('cite_top_k') ?? c.req.query('citeTopK'),
    ),
    maxCompletionTokens: parsePositiveInteger(
      c.req.query('max_tokens') ?? c.req.query('maxTokens'),
      900,
    ),
    retriever: resolveCagRetriever(c.req.query('retriever'), c.env.CAG_RETRIEVER),
    vectorize: c.env.VECTORIZE,
    vectorizeMinScore: resolveVectorizeMinScore(
      c.req.query('min_score') ?? c.req.query('minScore'),
      c.env.CAG_VECTORIZE_MIN_SCORE,
    ),
  })
})

app.post('/cag', async (c) => {
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

  return streamCagAnswer(c.env.AI, question, {
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    model,
    topK,
    citableTopK,
    maxCompletionTokens,
    retriever: resolveCagRetriever(
      typeof payload.retriever === 'string' ? payload.retriever : undefined,
      c.env.CAG_RETRIEVER,
    ),
    vectorize: c.env.VECTORIZE,
    vectorizeMinScore,
  })
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

  // 關鍵：CAG 生成需數秒到十幾秒，超過 LINE 對 webhook 的「2 秒內回 2xx」限制，
  // 因此把慢工作交給 ctx.waitUntil 背景執行（回應後最多 30 秒預算），handler 立刻 ack。
  // reply token 約 1 分鐘有效，留待背景用 Reply API 送出「唯一一次」回覆。
  c.executionCtx.waitUntil(replyWithCag(c.env, replyToken, userId, userText))

  return c.text('OK', 200)
})

export default app
