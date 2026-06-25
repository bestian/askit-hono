import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

import { renderHomePage } from './pages/home'
import { renderPrivacyPolicyPage } from './pages/privacy'
import { renderTermsOfUsePage } from './pages/terms'
import {
  NOT_FOUND_REPLY_HTML_EN,
  NOT_FOUND_REPLY_PLAIN,
  NOT_FOUND_REPLY_PLAIN_EN,
} from './utils/notFoundReply'
import {
  type AbuseKind,
  type AbusePath,
  type AbuseThresholdOptions,
  DEFAULT_ABUSE_BLACKLIST_THRESHOLD,
  DEFAULT_ABUSE_COUNT_WINDOW_HOURS,
  isBlacklisted,
  recordAbuse,
} from './utils/abuse'
import {
  type CagAnswer,
  type CagRetriever,
  type CagSource,
  DEFAULT_CAG_MODEL,
  DEFAULT_MAX_COMPLETION_TOKENS,
  DEFAULT_TOP_K,
  detectCagAnswerLanguage,
  generateCagAnswer,
  getCagStatus,
  normalizeCagOptions,
  streamCagAnswer,
} from './utils/cag'
import {
  audreySkillCitationFootnotes,
  buildAudreySkillAnswerInstruction,
  resolveAudreySkillModel,
} from './utils/audreySkill'
import { resolveAudreyAiGateway } from './utils/audreyGatewayBindings'
import { isAuthorizedFromHeader } from './utils/auth'
import { isBlacklistExemptIp } from './utils/trustedRanges'
import {
  buildCacheKey,
  getCachedResponse,
  putCachedResponse,
  refreshCachedResponse,
} from './utils/cache'
import {
  DEFAULT_VECTORIZE_MIN_COSINE_SCORE,
  type VectorizeBinding,
} from './utils/vectorize'
import {
  findClosestMatchingSection,
  findClosestMatchingSections,
  formatAskAnswerHtml,
  formatCagAnswerFlex,
  formatFuseAnswerFlex,
  type LineReplyMessage,
} from './utils/search'
// 加好友（follow event）雙語歡迎 Flex（issue #31）：各語言獨立硬編碼 bubble JSON。
import { en_welcome, zh_welcome } from './line_welcome/follow'

// Cloudflare Workers 內建 Rate Limiting binding 的最小型別（@cloudflare/workers-types 未必有）。
// limit() 不是 subrequest、in-memory、零有感延遲，用作便宜的第一層洪水防護。
type RateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string
  ASK_ARCHIVE_BASE_URL?: string
  // CAG 檢索器預設值：'vectorize'（語意）或 'archive'（archive.tw 即時搜尋）。
  // 未設定時預設 'vectorize'；無 VECTORIZE binding 時自動回退 archive。
  CAG_RETRIEVER?: string
  CAG_VECTORIZE_MIN_SCORE?: string
  /** Model used by /au (Gemma default; glm-5.2, fugu, or nemotron-ultra via AI Gateway). */
  AUDREY_MODEL?: string
  SAKANA_API_KEY?: string
  BASETEN_API_KEY?: string
  BASETEN_MODEL?: string
  CF_AIG_TOKEN?: string
  CF_AI_GATEWAY_ACCOUNT_ID?: string
  CF_AI_GATEWAY_ID?: string
  GLOBAL_GENERATION_LIMIT_PER_MINUTE?: string
  GLOBAL_GENERATION_LIMIT_PER_DAY?: string
  ASK_INDEX: R2Bucket
  // 答案快取 bucket（issue #25）：相同問題 7 天內直接取用，未綁時優雅降級。
  ASK_CACHE?: R2Bucket
  // CAG 檢索來源 KV 快取（1h TTL）；未綁時優雅降級。
  CAG_CACHE?: KVNamespace
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
  // 超量／異常請求追蹤 log 與黑名單（issue #27）。未綁時優雅降級：
  // 不寫 log、黑名單視為空，請求照常處理。
  ABUSE_DB?: D1Database
  // sayit-database D1：當 Vectorize 和 archive.tw 搜尋都找不到時，
 // 用 section_content LIKE 做內容全文檢索（如「萌典」這類罕用專名）。
  // 未綁時優雅降級——回到既有行為（空來源 → 404）。
  SAYIT_DB?: D1Database
  ABUSE_BLACKLIST_THRESHOLD?: string
  ABUSE_COUNT_WINDOW_HOURS?: string
  // 受信任呼叫端 token（鏡像 sayit-hono 的 AUDREYT_TRANSCRIPT_TOKEN）。
  // 自動化工具帶 `Authorization: Bearer <token>` 且與此 secret 相符時，
  // 略過限流、黑名單與全域生成預算（見 isTrustedCaller）。應透過
  // `wrangler secret put AUDREYT_TRANSCRIPT_TOKEN` 設定，勿寫入 wrangler.jsonc。
  AUDREYT_TRANSCRIPT_TOKEN?: string
}

const DEFAULT_CAG_RETRIEVER: CagRetriever = 'vectorize'
// /au 的預設 max_completion_tokens；GLM-5.2 較冗長，500 會截斷回答，1024 確保完整。
const AUDREY_MAX_COMPLETION_TOKENS = 1024

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
  source: { userId?: string; type: string; groupId?: string; roomId?: string }
  message?: { type: string; text?: string }
}

type LineWebhookBody = {
  events?: LineMessageEvent[]
}

const LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply'
const LINE_LOADING_ENDPOINT = 'https://api.line.me/v2/bot/chat/loading/start'
// Get profile：GET {endpoint}/{userId}，Bearer 授權。language（ISO 639-1，如 en、zh-TW）
// 僅在認證／付費官方帳號才回傳，否則缺席——故 resolveWelcomeLang 以 zh-Hant 為預設。
const LINE_PROFILE_ENDPOINT = 'https://api.line.me/v2/bot/profile'
const REPLY_TOKEN_TTL_MS = 50_000
// 加好友歡迎 Flex 的替代文字（Flex 無法顯示時的 fallback、推播通知預覽用）。
const WELCOME_ALT_TEXT = '歡迎加入鳳問！'
const WELCOME_ALT_TEXT_EN = 'Welcome to Ask Audrey!'
// CAG 在 webhook 走非同步回覆（ctx.waitUntil），慢工作須在回 200 之後約 30 秒內完成。
// 檢索 top-k=4 餵給模型；只引用／顯示前 4 筆最相符來源
// （對齊 formatCagAnswerFlex 的 4 格出處、引註 [1][2][3][4][5][6] 一一對應）。
// 預設檢索器為 Vectorize，來源是 ≤100 字短段落，6 筆 prompt 仍小、延遲可控。
// max_tokens=240 控制回答長度、避免被截斷。
const WEBHOOK_CAG_TOP_K = 4
const WEBHOOK_CAG_CITE_TOP_K = 4
const WEBHOOK_CAG_MAX_COMPLETION_TOKENS = 240
// LINE 載入動畫秒數需為 5～60 的 5 倍數，且僅 1:1 聊天有效。
const WEBHOOK_LOADING_SECONDS = 30
// webhook 的回答生成對齊 /au（唐鳳公開溝通風格、Audrey skill 模型、SayIt 來源救援），
// 僅在 buildAudreySkillAnswerInstruction 之後再追加這段「長度上限」：把答案壓在 LINE 對話框
// 適讀的長度，並要求模型在 token 預算內把話講完，避免被 max_completion_tokens 從中截斷。
// 引註規則（標註 [1]、[2]）已由 Audrey skill 指示涵蓋，這裡不重述。
const WEBHOOK_CAG_LENGTH_INSTRUCTION =
  '請用 3～5 句話簡潔作答，全文控制在約 200 字內並完整收尾。'
// 偵測到全英文提問（issue #37）時改用此英文版，與 answerLanguage:'en' 一致，避免中英衝突。
const WEBHOOK_CAG_LENGTH_INSTRUCTION_EN =
  'Keep the whole reply within about 100 words across 3–5 concise sentences and finish cleanly.'
// 限流冷卻視窗：同一使用者於此毫秒數內最多 1 次（對齊首頁送出鈕冷卻）。
const RATE_LIMIT_WINDOW_MS = 3_000
const NOT_FOUND_REPLY_MIN_DELAY_MS = RATE_LIMIT_WINDOW_MS
const RATE_LIMIT_RETRY_AFTER_SECONDS = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
// /capacity 是公開、可被 archive.tw 輪詢的狀態端點：獨立冷卻桶，避免影響真正發問。
const CAPACITY_RATE_LIMIT_WINDOW_MS = 5_000
const CAPACITY_RATE_LIMIT_RETRY_AFTER_SECONDS = Math.ceil(CAPACITY_RATE_LIMIT_WINDOW_MS / 1000)
const CAPACITY_CACHE_CONTROL = 'public, max-age=5, s-maxage=5'
const ASK_CORS_ALLOWED_ORIGINS = new Set(['https://archive.tw', 'https://ask.archive.tw','http://localhost:8787'])
const ASK_CORS_ALLOWED_METHODS = 'GET, OPTIONS'
const ASK_CORS_ALLOWED_HEADERS = 'Content-Type'
const ASK_CORS_MAX_AGE_SECONDS = '600'

// 網頁串流路由（GET /cag/:question）使用者可見訊息的雙語表：?lang=en 取英文、其餘繁中。
// zh-Hant 字串須與既有字面值逐字相同；LINE webhook 與其他路由沿用 zh-Hant 這一份。
export const WEB_MESSAGES = {
  'zh-Hant': {
    notFound: NOT_FOUND_REPLY_PLAIN,
    rateLimited:
      `您的發問過於頻繁，請稍候約 ${RATE_LIMIT_RETRY_AFTER_SECONDS} 秒再試，謝謝 🙏`,
    tooLong: '您的問題字數過長，請縮短問題的長度，謝謝!',
    budget: '目前服務量已達上限，請稍後再試，謝謝',
    blacklisted: '由於多次異常請求，您的存取已被暫停',
  },
  en: {
    notFound: NOT_FOUND_REPLY_PLAIN_EN,
    rateLimited:
      `You are asking a bit too quickly — please wait about ${RATE_LIMIT_RETRY_AFTER_SECONDS} seconds and try again 🙏`,
    tooLong: 'Your question is too long — please shorten it and try again. Thank you!',
    budget:
      'The service has reached its generation budget for now — please try again later 🙏',
    blacklisted: 'Your access has been suspended due to repeated abnormal requests.',
  },
} as const

export type WebMessageLang = keyof typeof WEB_MESSAGES
type WebMessageKey = keyof (typeof WEB_MESSAGES)['zh-Hant']

export function webMessage(key: WebMessageKey, lang: WebMessageLang): string {
  return WEB_MESSAGES[lang][key]
}

// 網頁路由的語言只看 ?lang=en；其餘一律繁中（與既有行為相同）。
function resolveWebLang(lang: string | undefined): WebMessageLang {
  return lang === 'en' ? 'en' : 'zh-Hant'
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('Vary')
  if (!existing) {
    headers.set('Vary', value)
    return
  }
  const values = existing.split(',').map((item) => item.trim().toLowerCase())
  if (!values.includes(value.toLowerCase())) {
    headers.set('Vary', `${existing}, ${value}`)
  }
}

function applyAskCors(c: Context<{ Bindings: Bindings }>, response: Response): Response {
  const origin = c.req.header('Origin')
  if (!origin || !ASK_CORS_ALLOWED_ORIGINS.has(origin)) return response

  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', ASK_CORS_ALLOWED_METHODS)
  headers.set('Access-Control-Allow-Headers', ASK_CORS_ALLOWED_HEADERS)
  headers.set('Access-Control-Max-Age', ASK_CORS_MAX_AGE_SECONDS)
  appendVary(headers, 'Origin')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function askCorsPreflight(c: Context<{ Bindings: Bindings }>): Response {
  return applyAskCors(c, new Response(null, { status: 204 }))
}

const NOT_FOUND_REPLY = WEB_MESSAGES['zh-Hant'].notFound
const ERROR_REPLY = '查詢發生錯誤，請稍後再試'
// 全英文提問（issue #37）走錯誤路徑時的英文版回覆。
const ERROR_REPLY_EN = 'Something went wrong while answering — please try again later.'
const GLOBAL_GENERATION_LIMIT_PER_MINUTE = 30
const GLOBAL_GENERATION_LIMIT_PER_DAY = 1_000
const MAX_QUESTION_CHARS = 100
const MAX_API_BODY_BYTES = 32 * 1024
const MIN_CACHEABLE_CAG_ANSWER_CHARS = 12
// 限流（同一使用者冷卻視窗內第 2 次請求）觸發時的回覆訊息。
const RATE_LIMIT_HTTP_MESSAGE = WEB_MESSAGES['zh-Hant'].rateLimited
const GLOBAL_BUDGET_HTTP_MESSAGE = WEB_MESSAGES['zh-Hant'].budget
const QUESTION_TOO_LONG_MESSAGE = WEB_MESSAGES['zh-Hant'].tooLong
// 黑名單成員的回覆（issue #27）。LINE 來源被封鎖時不回覆、僅 ack。
const BLACKLISTED_HTTP_MESSAGE = WEB_MESSAGES['zh-Hant'].blacklisted
const ROBOTS_TXT = `User-agent: *
Disallow: /ask/
Disallow: /cag/
Disallow: /capacity
Disallow: /au/
Disallow: /webhook
`

const app = new Hono<{ Bindings: Bindings }>()

app.use(secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    imgSrc: ["'self'", 'data:'],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
  },
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin',
  originAgentCluster: '?1',
  referrerPolicy: 'no-referrer',
  strictTransportSecurity: 'max-age=15552000; includeSubDomains',
  xContentTypeOptions: 'nosniff',
  xDnsPrefetchControl: 'off',
  xDownloadOptions: 'noopen',
  xFrameOptions: 'DENY',
  xPermittedCrossDomainPolicies: 'none',
  xXssProtection: '0',
  permissionsPolicy: {
    camera: [],
    geolocation: [],
    microphone: [],
  },
}))

async function readRequestBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    const bytes = Number(contentLength)
    if (Number.isFinite(bytes) && bytes > maxBytes) return null
  }

  const body = request.body
  if (!body) return new Uint8Array()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return bytes
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

const maxApiBodySize: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') {
    await next()
    return
  }
  const body = await readRequestBodyWithinLimit(c.req.raw, MAX_API_BODY_BYTES)
  if (!body) {
    return c.text('Request body too large', 413)
  }
  c.req.raw = new Request(c.req.raw.url, {
    body,
    headers: c.req.raw.headers,
    method: c.req.raw.method,
    redirect: c.req.raw.redirect,
    signal: c.req.raw.signal,
  })
  await next()
}
app.use('/au', maxApiBodySize)
app.use('/webhook', maxApiBodySize)

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isQuestionTooLong(question: string): boolean {
  return [...question.trim()].length > MAX_QUESTION_CHARS
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

function isCacheableCagAnswerText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if ([...normalized].length < MIN_CACHEABLE_CAG_ANSWER_CHARS) return false

  const knownBadAnswerPhrases = [
    NOT_FOUND_REPLY,
    ERROR_REPLY,
    RATE_LIMIT_HTTP_MESSAGE,
    GLOBAL_BUDGET_HTTP_MESSAGE,
    QUESTION_TOO_LONG_MESSAGE,
    '查詢發生錯誤',
    '找不到足夠相關的逐字稿',
    '無法根據提供的逐字稿回答',
    '無法從提供的資料中回答',
    '無法回答這個問題',
    '不能回答這個問題',
    'I cannot answer',
    'I can’t answer',
    WEB_MESSAGES.en.notFound,
  ]
  return !knownBadAnswerPhrases.some((phrase) => normalized.includes(phrase))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// UX 拖延 helper：只在「準備回覆超範圍／模型答不出等失敗訊息」的路徑使用，
// 讓正常使用者看見失敗訊息後不會立刻重送而撞到同一個冷卻視窗。
// 成功串流與一般快取處理不應等待，避免拖慢正常首包。
async function delayUntilMinimumElapsed(
  startedAt: number,
  minElapsedMs = NOT_FOUND_REPLY_MIN_DELAY_MS,
): Promise<void> {
  const remainingMs = minElapsedMs - (Date.now() - startedAt)
  if (remainingMs > 0) await sleep(remainingMs)
}

// 用快取內容組出回應（命中時走這條，不跑檢索與 AI）。
function respondFromCache(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'X-Cache': 'HIT' },
  })
}

// 把串流回應分流：一份照常串給使用者，一份在背景累積成完整文字後寫入快取。
// 只快取可快取的 200 成功文字；非 200 或無 body 時原樣回傳、不快取。
// 注意：這個函式不做 UX 拖延；需要拖延的 handler 必須在回傳失敗訊息前自行呼叫
// delayUntilMinimumElapsed(startedAt)。
function cacheCagResponse(
  c: Context<{ Bindings: Bindings }>,
  cacheKey: string | null,
  response: Response,
): Response {
  if (response.status !== 200 || !response.body) return response
  const [toClient, toCache] = response.body.tee()
  if (cacheKey) {
    const contentType =
      response.headers.get('Content-Type') || 'text/markdown; charset=UTF-8'
    c.executionCtx.waitUntil(
      readStreamToString(toCache)
        .then((text) => {
          if (!isCacheableCagAnswerText(text)) return
          return putCachedResponse(c.env.ASK_CACHE, cacheKey, text, contentType)
        })
        .catch((e) => console.error('快取串流寫入失敗:', e)),
    )
  } else {
    toCache.cancel().catch(() => {})
  }
  return new Response(toClient, {
    status: response.status,
    headers: response.headers,
  })
}

type BudgetLimitReason = 'minute' | 'day'

type BudgetLimitDecision = {
  allowed: boolean
  reason?: BudgetLimitReason
  retryAfterSeconds?: number
}

// 兩層單人限流，回 true 代表「應被擋下」（兩層共用同一個 key）：
//   第一層（便宜、概略）：內建 limit()，非 subrequest、in-memory、零有感延遲。
//     太頻繁就直接擋下，根本不碰下游 DO —— 順手保護單一 DO 實例不被洪水打爆。
//     門檻刻意設得比「1 次/N 秒」寬很多，正常使用者碰不到，只有狂刷會中。
//   第二層（精準、強一致）：每個 key 一顆 Durable Object（idFromName 路由），
//     物件內以「上次通過時間」判斷是否仍在冷卻視窗內，做真正的逐人冷卻。
// 任一層未綁（dev/測試）或 DO 檢查發生錯誤時，該層放行，以免誤擋正常使用者。
async function isRateLimited(
  env: Bindings,
  key: string,
  windowMs = RATE_LIMIT_WINDOW_MS,
): Promise<boolean> {
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
      `https://rate-limit/?window_ms=${windowMs}`,
    )
    const data = (await res.json()) as { allowed: boolean }
    return !data.allowed
  } catch (e) {
    console.error('限流檢查失敗，放行:', e)
    return false
  }
}

function lineRateLimitKey(source: LineMessageEvent['source']): string {
  if (source.userId) return `line:${source.userId}`
  if (source.type === 'group' && source.groupId) return `line:group:${source.groupId}`
  if (source.type === 'room' && source.roomId) return `line:room:${source.roomId}`
  return 'line:anonymous'
}

function normalizeIpv6Prefix64(ip: string): string | null {
  const zoneIndex = ip.indexOf('%')
  const withoutZone = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex)
  const [headPart, tailPart] = withoutZone.split('::')
  if (withoutZone.split('::').length > 2) return null

  const parseParts = (part: string): string[] => {
    if (part === '') return []
    return part.split(':')
  }

  const head = parseParts(headPart)
  const tail = tailPart === undefined ? [] : parseParts(tailPart)
  const expanded: string[] = []
  for (const part of [...head, ...tail]) {
    if (part.includes('.')) return null
    const value = Number.parseInt(part, 16)
    if (!/^[0-9a-f]{1,4}$/i.test(part) || !Number.isFinite(value)) return null
  }

  if (tailPart === undefined) {
    if (head.length !== 8) return null
    expanded.push(...head)
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    expanded.push(...head, ...Array.from({ length: missing }, () => '0'), ...tail)
  }

  return expanded
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(':')
}

export function ipRateLimitKeyFromIp(ip: string): string {
  const normalized = ip.trim().toLowerCase()
  if (normalized.includes(':')) {
    const prefix64 = normalizeIpv6Prefix64(normalized)
    return prefix64 ? `ip6:${prefix64}::/64` : `ip:${normalized}`
  }
  return `ip:${normalized}`
}

// /ask、/cag 沒有登入身分，只能以來源 IP 當限流 key（同一 NAT 會共用額度）。
// IPv6 以 /64 前綴當桶，避免攻擊者在同一段內輪換位址取得新額度。
// 取不到 IP（例如本機 wrangler dev）時不限流，以免誤擋正常使用者。
async function isIpRateLimited(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const ip = c.req.header('cf-connecting-ip')
  if (!ip) return false
  return isRateLimited(c.env, ipRateLimitKeyFromIp(ip))
}

async function isCapacityRateLimited(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const ip = c.req.header('cf-connecting-ip')
  if (!ip) return false
  return isRateLimited(
    c.env,
    `capacity:${ipRateLimitKeyFromIp(ip)}`,
    CAPACITY_RATE_LIMIT_WINDOW_MS,
  )
}

// 受信任呼叫端（鏡像 sayit-hono 的 Bearer token 機制）：自動化工具帶
// `Authorization: Bearer <AUDREYT_TRANSCRIPT_TOKEN>` 且與 secret 相符時，
// 答案端點（/ask、/cag、/au、/capacity）略過限流、黑名單與全域生成預算，
// 讓非瀏覽器 User-Agent 也能正常呼叫，不會被 403/429 擋下。
// 比對走 src/utils/auth.ts 的 constant-time SHA-256（與 sayit-hono 同一套）；
// secret 未設定（dev/測試未帶）時恆為 false——一律走原本的限流／黑名單路徑。
async function isTrustedCaller(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  // c.env 在某些測試呼叫（app.request 未帶 env）會是 undefined；以 ?. 優雅降級，
  // 與專案「未綁定即略過」的慣例一致——secret 取不到時 isAuthorizedFromHeader 回 false。
  return isAuthorizedFromHeader(
    c.req.header('Authorization'),
    c.env?.AUDREYT_TRANSCRIPT_TOKEN,
  )
}

// ── 異常請求追蹤與黑名單（issue #27）────────────────────────────────────────
// 「單一 IP/Id 超量」或「問題字串過長」時寫入 abuse_log；同一 key 在視窗內
// 累積達門檻次數即自動進黑名單。黑名單比對放在「任何 DO/KV 限流記帳之前」，
// 被封鎖的請求完全不消耗全域生成額度，以保障善意使用者。

function resolveAbuseOptions(env: Bindings): AbuseThresholdOptions {
  const threshold = parsePositiveInteger(
    env.ABUSE_BLACKLIST_THRESHOLD,
    DEFAULT_ABUSE_BLACKLIST_THRESHOLD,
  )
  const windowHours = parseOptionalNumber(env.ABUSE_COUNT_WINDOW_HOURS)
  const hours =
    windowHours !== undefined && windowHours >= 0
      ? windowHours
      : DEFAULT_ABUSE_COUNT_WINDOW_HOURS
  return { threshold, windowMs: Math.round(hours * 3_600_000) }
}

// 在背景寫入異常紀錄（waitUntil），不增加回應延遲；key 取不到時略過。
function reportAbuse(
  c: Context<{ Bindings: Bindings }>,
  entry: {
    key: string | null
    kind: AbuseKind
    path: AbusePath
    question: string
    ip?: string
    lineId?: string
  },
): void {
  const { key, ...rest } = entry
  if (!key) return
  // 共用基礎設施網段（Cloudflare／WARP 出口、loopback、私有網段）只記錄不進黑名單：
  // 永久封鎖會誤傷同出口的無辜使用者（issue #49/#50）。即時限流與全域預算不受影響。
  const skipBlacklist = rest.ip ? isBlacklistExemptIp(rest.ip) : false
  c.executionCtx.waitUntil(
    recordAbuse(c.env.ABUSE_DB, { key, ...rest }, resolveAbuseOptions(c.env), {
      skipBlacklist,
    }),
  )
}

type HttpAbuseIdentity = {
  ip?: string
  key: string | null
  blocked: boolean
}

// 網頁/API 路徑以 IP 為身分做黑名單比對（與限流 key 同一套；IPv6 收斂到 /64）。
// 取不到 IP（本機 wrangler dev）時不比對、不記錄。
async function checkHttpBlacklist(
  c: Context<{ Bindings: Bindings }>,
): Promise<HttpAbuseIdentity> {
  const ip = c.req.header('cf-connecting-ip')
  const key = ip ? ipRateLimitKeyFromIp(ip) : null
  if (!key) return { ip, key, blocked: false }
  // 共用基礎設施網段（Cloudflare／WARP 出口、loopback、私有網段）豁免永久黑名單比對：
  // 這些位址一個背後是海量使用者，封鎖會誤傷無辜、也鎖住走 WARP 的開發者
  // （npm run preview 首頁 403，issue #49/#50）。即時限流與全域預算仍照常生效。
  if (ip && isBlacklistExemptIp(ip)) return { ip, key, blocked: false }
  return { ip, key, blocked: await isBlacklisted(c.env.ABUSE_DB, key) }
}

// LINE 來源的異常記錄。anonymous 桶可能混雜多個無法識別的使用者，
// 不自動記錄（否則 3 個不同人的異常會讓所有匿名事件一起被封鎖）。
function reportLineAbuse(
  c: Context<{ Bindings: Bindings }>,
  source: LineMessageEvent['source'],
  kind: AbuseKind,
  question: string,
): void {
  const key = lineRateLimitKey(source)
  if (key === 'line:anonymous') return
  reportAbuse(c, {
    key,
    kind,
    path: 'webhook',
    question,
    lineId: source.userId ?? source.groupId ?? source.roomId,
  })
}

async function checkGlobalGenerationBudget(
  env: Bindings,
): Promise<BudgetLimitDecision> {
  const ns = env.RATE_LIMIT_DO
  if (!ns) return { allowed: true }

  const minuteLimit = parsePositiveInteger(
    env.GLOBAL_GENERATION_LIMIT_PER_MINUTE,
    GLOBAL_GENERATION_LIMIT_PER_MINUTE,
  )
  const dayLimit = parsePositiveInteger(
    env.GLOBAL_GENERATION_LIMIT_PER_DAY,
    GLOBAL_GENERATION_LIMIT_PER_DAY,
  )

  try {
    const stub = ns.get(ns.idFromName('global:generation-budget'))
    const url = new URL('https://rate-limit/quota')
    url.searchParams.set('minute_limit', String(minuteLimit))
    url.searchParams.set('day_limit', String(dayLimit))
    const res = await stub.fetch(url.toString())
    return (await res.json()) as BudgetLimitDecision
  } catch (e) {
    console.error('全域生成配額檢查失敗，放行:', e)
    return { allowed: true }
  }
}

function retryAfterForBudget(decision: BudgetLimitDecision): string {
  return String(Math.max(1, decision.retryAfterSeconds ?? 60))
}

// 全域生成餘量比例（issue #40）：取分鐘/每日兩窗較緊者的剩餘占比，夾在 [0,1]，
// 再向下取到小數兩位 —— 寧可低估、不可高估（同一刻可能有別的請求正在消耗）。
export function capacityFraction(
  minuteCount: number,
  minuteLimit: number,
  dayCount: number,
  dayLimit: number,
): number {
  const minuteFraction = minuteLimit > 0 ? (minuteLimit - minuteCount) / minuteLimit : 0
  const dayFraction = dayLimit > 0 ? (dayLimit - dayCount) / dayLimit : 0
  const fraction = Math.min(minuteFraction, dayFraction)
  const clamped = Math.min(1, Math.max(0, fraction))
  return Math.floor(clamped * 100) / 100
}

export type GenerationCapacityStatus = 'available' | 'busy' | 'full'

export function capacityStatus(capacity: number): GenerationCapacityStatus {
  if (capacity >= 0.6) return 'available'
  if (capacity >= 0.3) return 'busy'
  return 'full'
}

// 查全域生成餘量（issue #40）：打 budget DO 的唯讀 /capacity 端點，不增計數、不消耗額度。
// 未綁 DO（dev/測試）或查詢失敗時回 1 —— 與 checkGlobalGenerationBudget 同樣 fail-open，
// 因為此時生成本就不受全域配額擋下，回報滿額才與實際放行行為一致。
async function getGenerationCapacity(env: Bindings): Promise<number> {
  const ns = env.RATE_LIMIT_DO
  if (!ns) return 1

  const minuteLimit = parsePositiveInteger(
    env.GLOBAL_GENERATION_LIMIT_PER_MINUTE,
    GLOBAL_GENERATION_LIMIT_PER_MINUTE,
  )
  const dayLimit = parsePositiveInteger(
    env.GLOBAL_GENERATION_LIMIT_PER_DAY,
    GLOBAL_GENERATION_LIMIT_PER_DAY,
  )

  try {
    const stub = ns.get(ns.idFromName('global:generation-budget'))
    const url = new URL('https://rate-limit/capacity')
    url.searchParams.set('minute_limit', String(minuteLimit))
    url.searchParams.set('day_limit', String(dayLimit))
    const res = await stub.fetch(url.toString())
    const data = (await res.json()) as { capacity?: number }
    return typeof data.capacity === 'number' ? data.capacity : 1
  } catch (e) {
    console.error('全域生成餘量查詢失敗，回報滿額:', e)
    return 1
  }
}

function shouldBypassCaches(refresh: string | undefined): boolean {
  return refresh === '1' || refresh === 'true'
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

type LineProfile = {
  userId?: string
  displayName?: string
  language?: string
}

// Get profile API：GET /v2/bot/profile/{userId}，Bearer 授權。失敗時回 null（優雅降級）。
async function getLineProfile(
  env: Bindings,
  userId: string,
): Promise<LineProfile | null> {
  try {
    const res = await fetch(`${LINE_PROFILE_ENDPOINT}/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    })
    if (!res.ok) {
      console.error('LINE Profile API 錯誤:', res.status, await res.text())
      return null
    }
    return (await res.json()) as LineProfile
  } catch (e) {
    console.error('LINE Profile API 例外:', e)
    return null
  }
}

// 歡迎訊息語言（issue #31）：profile.language 以 zh 開頭（zh-TW／zh-Hant…）用繁中，
// 其餘（en／ja…）用英文。language 缺席時（未授權或非認證帳號）預設 zh-Hant。
export function resolveWelcomeLang(profileLanguage: string | undefined): WebMessageLang {
  const lang = profileLanguage || 'zh-Hant'
  return lang.startsWith('zh') ? 'zh-Hant' : 'en'
}

// 加好友 follow event 的歡迎回覆（issue #31）：讀 profile 語言偏好，回對應語言的歡迎 Flex。
// 呼叫端已保證有 userId；黑名單成員（issue #27）只 ack 不回覆，與訊息路徑一致。
async function replyWithWelcome(
  env: Bindings,
  replyToken: string,
  source: LineMessageEvent['source'],
): Promise<void> {
  const userId = source.userId
  if (!userId) return
  if (await isBlacklisted(env.ABUSE_DB, lineRateLimitKey(source))) return

  const profile = await getLineProfile(env, userId)
  const welcomeLang = resolveWelcomeLang(profile?.language)
  await replyToLine(env, replyToken, {
    type: 'flex',
    altText: welcomeLang === 'en' ? WELCOME_ALT_TEXT_EN : WELCOME_ALT_TEXT,
    contents: welcomeLang === 'en' ? en_welcome : zh_welcome,
  })
}

// Fuse 退路：CAG 失敗或查無結果時，改用預建索引的前兩則最相近段落回覆。
async function replyWithFuseFallback(
  env: Bindings,
  replyToken: string,
  question: string,
  startedAt: number,
  lang: WebMessageLang,
): Promise<void> {
  try {
    const hits = await findClosestMatchingSections(env.ASK_INDEX, question, {
      limit: 2,
    })
    if (hits.length === 0) await delayUntilMinimumElapsed(startedAt)
    await replyToLine(
      env,
      replyToken,
      hits.length > 0
        ? formatFuseAnswerFlex(hits, lang)
        : { type: 'text', text: webMessage('notFound', lang) },
    )
  } catch (e) {
    console.error('Fuse fallback 失敗:', e)
    await replyToLine(env, replyToken, {
      type: 'text',
      text: lang === 'en' ? ERROR_REPLY_EN : ERROR_REPLY,
    })
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
  startedAt: number,
): Promise<void> {
  const retriever = resolveCagRetriever(env.CAG_RETRIEVER)
  // 全英文提問（issue #37）：以英文生成並回覆固定訊息；含中文則沿用預設繁中。
  const answerLanguage = detectCagAnswerLanguage(question)
  const lang: WebMessageLang = answerLanguage === 'en' ? 'en' : 'zh-Hant'
  // 回答生成對齊 /au：用 Audrey skill 模型（AUDREY_MODEL 未設時與 DEFAULT_CAG_MODEL 同為 Gemma）。
  const model = resolveAudreySkillModel(env.AUDREY_MODEL)
  // 快取：相同問題（retriever／model／語言相同）7 天內直接用快取的答案與來源回覆，不跑檢索與 AI。
  // answerLanguage 由問題字元決定，故同一問題語言固定；en 入 key 避免沿用舊的繁中快取項。
  const cacheKey = await buildCacheKey('webhook', question, {
    retriever,
    model,
    answerLanguage,
  })
  const cached = await getCachedResponse(env.ASK_CACHE, cacheKey)
  if (cached) {
    try {
      const { answer, sources } = JSON.parse(cached.body) as {
        answer: string
        sources: CagSource[]
      }
      const refresh = refreshCachedResponse(env.ASK_CACHE, cacheKey, cached)
      await replyToLine(env, replyToken, formatCagAnswerFlex(answer, sources, lang))
      await refresh
      return
    } catch (e) {
      console.error('webhook 快取解析失敗，改為重新生成:', e)
    }
  }

  const budget = await checkGlobalGenerationBudget(env)
  if (!budget.allowed) {
    await replyToLine(env, replyToken, { type: 'text', text: webMessage('budget', lang) })
    return
  }

  await startLineLoading(env, userId)

  let cag: CagAnswer | null = null
  let cagFailed = false
  try {
    cag = await generateCagAnswer(env.AI, question, {
      archiveBaseUrl: env.ASK_ARCHIVE_BASE_URL,
      topK: WEBHOOK_CAG_TOP_K,
      citableTopK: WEBHOOK_CAG_CITE_TOP_K,
      maxCompletionTokens: WEBHOOK_CAG_MAX_COMPLETION_TOKENS,
      model,
      // 對齊 /au 的唐鳳風格回答指示，再追加 LINE 對話框適讀的長度上限。
      answerInstruction:
        buildAudreySkillAnswerInstruction(answerLanguage) +
        ' ' +
        (answerLanguage === 'en'
          ? WEBHOOK_CAG_LENGTH_INSTRUCTION_EN
          : WEBHOOK_CAG_LENGTH_INSTRUCTION),
      answerLanguage,
      retriever,
      vectorize: env.VECTORIZE,
      vectorizeMinScore: resolveVectorizeMinScore(env.CAG_VECTORIZE_MIN_SCORE),
      cagCache: env.CAG_CACHE,
      sayitDb: env.SAYIT_DB,
    })
  } catch (e) {
    cagFailed = true
    console.error('CAG 生成失敗，改用 Fuse fallback:', e)
  }

  if (!cag || cag.answer.trim() === '') {
    if (!cagFailed && retriever === 'vectorize' && env.VECTORIZE) {
      await delayUntilMinimumElapsed(startedAt)
      await replyToLine(env, replyToken, { type: 'text', text: webMessage('notFound', lang) })
      return
    }
    await replyWithFuseFallback(env, replyToken, question, startedAt, lang)
    return
  }
  const answer = splitSentencesToLines(trimToCompleteSentence(cag.answer))
  const cacheable = isCacheableCagAnswerText(answer)
  if (!cacheable) {
    await delayUntilMinimumElapsed(startedAt)
  }
  await replyToLine(env, replyToken, formatCagAnswerFlex(answer, cag.sources, lang))
  // 成功生成才寫入快取（answer + sources），供下次相同問題直接取用。
  if (cacheable) {
    await putCachedResponse(
      env.ASK_CACHE,
      cacheKey,
      JSON.stringify({ answer, sources: cag.sources }),
      'application/json; charset=UTF-8',
    )
  }
}

app.get('/', (c) => {
  return c.html(renderHomePage())
})

app.get('/en', (c) => {
  return c.html(renderHomePage('en'))
})

app.get('/privacy', (c) => {
  return c.html(renderPrivacyPolicyPage())
})

app.get('/terms', (c) => {
  return c.html(renderTermsOfUsePage())
})

app.get('/en/privacy', (c) => {
  return c.html(renderPrivacyPolicyPage('en'))
})

app.get('/en/terms', (c) => {
  return c.html(renderTermsOfUsePage('en'))
})

app.get('/robot.txt', (c) => {
  return c.text(ROBOTS_TXT)
})

app.get('/robots.txt', (c) => {
  return c.text(ROBOTS_TXT)
})

app.get('/ask/:question', async (c) => {
  const startedAt = Date.now()
  const question = decodeRouteParam(c.req.param('question'))
  // 受信任呼叫端（帶有效 AUDREYT_TRANSCRIPT_TOKEN）略過限流、黑名單與全域預算。
  const trusted = await isTrustedCaller(c)
  // 黑名單比對在任何 DO/KV 限流記帳之前（issue #27）。
  const abuse = trusted ? null : await checkHttpBlacklist(c)
  if (abuse?.blocked) {
    return c.text(BLACKLISTED_HTTP_MESSAGE, 403)
  }
  if (!trusted && await isIpRateLimited(c)) {
    reportAbuse(c, { key: abuse?.key ?? null, kind: 'rate_limit', path: 'ask', question, ip: abuse?.ip })
    return c.text(RATE_LIMIT_HTTP_MESSAGE, 429, {
      'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS),
    })
  }
  if (isQuestionTooLong(question)) {
    reportAbuse(c, { key: abuse?.key ?? null, kind: 'question_too_long', path: 'ask', question, ip: abuse?.ip })
    return c.text(QUESTION_TOO_LONG_MESSAGE, 400)
  }
  // 相同問題 7 天內直接取用快取。
  const cacheKey = await buildCacheKey('ask', question)

  if (cacheKey) {
    const cached = await getCachedResponse(c.env.ASK_CACHE, cacheKey)
    if (cached) {
      c.executionCtx.waitUntil(refreshCachedResponse(c.env.ASK_CACHE, cacheKey, cached))
      return respondFromCache(cached.body, cached.contentType)
    }
  }

  const budget = trusted ? { allowed: true } : await checkGlobalGenerationBudget(c.env)
  if (!budget.allowed) {
    return c.text(GLOBAL_BUDGET_HTTP_MESSAGE, 429, {
      'Retry-After': retryAfterForBudget(budget),
    })
  }

  try {
    const hit = await findClosestMatchingSection(c.env.ASK_INDEX, question)
    if (!hit) {
      await delayUntilMinimumElapsed(startedAt)
      return c.text(NOT_FOUND_REPLY, 404)
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

app.get('/au/status', (c) => {
  const model = resolveAudreySkillModel(c.env.AUDREY_MODEL)
  return c.json({
    ...getCagStatus({
      archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
      retriever: resolveCagRetriever(c.req.query('retriever'), c.env.CAG_RETRIEVER),
      vectorizeBound: Boolean(c.env.VECTORIZE),
      sourceCacheBound: Boolean(c.env.CAG_CACHE),
      vectorizeMinScore: resolveVectorizeMinScore(
        c.req.query('min_score') ?? c.req.query('minScore'),
        c.env.CAG_VECTORIZE_MIN_SCORE,
      ),
      model,
    }),
    mode: 'audrey-skill',
  })
})

app.options('/au/:question', askCorsPreflight)

app.get('/au/:question', async (c) => {
  const lang = resolveWebLang(c.req.query('lang'))
  const messages = WEB_MESSAGES[lang]
  const question = decodeRouteParam(c.req.param('question'))
  // 受信任呼叫端（帶有效 AUDREYT_TRANSCRIPT_TOKEN）略過限流、黑名單與全域預算。
  const trusted = await isTrustedCaller(c)
  const abuse = trusted ? null : await checkHttpBlacklist(c)
  if (abuse?.blocked) {
    return applyAskCors(c, c.text(messages.blacklisted, 403))
  }
  if (!trusted && await isIpRateLimited(c)) {
    reportAbuse(c, { key: abuse?.key ?? null, kind: 'rate_limit', path: 'au', question, ip: abuse?.ip })
    return applyAskCors(c, c.text(messages.rateLimited, 429, {
      'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS),
    }))
  }
  if (isQuestionTooLong(question)) {
    reportAbuse(c, { key: abuse?.key ?? null, kind: 'question_too_long', path: 'au', question, ip: abuse?.ip })
    return applyAskCors(c, c.text(messages.tooLong, 400))
  }

  const bypassCache = shouldBypassCaches(c.req.query('refresh'))
  const topK = parsePositiveInteger(c.req.query('top_k') ?? c.req.query('topK'), DEFAULT_TOP_K)
  const citableTopK = parseOptionalPositiveInteger(
    c.req.query('cite_top_k') ?? c.req.query('citeTopK'),
  )
  const maxCompletionTokens = parsePositiveInteger(
    c.req.query('max_tokens') ?? c.req.query('maxTokens'),
    AUDREY_MAX_COMPLETION_TOKENS,
  )
  const retriever = resolveCagRetriever(c.req.query('retriever'), c.env.CAG_RETRIEVER)
  const vectorizeMinScore = resolveVectorizeMinScore(
    c.req.query('min_score') ?? c.req.query('minScore'),
    c.env.CAG_VECTORIZE_MIN_SCORE,
  )
  const model = resolveAudreySkillModel(c.env.AUDREY_MODEL)
  const answerLanguage = lang === 'en' ? 'en' : undefined
  const cagOptions = normalizeCagOptions({
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    topK,
    citableTopK,
    maxCompletionTokens,
    model,
    answerInstruction: buildAudreySkillAnswerInstruction(answerLanguage),
    retriever,
    vectorize: c.env.VECTORIZE,
    vectorizeMinScore,
    cagCache: c.env.CAG_CACHE,
    skipSourceCache: bypassCache,
    answerLanguage,
    citationTransform: audreySkillCitationFootnotes,
    sayitDb: c.env.SAYIT_DB,
    aiGateway: resolveAudreyAiGateway(c.env),
  })
  const cacheKey = await buildCacheKey('au', question, {
    archiveBaseUrl: cagOptions.archiveBaseUrl,
    model: cagOptions.model,
    topK: cagOptions.topK,
    citableTopK: cagOptions.citableTopK,
    maxCompletionTokens: cagOptions.maxCompletionTokens,
    retriever: cagOptions.retriever,
    vectorizeMinScore: cagOptions.vectorizeMinScore,
    ...(answerLanguage === 'en' ? { answerLanguage: 'en' } : {}),
  })
  if (!bypassCache) {
    const cached = await getCachedResponse(c.env.ASK_CACHE, cacheKey)
    if (cached) {
      c.executionCtx.waitUntil(refreshCachedResponse(c.env.ASK_CACHE, cacheKey, cached))
      return applyAskCors(c, respondFromCache(cached.body, cached.contentType))
    }
  }

  const budget = trusted ? { allowed: true } : await checkGlobalGenerationBudget(c.env)
  if (!budget.allowed) {
    return applyAskCors(c, c.text(messages.budget, 429, {
      'Retry-After': retryAfterForBudget(budget),
    }))
  }

  const response = await streamCagAnswer(c.env.AI, question, cagOptions)
  if (response.status === 404 && lang === 'en') {
    await response.body?.cancel()
    return applyAskCors(c, new Response(NOT_FOUND_REPLY_HTML_EN, {
      status: 404,
      headers: response.headers,
    }))
  }
  return applyAskCors(c, cacheCagResponse(c, bypassCache ? null : cacheKey, response))
})

app.post('/au', async (c) => {
  // 受信任呼叫端（帶有效 AUDREYT_TRANSCRIPT_TOKEN）略過限流、黑名單與全域預算。
  const trusted = await isTrustedCaller(c)
  const abuse = trusted ? null : await checkHttpBlacklist(c)
  if (abuse?.blocked) {
    return c.text(BLACKLISTED_HTTP_MESSAGE, 403)
  }
  if (!trusted && await isIpRateLimited(c)) {
    let loggedQuestion = ''
    try {
      const body = (await c.req.json()) as { question?: unknown }
      if (typeof body.question === 'string') loggedQuestion = body.question
    } catch {
      // 解析失敗就記空問題。
    }
    reportAbuse(c, {
      key: abuse?.key ?? null,
      kind: 'rate_limit',
      path: 'au',
      question: loggedQuestion,
      ip: abuse?.ip,
    })
    return c.text(RATE_LIMIT_HTTP_MESSAGE, 429, {
      'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS),
    })
  }

  let payload: { question?: unknown; topK?: unknown; top_k?: unknown; citableTopK?: unknown; cite_top_k?: unknown; maxTokens?: unknown; max_tokens?: unknown; retriever?: unknown; minScore?: unknown; min_score?: unknown; refresh?: unknown }
  try {
    payload = await c.req.json()
  } catch {
    return c.text('Invalid JSON payload', 400)
  }

  const question = typeof payload.question === 'string' ? payload.question : ''
  if (question.trim() === '') {
    return c.text('question is required', 400)
  }
  if (isQuestionTooLong(question)) {
    reportAbuse(c, { key: abuse?.key ?? null, kind: 'question_too_long', path: 'au', question, ip: abuse?.ip })
    return c.text(QUESTION_TOO_LONG_MESSAGE, 400)
  }

  const bypassCache = typeof payload.refresh === 'boolean'
    ? payload.refresh
    : typeof payload.refresh === 'string'
      ? shouldBypassCaches(payload.refresh)
      : false
  const topK = typeof payload.topK === 'number'
    ? payload.topK
    : typeof payload.top_k === 'number'
      ? payload.top_k
      : DEFAULT_TOP_K
  const maxCompletionTokens = typeof payload.maxTokens === 'number'
    ? payload.maxTokens
    : typeof payload.max_tokens === 'number'
      ? payload.max_tokens
      : AUDREY_MAX_COMPLETION_TOKENS
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
  const answerLanguage = detectCagAnswerLanguage(question)
  const model = resolveAudreySkillModel(c.env.AUDREY_MODEL)
  const cagOptions = normalizeCagOptions({
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    topK,
    citableTopK,
    maxCompletionTokens,
    model,
    answerInstruction: buildAudreySkillAnswerInstruction(answerLanguage),
    retriever,
    vectorize: c.env.VECTORIZE,
    vectorizeMinScore,
    cagCache: c.env.CAG_CACHE,
    skipSourceCache: bypassCache,
    answerLanguage,
    citationTransform: audreySkillCitationFootnotes,
    sayitDb: c.env.SAYIT_DB,
    aiGateway: resolveAudreyAiGateway(c.env),
  })
  const cacheKey = await buildCacheKey('au', question, {
    archiveBaseUrl: cagOptions.archiveBaseUrl,
    model: cagOptions.model,
    topK: cagOptions.topK,
    citableTopK: cagOptions.citableTopK,
    maxCompletionTokens: cagOptions.maxCompletionTokens,
    retriever: cagOptions.retriever,
    vectorizeMinScore: cagOptions.vectorizeMinScore,
    ...(answerLanguage === 'en' ? { answerLanguage: 'en' } : {}),
  })
  if (!bypassCache) {
    const cached = await getCachedResponse(c.env.ASK_CACHE, cacheKey)
    if (cached) {
      c.executionCtx.waitUntil(refreshCachedResponse(c.env.ASK_CACHE, cacheKey, cached))
      return respondFromCache(cached.body, cached.contentType)
    }
  }

  const budget = trusted ? { allowed: true } : await checkGlobalGenerationBudget(c.env)
  if (!budget.allowed) {
    return c.text(GLOBAL_BUDGET_HTTP_MESSAGE, 429, {
      'Retry-After': retryAfterForBudget(budget),
    })
  }

  const response = await streamCagAnswer(c.env.AI, question, cagOptions)
  if (response.status === 404 && answerLanguage === 'en') {
    await response.body?.cancel()
    return new Response(NOT_FOUND_REPLY_HTML_EN, {
      status: 404,
      headers: response.headers,
    })
  }
  return cacheCagResponse(c, bypassCache ? null : cacheKey, response)
})

app.get('/cag/status', (c) => {
  return c.json(getCagStatus({
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    retriever: resolveCagRetriever(c.req.query('retriever'), c.env.CAG_RETRIEVER),
    vectorizeBound: Boolean(c.env.VECTORIZE),
    sourceCacheBound: Boolean(c.env.CAG_CACHE),
    vectorizeMinScore: resolveVectorizeMinScore(
      c.req.query('min_score') ?? c.req.query('minScore'),
      c.env.CAG_VECTORIZE_MIN_SCORE,
    ),
  }))
})

app.options('/capacity', askCorsPreflight)
app.options('/cag/:question', askCorsPreflight)

// 任何人都能查目前 AI 生成狀態（issue #40）：機器人由 robots.txt 擋，
// 惡意 IP 仍走黑名單與獨立 IP 限流；唯讀查 DO、不消耗額度。
app.get('/capacity', async (c) => {
  // 受信任呼叫端（帶有效 AUDREYT_TRANSCRIPT_TOKEN）略過限流與黑名單。
  const trusted = await isTrustedCaller(c)
  const abuse = trusted ? null : await checkHttpBlacklist(c)
  if (abuse?.blocked) {
    return applyAskCors(c, c.text(BLACKLISTED_HTTP_MESSAGE, 403))
  }
  if (!trusted && await isCapacityRateLimited(c)) {
    return applyAskCors(c, c.text(RATE_LIMIT_HTTP_MESSAGE, 429, {
      'Retry-After': String(CAPACITY_RATE_LIMIT_RETRY_AFTER_SECONDS),
    }))
  }
  const capacity = await getGenerationCapacity(c.env)
  c.header('Cache-Control', CAPACITY_CACHE_CONTROL)
  return applyAskCors(c, c.json({ status: capacityStatus(capacity) }))
})

app.get('/cag/:question', async (c) => {
  const startedAt = Date.now()
  // 網頁 UI 從這條路由串流，使用者可見訊息依 ?lang=en 在地化；一次解析、整路沿用。
  const lang = resolveWebLang(c.req.query('lang'))
  const messages = WEB_MESSAGES[lang]
  const question = decodeRouteParam(c.req.param('question'))
  // 受信任呼叫端（帶有效 AUDREYT_TRANSCRIPT_TOKEN）略過限流、黑名單與全域預算。
  const trusted = await isTrustedCaller(c)
  // 黑名單比對在任何 DO/KV 限流記帳之前（issue #27）。
  const abuse = trusted ? null : await checkHttpBlacklist(c)
  if (abuse?.blocked) {
    return applyAskCors(c, c.text(messages.blacklisted, 403))
  }
  if (!trusted && await isIpRateLimited(c)) {
    reportAbuse(c, { key: abuse?.key ?? null, kind: 'rate_limit', path: 'cag', question, ip: abuse?.ip })
    return applyAskCors(c, c.text(messages.rateLimited, 429, {
      'Retry-After': String(RATE_LIMIT_RETRY_AFTER_SECONDS),
    }))
  }
  if (isQuestionTooLong(question)) {
    reportAbuse(c, { key: abuse?.key ?? null, kind: 'question_too_long', path: 'cag', question, ip: abuse?.ip })
    return applyAskCors(c, c.text(messages.tooLong, 400))
  }
  const bypassCache = shouldBypassCaches(c.req.query('refresh'))
  const topK = parsePositiveInteger(c.req.query('top_k') ?? c.req.query('topK'), DEFAULT_TOP_K)
  const citableTopK = parseOptionalPositiveInteger(
    c.req.query('cite_top_k') ?? c.req.query('citeTopK'),
  )
  const maxCompletionTokens = parsePositiveInteger(
    c.req.query('max_tokens') ?? c.req.query('maxTokens'),
    DEFAULT_MAX_COMPLETION_TOKENS,
  )
  const retriever = resolveCagRetriever(c.req.query('retriever'), c.env.CAG_RETRIEVER)
  const vectorizeMinScore = resolveVectorizeMinScore(
    c.req.query('min_score') ?? c.req.query('minScore'),
    c.env.CAG_VECTORIZE_MIN_SCORE,
  )
  const cagOptions = normalizeCagOptions({
    archiveBaseUrl: c.env.ASK_ARCHIVE_BASE_URL,
    topK,
    citableTopK,
    maxCompletionTokens,
    retriever,
    vectorize: c.env.VECTORIZE,
    vectorizeMinScore,
    cagCache: c.env.CAG_CACHE,
    skipSourceCache: bypassCache,
    answerLanguage: lang === 'en' ? 'en' : undefined,
    sayitDb: c.env.SAYIT_DB,
  })

  // 快取 key 納入實際生效的參數（含 clamp/default 後的值），避免用超大參數繞過快取。
  // lang=en 會改變生成語言，必須一併納入 key；繁中（預設）不帶，沿用既有快取項。
  const cacheKey = await buildCacheKey('cag', question, {
    archiveBaseUrl: cagOptions.archiveBaseUrl,
    model: DEFAULT_CAG_MODEL,
    topK: cagOptions.topK,
    citableTopK: cagOptions.citableTopK,
    maxCompletionTokens: cagOptions.maxCompletionTokens,
    retriever: cagOptions.retriever,
    vectorizeMinScore: cagOptions.vectorizeMinScore,
    ...(lang === 'en' ? { answerLanguage: 'en' } : {}),
  })
  if (!bypassCache) {
    const cached = await getCachedResponse(c.env.ASK_CACHE, cacheKey)
    if (cached) {
      c.executionCtx.waitUntil(refreshCachedResponse(c.env.ASK_CACHE, cacheKey, cached))
      return applyAskCors(c, respondFromCache(cached.body, cached.contentType))
    }
  }

  const budget = trusted ? { allowed: true } : await checkGlobalGenerationBudget(c.env)
  if (!budget.allowed) {
    return applyAskCors(c, c.text(messages.budget, 429, {
      'Retry-After': retryAfterForBudget(budget),
    }))
  }

  const response = await streamCagAnswer(c.env.AI, question, cagOptions)
  // streamCagAnswer 查無來源時回 404（內文為繁中 HTML，issue #29）；
  // 英文介面（?lang=en）換成對應的英文 HTML 版本。
  if (response.status === 404 && lang === 'en') {
    await response.body?.cancel()
    return applyAskCors(c, new Response(NOT_FOUND_REPLY_HTML_EN, {
      status: 404,
      headers: response.headers,
    }))
  }
  return applyAskCors(c, cacheCagResponse(c, bypassCache ? null : cacheKey, response))
})

app.post('/webhook', async (c) => {
  const startedAt = Date.now()
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

  // 加好友（follow event）：依使用者 profile 語言偏好回雙語歡迎 Flex（issue #31）。
  // 無 userId（使用者未授權 profile）就只 ack 丟棄：既讀不到語言偏好、也無從限流。
  // reply token 過期（多為 LINE 重送的舊事件）同樣略過。
  if (event.type === 'follow') {
    if (event.source.userId && Date.now() - event.timestamp <= REPLY_TOKEN_TTL_MS) {
      c.executionCtx.waitUntil(replyWithWelcome(c.env, event.replyToken, event.source))
    }
    return c.text('OK', 200)
  }

  if (event.type !== 'message' || event.message?.type !== 'text') {
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
  // 全英文提問（issue #37）連同固定提示一併以英文回覆；含中文則沿用預設繁中。
  const lang: WebMessageLang = detectCagAnswerLanguage(userText) === 'en' ? 'en' : 'zh-Hant'

  // 個別使用者未提供可識別 ID（issue #39）：1:1 個人聊天無 userId、又非帶 groupId/roomId
  // 的群組/房間，會落入共用的 'line:anonymous' 桶——無從個別限流、也無從加入黑名單，
  // 故直接 ack 丟棄，不生成、不回覆。群組/房間因有 groupId/roomId 可識別，正常回應。
  if (lineRateLimitKey(event.source) === 'line:anonymous') {
    return c.text('OK', 200)
  }

  // 黑名單成員直接 ack 後丟棄（issue #27）：不回覆、不做任何 DO/KV 限流記帳，
  // 完全不消耗全域生成額度。回 200 是為了避免 LINE 平台重送同一事件。
  if (await isBlacklisted(c.env.ABUSE_DB, lineRateLimitKey(event.source))) {
    return c.text('OK', 200)
  }

  if (isQuestionTooLong(userText)) {
    reportLineAbuse(c, event.source, 'question_too_long', userText)
    c.executionCtx.waitUntil(
      replyToLine(c.env, replyToken, { type: 'text', text: webMessage('tooLong', lang) }),
    )
    return c.text('OK', 200)
  }

  // 防連續濫用：同一 LINE 來源冷卻視窗內第 2 則訊息，只回個提示，不再做 CAG 生成。
  // userId 缺席時改以 groupId / roomId / anonymous 做較粗的限流，避免群組事件繞過。
  // （仍須回 200 ack，並用一次性 reply token 送出提示。）
  if (await isRateLimited(c.env, lineRateLimitKey(event.source))) {
    reportLineAbuse(c, event.source, 'rate_limit', userText)
    c.executionCtx.waitUntil(
      replyToLine(c.env, replyToken, { type: 'text', text: webMessage('rateLimited', lang) }),
    )
    return c.text('OK', 200)
  }

  // 關鍵：CAG 生成需數秒到十幾秒，超過 LINE 對 webhook 的「2 秒內回 2xx」限制，
  // 因此把慢工作交給 ctx.waitUntil 背景執行（回應後最多 30 秒預算），handler 立刻 ack。
  // reply token 約 1 分鐘有效，留待背景用 Reply API 送出「唯一一次」回覆。
  c.executionCtx.waitUntil(replyWithCag(c.env, replyToken, userId, userText, startedAt))

  return c.text('OK', 200)
})

type QuotaBucket = {
  windowStartMs: number
  count: number
}

// 限流用 Durable Object：
// - 每個使用者/IP key 一顆物件：記憶體保留「上次通過時間」，做精準冷卻。
// - global:generation-budget 單一物件：用 storage 保存分鐘/每日共享計數器，跨實例回收仍有效。
export class RateLimiterDO {
  private lastAllowedMs = 0

  constructor(private readonly state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/quota') {
      return this.handleQuota(url)
    }
    if (url.pathname === '/capacity') {
      return this.handleCapacity(url)
    }

    const windowMs =
      Number(url.searchParams.get('window_ms')) || RATE_LIMIT_WINDOW_MS
    const now = Date.now()
    if (now - this.lastAllowedMs < windowMs) {
      return Response.json({ allowed: false })
    }
    this.lastAllowedMs = now
    return Response.json({ allowed: true })
  }

  private async handleQuota(url: URL): Promise<Response> {
    const minuteLimit =
      Number(url.searchParams.get('minute_limit')) || GLOBAL_GENERATION_LIMIT_PER_MINUTE
    const dayLimit =
      Number(url.searchParams.get('day_limit')) || GLOBAL_GENERATION_LIMIT_PER_DAY
    const now = Date.now()
    const minuteStartMs = Math.floor(now / 60_000) * 60_000
    const dayStartMs = Math.floor(now / 86_400_000) * 86_400_000

    const decision = await this.state.storage.transaction(async (txn) => {
      const minute = await txn.get<QuotaBucket>('quota:minute')
      const day = await txn.get<QuotaBucket>('quota:day')
      const nextMinute =
        minute?.windowStartMs === minuteStartMs
          ? minute
          : { windowStartMs: minuteStartMs, count: 0 }
      const nextDay =
        day?.windowStartMs === dayStartMs
          ? day
          : { windowStartMs: dayStartMs, count: 0 }

      if (nextMinute.count >= minuteLimit) {
        return {
          allowed: false,
          reason: 'minute' as const,
          retryAfterSeconds: Math.ceil((minuteStartMs + 60_000 - now) / 1000),
        }
      }
      if (nextDay.count >= dayLimit) {
        return {
          allowed: false,
          reason: 'day' as const,
          retryAfterSeconds: Math.ceil((dayStartMs + 86_400_000 - now) / 1000),
        }
      }

      nextMinute.count += 1
      nextDay.count += 1
      await txn.put('quota:minute', nextMinute)
      await txn.put('quota:day', nextDay)
      return { allowed: true }
    })

    return Response.json(decision)
  }

  // 唯讀餘量查詢（issue #40）：只讀兩個桶、不開 transaction、不寫回 —— 不增計數、不消耗額度。
  // 視窗已輪替的桶其計數視為 0（與 handleQuota 的重置邏輯一致）。
  private async handleCapacity(url: URL): Promise<Response> {
    const minuteLimit =
      Number(url.searchParams.get('minute_limit')) || GLOBAL_GENERATION_LIMIT_PER_MINUTE
    const dayLimit =
      Number(url.searchParams.get('day_limit')) || GLOBAL_GENERATION_LIMIT_PER_DAY
    const now = Date.now()
    const minuteStartMs = Math.floor(now / 60_000) * 60_000
    const dayStartMs = Math.floor(now / 86_400_000) * 86_400_000

    const minute = await this.state.storage.get<QuotaBucket>('quota:minute')
    const day = await this.state.storage.get<QuotaBucket>('quota:day')
    const minuteCount = minute?.windowStartMs === minuteStartMs ? minute.count : 0
    const dayCount = day?.windowStartMs === dayStartMs ? day.count : 0

    return Response.json({
      capacity: capacityFraction(minuteCount, minuteLimit, dayCount, dayLimit),
    })
  }
}

export default app
