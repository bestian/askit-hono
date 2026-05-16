import { Hono } from 'hono'

import { renderHomePage } from './pages/home'
import { renderPrivacyPolicyPage } from './pages/privacy'
import { renderTermsOfUsePage } from './pages/terms'
import { DEFAULT_CAG_MODEL, getCagStatus, streamCagAnswer } from './utils/cag'
import {
  findClosestMatchingSection,
  findRandomSection,
  formatAskAnswerFlex,
  formatAskAnswerHtml,
  isRandomAskQuestion,
  type LineReplyMessage,
} from './utils/search'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string
  ASK_MODEL?: string
  ASK_ARCHIVE_BASE_URL?: string
  ASK_INDEX: R2Bucket
  AI: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>
  }
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
const REPLY_TOKEN_TTL_MS = 50_000
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
  }))
})

app.get('/cag/:question', async (c) => {
  const question = decodeRouteParam(c.req.param('question'))
  return streamCagAnswer(c.env.AI, question, {
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    model: c.req.query('model') || c.env.ASK_MODEL || DEFAULT_CAG_MODEL,
    topK: parsePositiveInteger(c.req.query('top_k') ?? c.req.query('topK'), 6),
    maxCompletionTokens: parsePositiveInteger(
      c.req.query('max_tokens') ?? c.req.query('maxTokens'),
      900,
    ),
  })
})

app.post('/cag', async (c) => {
  let payload: { question?: unknown; topK?: unknown; top_k?: unknown; model?: unknown; maxTokens?: unknown; max_tokens?: unknown }
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

  return streamCagAnswer(c.env.AI, question, {
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    model,
    topK,
    maxCompletionTokens,
  })
})

app.post('/webhook', async (c) => {
  console.log('收到 webhook 請求')

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
  if (!event) {
    return c.text('OK', 200)
  }

  console.log('有事件被觸發')

  if (event.type !== 'message' || event.message?.type !== 'text') {
    return c.text('OK', 200)
  }

  const replyToken = event.replyToken
  const userText = event.message.text ?? ''

  const timeDiff = Date.now() - event.timestamp
  if (timeDiff > REPLY_TOKEN_TTL_MS) {
    console.error('處理時間過長，replyToken可能已過期')
    return c.text('Reply token expired', 400)
  }

  let replyMessage: LineReplyMessage
  try {
    const hit = isRandomAskQuestion(userText)
      ? await findRandomSection(c.env.ASK_INDEX)
      : await findClosestMatchingSection(c.env.ASK_INDEX, userText)
    replyMessage = hit
      ? formatAskAnswerFlex(hit)
      : { type: 'text', text: '找不到符合條件的段落，請上\nhttps://archive.tw' }
  } catch (e) {
    console.error('搜尋發生錯誤:', e)
    replyMessage = { type: 'text', text: '查詢發生錯誤，請稍後再試' }
  }

  const reply = {
    replyToken,
    messages: [replyMessage],
  }

  const response = await fetch(LINE_REPLY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(reply),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('LINE API 回應錯誤:', errorText)
    return c.text('LINE API error', 502)
  }

  return c.text('OK', 200)
})

export default app
