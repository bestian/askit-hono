import { Hono } from 'hono'

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string
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

const app = new Hono<{ Bindings: Bindings }>()

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
  return c.text('Hello World!')
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

  console.log('webhook 請求內容:', body)

  const event = body.events?.[0]
  if (!event) {
    return c.text('OK', 200)
  }

  console.log('回應Token:', event.replyToken)
  console.log('事件類型:', event.type)
  console.log('訊息類型:', event.message?.type)

  if (event.type !== 'message' || event.message?.type !== 'text') {
    return c.text('OK', 200)
  }

  const replyToken = event.replyToken
  const userText = event.message.text ?? ''
  console.log('使用者提問:', '問題：' + userText)

  const timeDiff = Date.now() - event.timestamp
  if (timeDiff > REPLY_TOKEN_TTL_MS) {
    console.error('處理時間過長，replyToken可能已過期')
    return c.text('Reply token expired', 400)
  }

  const reply = {
    replyToken,
    messages: [{ type: 'text', text: 'Hello World!' }],
  }
  console.log(reply)

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
