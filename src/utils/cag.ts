import {
  CAG_MODEL_GEMMA,
  CAG_TYPICAL_INPUT_TOKENS,
  CAG_TYPICAL_OUTPUT_TOKENS,
  estimateCagRequestCostUsd,
} from './cagEval'
import {
  htmlToPlainText,
} from './search'
import {
  buildCagSourceCacheKey,
  getCachedCagSources,
  putCachedCagSources,
} from './cagCache'
import {
  DEFAULT_VECTORIZE_MIN_COSINE_SCORE,
  retrieveCagSourcesFromVectorize,
  type VectorizeBinding,
} from './vectorize'
import { NOT_FOUND_REPLY_HTML } from './notFoundReply'

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

/** 檢索來源：archive.tw 即時搜尋 或 Cloudflare Vectorize 語意索引。 */
export type CagRetriever = 'archive' | 'vectorize'

export type CagOptions = {
  topK?: number
  /**
   * 可被引用／顯示的來源數（預設等於 topK）。
   * 設小於 topK 時：前 citableTopK 筆為可引用來源（編號 [1..K]、回傳給呼叫端顯示），
   * 其餘 topK−citableTopK 筆僅作為模型的背景脈絡，不編號、不顯示。
   */
  citableTopK?: number
  maxCompletionTokens?: number
  archiveBaseUrl?: string
  answerInstruction?: string
  /** 檢索器，預設 'archive'；'vectorize' 需一併提供 vectorize binding。 */
  retriever?: CagRetriever
  /** Vectorize binding（retriever='vectorize' 時使用）。 */
  vectorize?: VectorizeBinding
  /** Vectorize cosine score 最低納入門檻，預設 0.8。 */
  vectorizeMinScore?: number
  /** KV 來源快取；未綁時優雅降級。 */
  cagCache?: KVNamespace
  /** 略過 KV 來源快取（例如 `?refresh=1`）。 */
  skipSourceCache?: boolean
  /** 'en' 時明確要求以英文作答（/en 介面經 ?lang=en 帶入）。 */
  answerLanguage?: 'en'
}

export { CAG_MODEL_GEMMA } from './cagEval'
export const DEFAULT_CAG_MODEL = CAG_MODEL_GEMMA

export const DEFAULT_ARCHIVE_BASE_URL = 'https://archive.tw'
export const DEFAULT_TOP_K = 4
const MAX_TOP_K = 8
export const DEFAULT_MAX_COMPLETION_TOKENS = 500
export const MAX_CONTEXT_SECTION_CHARS = 1_200
const MAX_SEARCH_VARIANTS = 6
export const MIN_ARCHIVE_HITS_BEFORE_FALLBACK = 3

type ArchiveSearchResult = {
  title?: string
  url?: string
  date?: string
  speaker?: string
  snippet?: string
}

type ArchiveSearchResponse = {
  results?: ArchiveSearchResult[]
}

type ArchiveSectionResponse = {
  filename?: string
  nest_filename?: string | null
  section_id?: number | string
  section_content?: string | null
  previous_content?: string | null
  next_content?: string | null
  display_name?: string | null
  name?: string | null
}

export type CagSource = {
  content: string
  href: string
  label: string
  sectionId: number | null
}

export type CagAnswer = {
  answer: string
  sources: CagSource[]
}

export type CagStatus = {
  retriever: CagRetriever
  /** runtime 是否真的綁了 VECTORIZE binding；false 時即使 retriever=vectorize 也會回退 archive。 */
  vectorizeBound: boolean
  archiveBaseUrl: string
  model: string
  vectorizeMinScore: number
  maxTopK: number
  maxContextSectionChars: number
  /** runtime 是否綁了 CAG_CACHE KV（來源快取）。 */
  sourceCacheBound: boolean
  estimatedCostPerRequestUsd: number | null
  typicalTokenProfile: {
    inputTokens: number
    outputTokens: number
  }
}

export type NormalizedCagOptions = {
  topK: number
  citableTopK: number
  maxCompletionTokens: number
  archiveBaseUrl: string
  answerInstruction?: string
  retriever: CagRetriever
  vectorize?: VectorizeBinding
  vectorizeMinScore: number
  answerLanguage?: 'en'
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

export function normalizeCagOptions(options?: CagOptions): NormalizedCagOptions {
  const topK = clampInteger(options?.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K)
  const citableTopK = options?.citableTopK === undefined
    ? topK
    : clampInteger(options.citableTopK, 1, topK)
  return {
    topK,
    citableTopK,
    maxCompletionTokens: clampInteger(
      options?.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      1,
      4_096,
    ),
    archiveBaseUrl: normalizeArchiveBaseUrl(options?.archiveBaseUrl),
    answerInstruction: options?.answerInstruction,
    retriever: options?.retriever ?? 'archive',
    vectorize: options?.vectorize,
    vectorizeMinScore: options?.vectorizeMinScore ?? DEFAULT_VECTORIZE_MIN_COSINE_SCORE,
    answerLanguage: options?.answerLanguage,
  }
}

function truncateContextText(value: string): string {
  if (value.length <= MAX_CONTEXT_SECTION_CHARS) return value
  return `${value.slice(0, MAX_CONTEXT_SECTION_CHARS).trimEnd()}\n[... excerpt trimmed ...]`
}

function footnoteForSource(source: CagSource): string {
  return `[${source.label}](${source.href})`
}

function sourceBlock(
  source: CagSource,
  options: { id?: number; tag: 'source' | 'background_source' },
): string {
  const content = truncateContextText(htmlToPlainText(source.content))
  const attrs = options.id === undefined ? '' : ` id="${options.id}"`

  return [
    `<${options.tag}${attrs}>`,
    '```text',
    content,
    '```',
    `</${options.tag}>`,
  ].join('\n')
}

export function buildCagMessages(
  question: string,
  sources: CagSource[],
  background: CagSource[] = [],
  answerInstruction = 'Answer concisely. Prefer exact wording from the excerpts where useful.',
  answerLanguage?: 'en',
): ChatMessage[] {
  const lore = sources
    .map((source, index) => sourceBlock(source, {
      id: index + 1,
      tag: 'source',
    }))
    .join('\n\n')

  // 背景參考：逐筆保留來源邊界，但「不編號、不可被引用」。
  const backgroundText = background
    .map((source) => sourceBlock(source, { tag: 'background_source' }))
    .join('\n\n')

  const systemLines = [
    'You answer questions using only the SayIt transcript excerpts supplied by the user.',
    'Treat every <source> and <background_source> as an independent excerpt that may come from a different article, interview, date, or speaker.',
    'Do not merge adjacent sources into one continuous transcript and do not infer continuity across source boundaries.',
    'Do not invent details outside the excerpts.',
    'When stating a concrete fact, cite a numbered source from <lore> as [1], [2], etc.',
    'If the excerpts do not support an answer, say so clearly.',
    'Cite the section that directly supports each claim.',
    'When sources are unrelated, analyze them separately instead of forcing a single combined narrative.',
  ]
  if (background.length > 0) {
    systemLines.push(
      'The <background> block is unnumbered context to help you understand the topic;',
      'use it to inform your answer but never cite it and never invent source numbers for it.',
    )
  }
  if (answerLanguage === 'en') {
    systemLines.push(
      'Answer in English, even when the excerpts are in Chinese — translate the material you use into English and keep the numeric citation markers.',
    )
  } else {
    systemLines.push(
      'Use Traditional Chinese when the user asks in Chinese or includes #zh-tw.',
    )
  }

  const userLines = ['<lore>', lore, '</lore>']
  if (background.length > 0) {
    userLines.push('', '<background>', backgroundText, '</background>')
  }
  userLines.push('', `Question: ${question}`, '', answerInstruction)

  return [
    { role: 'system', content: systemLines.join(' ') },
    { role: 'user', content: userLines.join('\n') },
  ]
}

function normalizeArchiveBaseUrl(value: string | undefined): string {
  const raw = (value || DEFAULT_ARCHIVE_BASE_URL).trim()
  try {
    const url = new URL(raw)
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return DEFAULT_ARCHIVE_BASE_URL
  }
}

function stripQuestionDirectives(question: string): string {
  return question
    .replace(/#[\p{Letter}\p{Number}_-]+/gu, ' ')
    .replace(/^\s*(?:請|麻煩)?\s*用\s+[\s\S]{0,40}?回答[:：]\s*/u, '')
    .replace(/^\s*(?:請|麻煩)?\s*(?:回答|說明|解釋|summarize|answer)\s*[:：]?\s*/iu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function pushUnique(values: string[], value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized && !values.includes(normalized)) values.push(normalized)
}

/** 英文疑問詞／功能詞：archive.tw 搜尋對這些 stopword 回空集合，需先剝除。 */
const EN_STOPWORDS = new Set([
  'what', 'who', 'whom', 'whose', 'which', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'am', 'be', 'been',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'shall',
  'may', 'might', 'must',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'about',
  'your', 'you', 'my', 'we', 'us', 'our', 'their', 'his', 'her', 'its',
  'i', 'me', 'he', 'she', 'they', 'them',
  'it', 'this', 'that', 'these', 'those',
  'and', 'or', 'not', 'see', 'think', 'view', 'opinion',
])

// 只比對小寫與句首大寫形（case-sensitive），讓全大寫縮寫（US、IT、WHO）留在詞組裡。
const EN_STOPWORD_FORMS = [...EN_STOPWORDS].flatMap((word) => [
  word,
  word[0].toUpperCase() + word.slice(1),
])
const EN_STOPWORD_PATTERN = new RegExp(
  `\\b(?:${EN_STOPWORD_FORMS.join('|')})\\b`,
  'g',
)

const HAN_PATTERN = /\p{Script=Han}/u
const LATIN_LETTER_PATTERN = /[A-Za-z]/

/**
 * 快速字元判別（issue #37）：LINE 提問若「只有英文與符號」——含至少一個拉丁字母、
 * 且不含任何漢字——回傳 'en'（可直接當作 generateCagAnswer 的 answerLanguage）；
 * 其餘（含中文，或無拉丁字母的純符號／數字）回傳 undefined，沿用預設繁中作答。
 */
export function detectCagAnswerLanguage(question: string): 'en' | undefined {
  if (HAN_PATTERN.test(question)) return undefined
  return LATIN_LETTER_PATTERN.test(question) ? 'en' : undefined
}

export function buildCagQueryVariants(question: string): string[] {
  const cleaned = stripQuestionDirectives(question)
    .replace(/[?？!！。.,，;；:：()[\]{}「」『』"“”'‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const variants: string[] = []
  pushUnique(variants, cleaned)

  const withoutQuestionWords = cleaned
    .replace(/(如何|怎麼|怎么|為何|爲何|什麼|什么|請問|請|回答|說明|解釋)/g, ' ')
    .replace(EN_STOPWORD_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
  pushUnique(variants, withoutQuestionWords)

  const hanRuns = [...withoutQuestionWords.matchAll(/\p{Script=Han}{2,}/gu)]
    .map((match) => match[0])
  for (const run of hanRuns) {
    if (run.length <= 2) {
      pushUnique(variants, run)
      continue
    }
    pushUnique(variants, run)
    for (let i = 0; i < run.length - 1; i += 2) {
      pushUnique(variants, run.slice(i, i + 2))
    }
    for (let i = 1; i < run.length - 1; i += 2) {
      pushUnique(variants, run.slice(i, i + 2))
    }
  }

  const latinTokens = withoutQuestionWords.match(/[A-Za-z0-9][A-Za-z0-9._-]{1,}/g) ?? []
  for (const token of latinTokens) {
    // 全大寫者視為縮寫（US、IT、WHO），即使拼法撞上 stopword 也保留。
    if (token !== token.toUpperCase() && EN_STOPWORDS.has(token.toLowerCase())) continue
    // 短字略過，但保留含大寫的縮寫（如 AI、G7）。
    if (token.length < 3 && !/[A-Z]/.test(token)) continue
    pushUnique(variants, token)
  }

  return variants.slice(0, MAX_SEARCH_VARIANTS)
}

/** Primary + one fallback query for archive.tw search (replaces 6-way fan-out). */
export function buildCagRetrievalQueries(question: string): {
  primary: string
  fallback: string
} {
  const variants = buildCagQueryVariants(question)
  const cleaned = variants[0] || stripQuestionDirectives(question)
  if (cleaned && !HAN_PATTERN.test(cleaned)) {
    // archive.tw 搜尋是逐字詞組比對：拉丁文字問題若用整句查詢幾乎必空，
    // 先用剝除疑問詞後的內容詞組，再退到最具辨識度（最長）的單一內容詞。
    const primary = variants[1] || cleaned
    const singleTokens = variants.slice(1).filter((variant) => !variant.includes(' '))
    const fallback = [...singleTokens].sort((a, b) => b.length - a.length)[0] || primary
    return { primary, fallback }
  }
  const primary = cleaned
  const fallback = variants[1] || primary
  return { primary, fallback }
}

function mergeArchiveHits(
  baseUrl: string,
  existing: ArchiveSearchResult[],
  seen: Set<string>,
  incoming: ArchiveSearchResult[],
): ArchiveSearchResult[] {
  const hits = [...existing]
  for (const result of incoming) {
    const href = absoluteArchiveHref(baseUrl, result.url)
    if (!href || seen.has(href)) continue
    seen.add(href)
    hits.push(result)
  }
  return hits
}

export function parseArchiveSectionId(href: string): number | null {
  const match = href.match(/#s(\d+)\b/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isInteger(value) ? value : null
}

function absoluteArchiveHref(baseUrl: string, href: string | undefined): string | null {
  if (!href) return null
  try {
    const base = new URL(baseUrl)
    const url = new URL(href, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.origin !== base.origin) return null
    return url.toString()
  } catch {
    return null
  }
}

async function fetchArchiveJson<T>(url: URL): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch (e) {
    console.error('archive fetch failed:', e)
    return null
  }
}

async function searchArchive(
  baseUrl: string,
  query: string,
  limit: number,
): Promise<ArchiveSearchResult[]> {
  const url = new URL('/api/search.json', baseUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  const payload = await fetchArchiveJson<ArchiveSearchResponse>(url)
  return Array.isArray(payload?.results) ? payload.results : []
}

function buildHydratedSectionContent(
  section: ArchiveSectionResponse | null,
  fallbackContent: string,
): string {
  const parts = [
    section?.previous_content,
    section?.section_content,
    section?.next_content,
  ]
    .map((value) => htmlToPlainText(value ?? ''))
    .filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : fallbackContent
}

/** Hydrate a ranked Vectorize hit with archive.tw prev/current/next section text. */
export async function hydrateCagSourceFromArchive(
  baseUrl: string,
  source: CagSource,
): Promise<CagSource | null> {
  if (source.sectionId === null) return source

  const normalizedBase = normalizeArchiveBaseUrl(baseUrl)
  const url = new URL(`/api/section/${source.sectionId}`, normalizedBase)
  const section = await fetchArchiveJson<ArchiveSectionResponse>(url)
  const fallbackContent = htmlToPlainText(source.content)
  const content = buildHydratedSectionContent(section, fallbackContent)
  if (content.trim() === '') return null

  const [labelTitle, labelSpeaker] = source.label.split(' — ')
  const displayName = section?.display_name?.trim() || labelTitle?.trim() || source.href
  const speaker = section?.name?.trim() || labelSpeaker?.trim()
  const label = speaker ? `${displayName} — ${speaker}` : source.label
  return { content, href: source.href, label, sectionId: source.sectionId }
}

export async function hydrateCagSourcesFromArchive(
  baseUrl: string,
  sources: CagSource[],
): Promise<CagSource[]> {
  const hydrated = await Promise.all(
    sources.map((source) => hydrateCagSourceFromArchive(baseUrl, source)),
  )
  return hydrated.filter((source): source is CagSource => source !== null)
}

async function hydrateArchiveSection(
  baseUrl: string,
  hit: ArchiveSearchResult,
): Promise<CagSource | null> {
  const href = absoluteArchiveHref(baseUrl, hit.url)
  if (!href) return null

  const sectionId = parseArchiveSectionId(href)
  if (!sectionId) {
    const snippet = hit.snippet?.trim()
    if (!snippet) return null
    const label = [hit.title, hit.speaker].filter(Boolean).join(' — ') || href
    return { content: snippet, href, label, sectionId: null }
  }

  const url = new URL(`/api/section/${sectionId}`, baseUrl)
  const section = await fetchArchiveJson<ArchiveSectionResponse>(url)
  const content = buildHydratedSectionContent(section, hit.snippet ?? '')
  if (content.trim() === '') return null

  const displayName = section?.display_name?.trim() || hit.title?.trim() || href
  const speaker = section?.name?.trim() || hit.speaker?.trim()
  const label = speaker ? `${displayName} — ${speaker}` : displayName
  return { content, href, label, sectionId }
}

export async function retrieveCagSources(
  question: string,
  options?: { topK?: number; archiveBaseUrl?: string },
): Promise<CagSource[]> {
  const topK = clampInteger(options?.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K)
  const baseUrl = normalizeArchiveBaseUrl(options?.archiveBaseUrl)
  const { primary, fallback } = buildCagRetrievalQueries(question)
  const perQueryLimit = Math.max(topK * 2, 8)
  const seen = new Set<string>()

  let hits = mergeArchiveHits(
    baseUrl,
    [],
    seen,
    await searchArchive(baseUrl, primary, perQueryLimit),
  )
  if (
    hits.length < MIN_ARCHIVE_HITS_BEFORE_FALLBACK
    && fallback
    && fallback !== primary
  ) {
    hits = mergeArchiveHits(
      baseUrl,
      hits,
      seen,
      await searchArchive(baseUrl, fallback, perQueryLimit),
    )
  }

  const hydrated = await Promise.all(
    hits.slice(0, topK * 2).map((hit) => hydrateArchiveSection(baseUrl, hit)),
  )
  return hydrated.filter((source): source is CagSource => source !== null).slice(0, topK)
}

/**
 * 依設定挑選檢索器。retriever='vectorize' 時先查 Vectorize；
 * 無 binding 時優雅回退 archive.tw 檢索；若 Vectorize 已綁定但低於相關度門檻，
 * 則保留空集合，讓上層能誠實回覆「您的問題超出了資料庫的範圍，逐字稿網站連結如下：https://archive.tw'」。
 * 例外：拉丁文字（無漢字）問題查無向量時改走 archive.tw 全文檢索——
 * Vectorize 索引只涵蓋「唐鳳」掛名的繁中段落，對英文問題回空反映的是
 * 索引涵蓋率而非語料範圍，誠實回空反而誤導。
 */
async function resolveCagSources(
  ai: WorkersAiBinding,
  question: string,
  options: {
    topK: number
    archiveBaseUrl?: string
    retriever?: CagRetriever
    vectorize?: VectorizeBinding
    vectorizeMinScore?: number
    cagCache?: KVNamespace
    skipSourceCache?: boolean
  },
): Promise<CagSource[]> {
  const retriever = options.retriever ?? 'archive'
  const hydrateVectorize = retriever === 'vectorize' && Boolean(options.vectorize)
  const cacheKey = options.skipSourceCache
    ? null
    : await buildCagSourceCacheKey({
      question,
      topK: options.topK,
      retriever,
      archiveBaseUrl: options.archiveBaseUrl,
      vectorizeMinScore: options.vectorizeMinScore,
      sourceHydrate: hydrateVectorize ? true : undefined,
    })

  if (cacheKey) {
    const cached = await getCachedCagSources(options.cagCache, cacheKey)
    if (cached) return cached
  }

  let sources: CagSource[]
  if (retriever === 'vectorize' && options.vectorize) {
    const baseUrl = normalizeArchiveBaseUrl(options.archiveBaseUrl)
    const thin = await retrieveCagSourcesFromVectorize(
      ai,
      options.vectorize,
      question,
      { topK: options.topK, minScore: options.vectorizeMinScore },
    )
    if (thin.length > 0) {
      sources = await hydrateCagSourcesFromArchive(baseUrl, thin)
    } else if (!HAN_PATTERN.test(question)) {
      sources = await retrieveCagSources(question, {
        topK: options.topK,
        archiveBaseUrl: options.archiveBaseUrl,
      })
    } else {
      sources = []
    }
  } else {
    sources = await retrieveCagSources(question, {
      topK: options.topK,
      archiveBaseUrl: options.archiveBaseUrl,
    })
  }

  if (cacheKey && sources.length > 0) {
    await putCachedCagSources(options.cagCache, cacheKey, sources)
  }
  return sources
}

export function getCagStatus(options?: {
  archiveBaseUrl?: string
  retriever?: CagRetriever
  vectorizeBound?: boolean
  sourceCacheBound?: boolean
  vectorizeMinScore?: number
}): CagStatus {
  return {
    retriever: options?.retriever ?? 'archive',
    vectorizeBound: options?.vectorizeBound ?? false,
    sourceCacheBound: options?.sourceCacheBound ?? false,
    archiveBaseUrl: normalizeArchiveBaseUrl(options?.archiveBaseUrl),
    model: DEFAULT_CAG_MODEL,
    vectorizeMinScore: options?.vectorizeMinScore ?? DEFAULT_VECTORIZE_MIN_COSINE_SCORE,
    maxTopK: MAX_TOP_K,
    maxContextSectionChars: MAX_CONTEXT_SECTION_CHARS,
    estimatedCostPerRequestUsd: estimateCagRequestCostUsd(DEFAULT_CAG_MODEL),
    typicalTokenProfile: {
      inputTokens: CAG_TYPICAL_INPUT_TOKENS,
      outputTokens: CAG_TYPICAL_OUTPUT_TOKENS,
    },
  }
}

function aiResultToStream(result: unknown): ReadableStream<Uint8Array> {
  if (result instanceof ReadableStream) {
    return result as ReadableStream<Uint8Array>
  }
  if (result instanceof Response && result.body) {
    return result.body
  }

  let text = ''
  if (typeof result === 'string') {
    text = result
  } else if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    text =
      typeof obj.response === 'string'
        ? obj.response
        : typeof obj.result === 'string'
          ? obj.result
          : JSON.stringify(result)
  } else {
    text = String(result ?? '')
  }
  return new Response(text).body!
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

async function stringStreamToText(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += value
  }
  return text
}

function extractAiText(result: unknown): string | null {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return null

  const obj = result as Record<string, unknown>
  if (typeof obj.response === 'string') return obj.response
  if (typeof obj.output_text === 'string') return obj.output_text
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.result === 'string') return obj.result

  const nestedResult = obj.result
  if (nestedResult && typeof nestedResult === 'object') {
    const nested = nestedResult as Record<string, unknown>
    if (typeof nested.response === 'string') return nested.response
    if (typeof nested.output_text === 'string') return nested.output_text
    if (typeof nested.text === 'string') return nested.text
  }

  const choices = obj.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>
    if (typeof choice.text === 'string') return choice.text
    const delta = choice.delta as Record<string, unknown> | undefined
    if (delta && typeof delta.content === 'string') return delta.content
    const message = choice.message as Record<string, unknown> | undefined
    if (message) {
      if (typeof message.content === 'string') return message.content
      if (typeof message.reasoning === 'string') return message.reasoning
    }
  }

  return null
}

export function extractAiResponseText(result: unknown): string {
  const extracted = extractAiText(result)
  if (extracted !== null) return extracted
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return String(result ?? '')
  return JSON.stringify(result)
}

async function aiResultToText(result: unknown): Promise<string> {
  const extracted = extractAiText(result)
  if (extracted !== null) return extracted

  if (result instanceof ReadableStream || result instanceof Response) {
    return stringStreamToText(
      aiResultToStream(result).pipeThrough(workersAiEventStreamToText()),
    )
  }

  return JSON.stringify(result)
}

function extractStreamingText(data: string): string {
  if (data === '[DONE]') return ''
  try {
    const parsed = JSON.parse(data) as unknown
    return extractAiText(parsed) ?? ''
  } catch {
    return data
  }
  return ''
}

function workersAiEventStreamToText(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let sawSse = false

  function processLine(line: string, controller: TransformStreamDefaultController<string>) {
    const trimmed = line.trimEnd()
    if (trimmed === '') return
    if (trimmed.startsWith('data:')) {
      sawSse = true
      const text = extractStreamingText(trimmed.slice('data:'.length).trim())
      if (text) controller.enqueue(text)
      return
    }
    if (/^(event|id|retry):/.test(trimmed)) return
    if (!sawSse) controller.enqueue(`${line}\n`)
  }

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line, controller)
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) {
        if (sawSse) {
          processLine(buffer, controller)
        } else {
          controller.enqueue(buffer)
        }
      }
    },
  })
}

export function markdownCitationFootnotes(footnotes: string[]): TransformStream<string, string> {
  const used = new Set<number>()
  let state: 'text' | 'citation' = 'text'
  let digits = ''

  function emitCitation(controller: TransformStreamDefaultController<string>, raw: string) {
    const index = Number(raw)
    if (Number.isInteger(index) && index >= 1 && index <= footnotes.length) {
      used.add(index)
      controller.enqueue(`[^${index}]`)
    } else {
      controller.enqueue(`[${raw}]`)
    }
  }

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      for (const char of chunk) {
        if (state === 'text') {
          if (char === '[') {
            state = 'citation'
            digits = ''
          } else {
            controller.enqueue(char)
          }
          continue
        }

        if (/\s/.test(char) && digits === '') {
          continue
        }
        if (/\d/.test(char) && digits.length < 9) {
          digits += char
          continue
        }
        if (char === ',' && digits !== '') {
          emitCitation(controller, digits)
          controller.enqueue(', ')
          digits = ''
          continue
        }
        if (char === ']' && digits !== '') {
          emitCitation(controller, digits)
          state = 'text'
          digits = ''
          continue
        }
        controller.enqueue(`[${digits}${char}`)
        state = 'text'
        digits = ''
      }
    },
    flush(controller) {
      if (state === 'citation') {
        controller.enqueue(`[${digits}`)
      }
      const indexes = [...used].sort((a, b) => a - b)
      if (indexes.length > 0) {
        controller.enqueue('\n\n')
        for (const index of indexes) {
          controller.enqueue(`[^${index}]: ${footnotes[index - 1]}\n`)
        }
      }
    },
  })
}

function buildCagAiRunInput(
  messages: ChatMessage[],
  maxCompletionTokens: number | undefined,
  stream: boolean,
): Record<string, unknown> {
  return {
    messages,
    stream,
    max_completion_tokens: clampInteger(
      maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      1,
      4_096,
    ),
    temperature: 0.2,
    reasoning_effort: 'none',
    chat_template_kwargs: { thinking: false, enable_thinking: false },
  }
}

async function runCagCompletion(
  ai: WorkersAiBinding,
  messages: ChatMessage[],
  maxCompletionTokens: number | undefined,
  stream: boolean,
): Promise<unknown> {
  return ai.run(
    DEFAULT_CAG_MODEL,
    buildCagAiRunInput(messages, maxCompletionTokens, stream),
  )
}

export async function completeCagAnswer(
  ai: WorkersAiBinding,
  messages: ChatMessage[],
  options?: {
    maxCompletionTokens?: number
  },
): Promise<string> {
  const result = await runCagCompletion(
    ai,
    messages,
    options?.maxCompletionTokens,
    false,
  )
  return extractAiResponseText(result).trim()
}

/**
 * 將檢索到的來源切成「可引用」與「背景」兩段。
 * citableTopK 未設或 ≥ 來源數時，全部可引用（沿用舊行為、無背景段）。
 */
function splitCitedAndBackground(
  sources: CagSource[],
  citableTopK: number | undefined,
): { cited: CagSource[]; background: CagSource[] } {
  if (citableTopK === undefined) return { cited: sources, background: [] }
  const count = clampInteger(citableTopK, 1, sources.length)
  return { cited: sources.slice(0, count), background: sources.slice(count) }
}

export async function generateCagAnswer(
  ai: WorkersAiBinding,
  question: string,
  options?: CagOptions,
): Promise<CagAnswer | null> {
  const normalized = normalizeCagOptions(options)
  const sources = await resolveCagSources(ai, question, {
    topK: normalized.topK,
    archiveBaseUrl: normalized.archiveBaseUrl,
    retriever: normalized.retriever,
    vectorize: normalized.vectorize,
    vectorizeMinScore: normalized.vectorizeMinScore,
    cagCache: options?.cagCache,
    skipSourceCache: options?.skipSourceCache,
  })
  if (sources.length === 0) return null

  const { cited, background } = splitCitedAndBackground(sources, normalized.citableTopK)
  const messages = buildCagMessages(
    question,
    cited,
    background,
    normalized.answerInstruction,
    normalized.answerLanguage,
  )
  const result = await runCagCompletion(
    ai,
    messages,
    normalized.maxCompletionTokens,
    false,
  )
  const answer = (await aiResultToText(result)).trim()
  // 只回傳可引用來源，呼叫端據此顯示出處、引註編號 [1..K] 一一對應。
  return { answer, sources: cited }
}

export async function streamCagAnswer(
  ai: WorkersAiBinding,
  question: string,
  options?: CagOptions,
): Promise<Response> {
  const normalized = normalizeCagOptions(options)
  const sources = await resolveCagSources(ai, question, {
    topK: normalized.topK,
    archiveBaseUrl: normalized.archiveBaseUrl,
    retriever: normalized.retriever,
    vectorize: normalized.vectorize,
    vectorizeMinScore: normalized.vectorizeMinScore,
    cagCache: options?.cagCache,
    skipSourceCache: options?.skipSourceCache,
  })
  if (sources.length === 0) {
    return new Response(NOT_FOUND_REPLY_HTML, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    })
  }

  const { cited, background } = splitCitedAndBackground(sources, normalized.citableTopK)
  const messages = buildCagMessages(
    question,
    cited,
    background,
    normalized.answerInstruction,
    normalized.answerLanguage,
  )
  const stream = await runCagCompletion(
    ai,
    messages,
    normalized.maxCompletionTokens,
    true,
  )

  const body = aiResultToStream(stream)
    .pipeThrough(workersAiEventStreamToText())
    .pipeThrough(markdownCitationFootnotes(cited.map(footnoteForSource)))
    .pipeThrough(new TextEncoderStream())

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
