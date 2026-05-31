import {
  htmlToPlainText,
} from './search'

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

export type CagOptions = {
  model?: string
  topK?: number
  maxCompletionTokens?: number
  archiveBaseUrl?: string
  answerInstruction?: string
}

export const DEFAULT_CAG_MODEL = '@cf/moonshotai/kimi-k2.6'
export const DEFAULT_ARCHIVE_BASE_URL = 'https://archive.tw'
const DEFAULT_TOP_K = 6
const MAX_TOP_K = 12
const DEFAULT_MAX_COMPLETION_TOKENS = 900
const MAX_CONTEXT_SECTION_CHARS = 2_200
const MAX_SEARCH_VARIANTS = 6

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
  retriever: 'archive-search'
  archiveBaseUrl: string
  model: string
  maxTopK: number
  maxContextSectionChars: number
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function truncateContextText(value: string): string {
  if (value.length <= MAX_CONTEXT_SECTION_CHARS) return value
  return `${value.slice(0, MAX_CONTEXT_SECTION_CHARS).trimEnd()}\n[... excerpt trimmed ...]`
}

function footnoteForSource(source: CagSource): string {
  return `[${source.label}](${source.href})`
}

function buildCagMessages(
  question: string,
  sources: CagSource[],
  answerInstruction = 'Answer concisely. Prefer exact wording from the excerpts where useful.',
): ChatMessage[] {
  const lore = sources
    .map((source, index) => {
      const n = index + 1
      const content = truncateContextText(htmlToPlainText(source.content))
      return [
        `[${n}] ${source.label}`,
        `url: ${source.href}`,
        '```text',
        content,
        '```',
      ].join('\n')
    })
    .join('\n\n')

  return [
    {
      role: 'system',
      content: [
        'You answer questions using only the cited SayIt transcript excerpts supplied by the user.',
        'Do not invent details outside the excerpts.',
        'When stating a concrete fact, cite the source number as [1], [2], etc.',
        'If the excerpts do not support an answer, say so clearly.',
        'Cite the section that directly supports each claim.',
        'Use Traditional Chinese when the user asks in Chinese or includes #zh-tw.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        '<lore>',
        lore,
        '</lore>',
        '',
        `Question: ${question}`,
        '',
        answerInstruction,
      ].join('\n'),
    },
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

export function buildCagQueryVariants(question: string): string[] {
  const cleaned = stripQuestionDirectives(question)
    .replace(/[?？!！。.,，;；:：()[\]{}「」『』"“”'‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const variants: string[] = []
  pushUnique(variants, cleaned)

  const withoutQuestionWords = cleaned
    .replace(/(如何|怎麼|怎么|為何|爲何|什麼|什么|請問|請|回答|說明|解釋)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  for (const token of latinTokens) pushUnique(variants, token)

  return variants.slice(0, MAX_SEARCH_VARIANTS)
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
    return new URL(href, baseUrl).toString()
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
  const parts = [
    section?.previous_content,
    section?.section_content,
    section?.next_content,
  ]
    .map((value) => htmlToPlainText(value ?? ''))
    .filter(Boolean)
  const content = parts.length > 0 ? parts.join('\n\n') : (hit.snippet ?? '')
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
  const variants = buildCagQueryVariants(question)
  const perQueryLimit = Math.max(topK * 2, 8)

  const searchResults = await Promise.all(
    variants.map((variant) => searchArchive(baseUrl, variant, perQueryLimit)),
  )
  const seen = new Set<string>()
  const hits: ArchiveSearchResult[] = []
  for (const result of searchResults.flat()) {
    const href = absoluteArchiveHref(baseUrl, result.url)
    if (!href || seen.has(href)) continue
    seen.add(href)
    hits.push(result)
  }

  const hydrated = await Promise.all(
    hits.slice(0, Math.max(topK * 3, 12)).map((hit) => hydrateArchiveSection(baseUrl, hit)),
  )
  return hydrated.filter((source): source is CagSource => source !== null).slice(0, topK)
}

export function getCagStatus(options?: {
  archiveBaseUrl?: string
  model?: string
}): CagStatus {
  return {
    retriever: 'archive-search',
    archiveBaseUrl: normalizeArchiveBaseUrl(options?.archiveBaseUrl),
    model: options?.model || DEFAULT_CAG_MODEL,
    maxTopK: MAX_TOP_K,
    maxContextSectionChars: MAX_CONTEXT_SECTION_CHARS,
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
    if (message && typeof message.content === 'string') return message.content
  }

  return null
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

        if (/\d/.test(char) && digits.length < 9) {
          digits += char
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

async function runCagCompletion(
  ai: WorkersAiBinding,
  model: string,
  messages: ChatMessage[],
  maxCompletionTokens: number | undefined,
  stream: boolean,
): Promise<unknown> {
  return ai.run(model, {
    messages,
    stream,
    max_completion_tokens: clampInteger(
      maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      1,
      4_096,
    ),
    temperature: 0.2,
    chat_template_kwargs: { thinking: false },
  })
}

export async function generateCagAnswer(
  ai: WorkersAiBinding,
  question: string,
  options?: CagOptions,
): Promise<CagAnswer | null> {
  const topK = clampInteger(options?.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K)
  const sources = await retrieveCagSources(question, {
    topK,
    archiveBaseUrl: options?.archiveBaseUrl,
  })
  if (sources.length === 0) return null

  const model = options?.model || DEFAULT_CAG_MODEL
  const messages = buildCagMessages(
    question,
    sources,
    options?.answerInstruction,
  )
  const result = await runCagCompletion(
    ai,
    model,
    messages,
    options?.maxCompletionTokens,
    false,
  )
  const answer = (await aiResultToText(result)).trim()
  return { answer, sources }
}

export async function streamCagAnswer(
  ai: WorkersAiBinding,
  question: string,
  options?: CagOptions,
): Promise<Response> {
  const topK = clampInteger(options?.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K)
  const sources = await retrieveCagSources(question, {
    topK,
    archiveBaseUrl: options?.archiveBaseUrl,
  })
  if (sources.length === 0) {
    return new Response('找不到符合條件的逐字稿段落', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    })
  }

  const model = options?.model || DEFAULT_CAG_MODEL
  const messages = buildCagMessages(
    question,
    sources,
    options?.answerInstruction,
  )
  const stream = await runCagCompletion(
    ai,
    model,
    messages,
    options?.maxCompletionTokens,
    true,
  )

  const body = aiResultToStream(stream)
    .pipeThrough(workersAiEventStreamToText())
    .pipeThrough(markdownCitationFootnotes(sources.map(footnoteForSource)))
    .pipeThrough(new TextEncoderStream())

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
