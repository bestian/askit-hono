/**
 * Side-by-side retrieval comparison: local CAG memories vs section Vectorize.
 *
 * Memory path is local files only (no Cloudflare writes, no mnemon, no extractor).
 * Vectorize is read-only: Workers AI embed + Vectorize query. No index create,
 * upsert, D1/KV/R2 writes, or vectorize-sync.
 *
 * Report blocks, never blended:
 *   1. In-corpus, whole-archive Vectorize — Vectorize advantage is corpus size
 *   2. Out-of-corpus — the 7 named coverage-gap questions (not a quality result)
 *   3. All 21 whole-archive — confounded by corpus size
 *   4. same-room (HEADLINE) — in-corpus questions, Vectorize post-filtered to
 *      the same room filenames as the memory merge
 *
 * Memory arm is reported in three configurations so the missing-floor
 * confound is isolated (floor is applied here, not in cagMemories.ts):
 *   keyword — recall(--no-llm)
 *   hybrid — recallHybrid as-is (no cosine floor)
 *   hybrid-floor — same hybrid hits, drop items with cosine < 0.45 and no keyword hit
 *
 * Density is measured on assembled prompt claims (htmlToPlainText of each
 * source as buildCagMessages would emit), not raw item strings:
 *   signal density = on-topic assembled chars / total assembled chars
 *   on-topic items in the first 1500 assembled chars
 *   sentences / 1000 assembled chars
 * items/1000c is a length artifact (inverse of chars/hit); not aggregated.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/compare-memories-vs-vectorize.ts \
 *     --store /tmp/cag-memories-july-cap4 \
 *     --store /tmp/cag-memories-ds4-webx3 \
 *     --store /tmp/cag-memories-ds4-commons3
 *
 * Does not value-import src/utils/cag.ts (that pulls @au/cf-ai-gateway).
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { CagSource } from '../src/utils/cag'
import {
  countSentences,
  DEFAULT_AUDREY_EVAL_CASES,
  DEFAULT_CAG_EVAL_CASES,
} from '../src/utils/cagEval'
import {
  embedTexts,
  loadCagStore,
  loadEmbeddingsJsonl,
  memoriesToCagSources,
  mergeCagStores,
  mergeEmbeddings,
  recall,
  recallHybrid,
  type CagMemory,
} from '../src/utils/cagMemories'
import {
  buildQueryEmbeddingInput,
  DEFAULT_VECTORIZE_MIN_COSINE_SCORE,
  EMBEDDING_MODEL,
  extractEmbedding,
  VECTORIZE_INDEX_NAME,
  vectorMetadataToCagSource,
} from '../src/utils/vectorize'

export type RetrievedItem = {
  content: string
  label: string
  href: string
  sectionId: number | null
}

export type Retriever = (question: string, topK: number) => Promise<RetrievedItem[]>

type QuestionCase = {
  id: string
  question: string
  topicTerms: string[]
  block: 'in-corpus' | 'out-of-corpus' | 'other'
}

type Cli = {
  stores: string[]
  questionsPath: string | null
  topK: number
  noLlm: boolean
}

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

type ArmHits = {
  items: RetrievedItem[]
  error: string | null
}

type ArmMetrics = {
  n: number
  precision: number | null
  chars: number
  charsPerResult: number | null
  sentences: number
  onTopicN: number
  onTopicChars: number
  signalDensity: number | null
  onTopicAt1500: number
  sentsPerKChars: number | null
  error: string | null
}

const CONTEXT_BUDGET_CHARS = 1500
/** Query this many Vectorize neighbors so a same-room post-filter can still fill topK. */
const SAME_ROOM_QUERY_TOP_K = 100

const TOPIC_TERMS: Record<string, string[]> = {
  'earth-god-incense': ['地神'],
  'digital-signature': ['數位簽章'],
  'open-source-policy': ['開放原始碼', '開源', '自由軟體'],
  cybersecurity: ['資通安全', '資安'],
  'civic-participation': ['公民參與'],
  'open-data-en': ['open government', '開放政府'],
  misinformation: ['假訊息'],
  'ai-governance': ['AI 治理', 'AI治理'],
  'au-ren-ai-zh': ['仁工智慧'],
  'au-digital-democracy-reframe-zh': ['數位民主'],
  'au-plurality-zh': ['多元宇宙'],
  'au-broad-listening-zh': ['broad listening'],
  'au-rough-consensus-zh': ['審議', '民主審議', 'rough consensus'],
  'au-vtaiwan-zh': ['vTaiwan'],
  'au-join-zh': ['Join.gov.tw', 'join.gov.tw'],
  'au-mask-map-zh': ['口罩'],
  'au-humor-over-rumor-zh': ['幽默', '謠言'],
  'au-alignment-assemblies-zh': ['對齊大會'],
  'au-open-government-zh': ['開放政府', '激進透明'],
  'au-broad-listening-en': ['broad listening'],
  'au-plurality-en': ['Plurality', '多元宇宙'],
}

const NAMED_OUT_OF_CORPUS_IDS = [
  'au-vtaiwan-zh',
  'au-mask-map-zh',
  'au-humor-over-rumor-zh',
  'cybersecurity',
  'civic-participation',
  'misinformation',
  'au-open-government-zh',
] as const

function loadDevVarsFallback(): void {
  let raw = ''
  try {
    raw = readFileSync(path.resolve('.dev.vars'), 'utf-8')
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : null
    if (code === 'ENOENT') return
    throw e
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
    const eq = normalized.indexOf('=')
    if (eq <= 0) continue
    const key = normalized.slice(0, eq).trim()
    let value = normalized.slice(eq + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
    }
  }
}

function wranglerOauthTokenPaths(): string[] {
  const home = os.homedir()
  return [
    path.join(home, 'Library/Preferences/.wrangler/config/default.toml'),
    path.join(home, '.config/.wrangler/config/default.toml'),
    path.join(home, '.wrangler/config/default.toml'),
  ]
}

function loadWranglerOauthToken(): string | null {
  for (const filePath of wranglerOauthTokenPaths()) {
    if (!existsSync(filePath)) continue
    const raw = readFileSync(filePath, 'utf8')
    const match = raw.match(/oauth_token\s*=\s*"([^"]+)"/)
    if (match?.[1]) return match[1]
  }
  return null
}

type CfAuth = {
  accountId: string
  token: string
  mechanism: string
}

function resolveCfAuth(): CfAuth {
  loadDevVarsFallback()
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? ''
  const envToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? ''
  const oauthToken = envToken ? '' : (loadWranglerOauthToken() ?? '')
  const token = envToken || oauthToken
  if (!accountId) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID is missing. Set it or export it before running. No Vectorize results invented.',
    )
  }
  if (!token) {
    throw new Error(
      'No CLOUDFLARE_API_TOKEN and no wrangler OAuth token in default.toml. No Vectorize results invented.',
    )
  }
  return {
    accountId,
    token,
    mechanism: envToken
      ? 'CLOUDFLARE_API_TOKEN env + CLOUDFLARE_ACCOUNT_ID env (Workers AI REST embed, Vectorize v2 query REST)'
      : 'wrangler OAuth token from ~/Library/Preferences/.wrangler/config/default.toml + CLOUDFLARE_ACCOUNT_ID env (Workers AI REST embed, Vectorize v2 query REST). CLOUDFLARE_API_TOKEN was unset.',
  }
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    stores: [],
    questionsPath: null,
    topK: 8,
    noLlm: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--no-llm') cli.noLlm = true
    else if (a === '--store') {
      const dir = argv[++i]
      if (dir) cli.stores.push(path.resolve(dir))
    }
    else if (a === '--questions') {
      const p = argv[++i]
      if (p) cli.questionsPath = path.resolve(p)
    }
    else if (a === '--top-k') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 1) throw new Error('--top-k must be a positive number')
      cli.topK = Math.floor(n)
    }
  }
  if (cli.stores.length === 0) cli.stores.push(path.resolve('local/cag-memories'))
  return cli
}

function containsTerm(haystack: string, term: string): boolean {
  if (/[A-Za-z]/.test(term)) return haystack.toLowerCase().includes(term.toLowerCase())
  return haystack.includes(term)
}

function assembledClaim(item: RetrievedItem): string {
  return htmlToPlainText(item.content)
}

function itemHasTopicTerm(item: RetrievedItem, terms: string[]): boolean {
  const hay = assembledClaim(item)
  return terms.some((term) => containsTerm(hay, term))
}

function countTermHits(texts: string[], term: string): number {
  return texts.filter((text) => containsTerm(text, term)).length
}

function corpusTexts(store: ReturnType<typeof mergeCagStores>): string[] {
  return store.memories.map((mem) => {
    const quotes = mem.evidence.map((e) => e.quote).join(' ')
    const extras = [...mem.entities, ...mem.tags].join(' ')
    return `${mem.content} ${quotes} ${extras}`
  })
}

function roomFilenamesFromStore(store: ReturnType<typeof mergeCagStores>): Set<string> {
  return new Set(store.memories.map((m) => m.roomId.replace(/\.md$/i, '')))
}

function classifyCase(
  id: string,
  question: string,
  storeTexts: string[],
): QuestionCase {
  const topicTerms = TOPIC_TERMS[id] ?? []
  const present = topicTerms.some((term) => countTermHits(storeTexts, term) > 0)
  const namedOut = (NAMED_OUT_OF_CORPUS_IDS as readonly string[]).includes(id)
  let block: QuestionCase['block']
  if (namedOut) block = 'out-of-corpus'
  else if (present) block = 'in-corpus'
  else block = 'other'
  return { id, question, topicTerms, block }
}

function loadQuestions(questionsPath: string | null, storeTexts: string[]): QuestionCase[] {
  if (!questionsPath) {
    return [...DEFAULT_CAG_EVAL_CASES, ...DEFAULT_AUDREY_EVAL_CASES].map((c) =>
      classifyCase(c.id, c.question, storeTexts),
    )
  }
  if (!existsSync(questionsPath)) {
    throw new Error(`Questions file not found: ${questionsPath}`)
  }
  const raw = readFileSync(questionsPath, 'utf8').trim()
  if (!raw) throw new Error(`Questions file is empty: ${questionsPath}`)

  let parsed: unknown
  if (raw.startsWith('[')) {
    parsed = JSON.parse(raw)
  } else {
    parsed = raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Questions file must be a JSON array or JSONL: ${questionsPath}`)
  }

  const cases: QuestionCase[] = []
  for (const [index, rec] of parsed.entries()) {
    if (typeof rec === 'string') {
      cases.push(classifyCase(`q${index + 1}`, rec, storeTexts))
      continue
    }
    if (!rec || typeof rec !== 'object') {
      throw new Error(`Invalid question record at index ${index}`)
    }
    const row = rec as { id?: unknown; question?: unknown }
    if (typeof row.question !== 'string' || !row.question.trim()) {
      throw new Error(`Question record at index ${index} needs a string "question" field`)
    }
    const id = typeof row.id === 'string' && row.id.trim() ? row.id : `q${index + 1}`
    cases.push(classifyCase(id, row.question, storeTexts))
  }
  if (cases.length === 0) throw new Error('No questions loaded.')
  return cases
}

function htmlToPlainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
}

function sourceBlock(
  source: CagSource,
  options: { id?: number; tag: 'source' | 'background_source' },
): string {
  const content = htmlToPlainText(source.content)
  const attrs = options.id === undefined ? '' : ` id="${options.id}"`
  return [
    `<${options.tag}${attrs}>`,
    '```text',
    content,
    '```',
    `</${options.tag}>`,
  ].join('\n')
}

/** Local copy of src/utils/cag.ts:215-270 — no value import from cag.ts. */
function buildCagMessages(
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

function memoriesToItems(memories: CagMemory[]): RetrievedItem[] {
  const titleByRoom: Record<string, string> = {}
  for (const mem of memories) {
    titleByRoom[mem.roomId] ??= mem.roomId.replace(/\.md$/, '')
  }
  const { cited, background } = memoriesToCagSources(memories, titleByRoom)
  return [...cited, ...background]
}

function cosineDot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}

type MemoryArmSet = {
  keyword: RetrievedItem[]
  hybrid: RetrievedItem[]
  hybridFloor: RetrievedItem[]
  floorDropped: number
}

async function retrieveMemoryArms(
  question: string,
  topK: number,
  store: ReturnType<typeof mergeCagStores>,
  embeddings: Map<string, number[]>,
): Promise<MemoryArmSet> {
  const later = /後來|之后|之後|later/i.test(question)
  const keywordHit = recall(question, store, { noLlm: true, later, limit: topK })
  const keywordAll = recall(question, store, {
    noLlm: true,
    later,
    limit: Math.max(topK, store.memories.length),
  })
  const keywordIds = new Set(keywordAll.memories.map((m) => m.id))
  const hybridHit = await recallHybrid(question, store, embeddings, {
    noLlm: false,
    later,
    limit: topK,
  })
  const qv = await embedTexts([question])
  const qvec = qv?.[0] ?? null
  const floored = hybridHit.memories.filter((mem) => {
    if (keywordIds.has(mem.id)) return true
    if (!qvec) return false
    const ev = embeddings.get(mem.id)
    if (!ev) return false
    return cosineDot(qvec, ev) >= DEFAULT_VECTORIZE_MIN_COSINE_SCORE
  })
  return {
    keyword: memoriesToItems(keywordHit.memories),
    hybrid: memoriesToItems(hybridHit.memories),
    hybridFloor: memoriesToItems(floored),
    floorDropped: hybridHit.memories.length - floored.length,
  }
}

async function embedQueryVector(auth: CfAuth, question: string): Promise<number[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/ai/run/${EMBEDDING_MODEL}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [buildQueryEmbeddingInput(question)] }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`Workers AI embed HTTP ${res.status}: ${bodyText.slice(0, 400)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    throw new Error(`Workers AI embed returned non-JSON: ${bodyText.slice(0, 400)}`)
  }
  const envelope = json as { success?: boolean; errors?: unknown }
  if (envelope.success === false) {
    throw new Error(`Workers AI embed API error: ${JSON.stringify(envelope.errors)}`)
  }
  const embedding = extractEmbedding(json)
  if (!embedding || embedding.length === 0) {
    throw new Error('Workers AI embed returned no vector')
  }
  return embedding
}

async function queryVectorizeIndex(
  auth: CfAuth,
  vector: number[],
  topK: number,
): Promise<{ id: string; score: number; metadata?: Record<string, unknown> | null }[]> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}` +
    `/vectorize/v2/indexes/${VECTORIZE_INDEX_NAME}/query`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vector,
      topK,
      returnMetadata: 'all',
    }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`Vectorize query HTTP ${res.status}: ${bodyText.slice(0, 400)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    throw new Error(`Vectorize query returned non-JSON: ${bodyText.slice(0, 400)}`)
  }
  const envelope = json as {
    success?: boolean
    errors?: unknown
    result?: { matches?: unknown }
    matches?: unknown
  }
  if (envelope.success === false) {
    throw new Error(`Vectorize query API error: ${JSON.stringify(envelope.errors)}`)
  }
  const rawMatches = Array.isArray(envelope.result?.matches)
    ? envelope.result.matches
    : Array.isArray(envelope.matches)
      ? envelope.matches
      : null
  if (!rawMatches) {
    throw new Error(`Vectorize query missing matches: ${bodyText.slice(0, 400)}`)
  }
  const matches: { id: string; score: number; metadata?: Record<string, unknown> | null }[] = []
  for (const row of rawMatches) {
    if (!row || typeof row !== 'object') continue
    const rec = row as { id?: unknown; score?: unknown; metadata?: unknown }
    if (typeof rec.id !== 'string') continue
    if (typeof rec.score !== 'number' || !Number.isFinite(rec.score)) continue
    const metadata =
      rec.metadata && typeof rec.metadata === 'object'
        ? rec.metadata as Record<string, unknown>
        : null
    matches.push({ id: rec.id, score: rec.score, metadata })
  }
  return matches
}

function matchFilename(
  match: { metadata?: Record<string, unknown> | null },
): string | null {
  const filename = match.metadata && typeof match.metadata.filename === 'string'
    ? match.metadata.filename
    : null
  return filename && filename.trim() !== '' ? filename : null
}

function matchesToSources(
  matches: { id: string; score: number; metadata?: Record<string, unknown> | null }[],
  topK: number,
  roomFilenames: Set<string> | null,
): RetrievedItem[] {
  const seen = new Set<number>()
  const sources: RetrievedItem[] = []
  for (const match of matches) {
    if (match.score < DEFAULT_VECTORIZE_MIN_COSINE_SCORE) continue
    if (roomFilenames) {
      const filename = matchFilename(match)
      if (!filename || !roomFilenames.has(filename)) continue
    }
    const source = vectorMetadataToCagSource(match.metadata)
    if (!source || source.sectionId === null) continue
    if (seen.has(source.sectionId)) continue
    seen.add(source.sectionId)
    sources.push(source)
    if (sources.length >= topK) break
  }
  return sources
}

function sameRoomOverlap(
  matches: { score: number; metadata?: Record<string, unknown> | null }[],
  roomFilenames: Set<string>,
): { inRoom: number; aboveFloor: number; sample: string[] } {
  let inRoom = 0
  let aboveFloor = 0
  const sample: string[] = []
  for (const match of matches) {
    if (match.score < DEFAULT_VECTORIZE_MIN_COSINE_SCORE) continue
    aboveFloor += 1
    const filename = matchFilename(match)
    if (filename && roomFilenames.has(filename)) inRoom += 1
    if (filename && sample.length < 8 && !sample.includes(filename)) sample.push(filename)
  }
  return { inRoom, aboveFloor, sample }
}

function createVectorizePair(
  auth: CfAuth,
  roomFilenames: Set<string>,
): (question: string, topK: number) => Promise<{
  archive: RetrievedItem[]
  sameRoom: RetrievedItem[]
  overlap: { inRoom: number; aboveFloor: number; sample: string[] }
}> {
  return async (question, topK) => {
    const trimmed = question.trim()
    if (trimmed === '') {
      return { archive: [], sameRoom: [], overlap: { inRoom: 0, aboveFloor: 0, sample: [] } }
    }
    const embedding = await embedQueryVector(auth, trimmed)
    const matches = await queryVectorizeIndex(auth, embedding, SAME_ROOM_QUERY_TOP_K)
    return {
      archive: matchesToSources(matches, topK, null),
      sameRoom: matchesToSources(matches, topK, roomFilenames),
      overlap: sameRoomOverlap(matches, roomFilenames),
    }
  }
}

function preview(text: string, maxChars = 100): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, maxChars)}…`
}

function emptyMetrics(error: string | null): ArmMetrics {
  return {
    n: 0,
    precision: null,
    chars: 0,
    charsPerResult: null,
    sentences: 0,
    onTopicN: 0,
    onTopicChars: 0,
    signalDensity: null,
    onTopicAt1500: 0,
    sentsPerKChars: null,
    error,
  }
}

function metricsFor(arm: ArmHits, terms: string[]): ArmMetrics {
  if (arm.error) return emptyMetrics(arm.error)
  const n = arm.items.length
  const relevant = arm.items.filter((item) => itemHasTopicTerm(item, terms)).length
  const claims = arm.items.map((item) => assembledClaim(item))
  const chars = claims.reduce((sum, text) => sum + text.length, 0)
  const topicChars = arm.items
    .filter((item) => itemHasTopicTerm(item, terms))
    .reduce((sum, item) => sum + assembledClaim(item).length, 0)
  const sentences = claims.reduce((sum, text) => sum + countSentences(text), 0)
  let used = 0
  let onTopicAt1500 = 0
  for (const item of arm.items) {
    if (used >= CONTEXT_BUDGET_CHARS) break
    used += assembledClaim(item).length
    if (itemHasTopicTerm(item, terms)) onTopicAt1500 += 1
  }
  return {
    n,
    precision: n === 0 ? null : relevant / n,
    chars,
    charsPerResult: n === 0 ? null : chars / n,
    sentences,
    onTopicN: relevant,
    onTopicChars: topicChars,
    signalDensity: chars === 0 ? null : topicChars / chars,
    onTopicAt1500,
    sentsPerKChars: chars === 0 ? null : (sentences / chars) * 1000,
    error: null,
  }
}

function fmtPrec(value: number | null): string {
  if (value === null) return 'n/a'
  return value.toFixed(3)
}

function fmtNum(value: number | null, digits = 1): string {
  if (value === null) return 'n/a'
  return value.toFixed(digits)
}

function printArm(name: string, arm: ArmHits, metrics: ArmMetrics, terms: string[]) {
  if (arm.error) {
    console.log(`  ${name}: ERROR — ${arm.error}`)
    return
  }
  console.log(
    `  ${name}: n=${metrics.n}  prec=${fmtPrec(metrics.precision)}  ` +
    `on-topic=${metrics.onTopicN}  assembled-chars=${metrics.chars}  ` +
    `signal=${fmtPrec(metrics.signalDensity)}  ` +
    `on-topic@${CONTEXT_BUDGET_CHARS}=${metrics.onTopicAt1500}  ` +
    `sents/1000c=${fmtNum(metrics.sentsPerKChars, 2)}  ` +
    `chars/hit=${fmtNum(metrics.charsPerResult)}`,
  )
  for (const [i, item] of arm.items.entries()) {
    const sid = item.sectionId === null ? 'null' : String(item.sectionId)
    const ok = itemHasTopicTerm(item, terms)
    console.log(`    [${i + 1}] ${item.label}  sectionId=${sid}  topic-term=${ok ? 'yes' : 'no'}`)
    console.log(`        ${item.href}`)
    console.log(`        ${preview(assembledClaim(item))}`)
  }
}

type Row = {
  testCase: QuestionCase
  keyword: ArmMetrics
  hybrid: ArmMetrics
  hybridFloor: ArmMetrics
  vectorize: ArmMetrics
  vectorizeSameRoom: ArmMetrics
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function cell(m: ArmMetrics, key: keyof ArmMetrics, kind: 'int' | 'prec' | 'num' = 'int'): string {
  if (m.error) return 'ERR'
  const value = m[key]
  if (value === null || value === undefined) return 'n/a'
  if (kind === 'prec' && typeof value === 'number') return fmtPrec(value)
  if (kind === 'num' && typeof value === 'number') return fmtNum(value)
  return String(value)
}

function printArmMeans(label: string, rows: Row[], pick: (r: Row) => ArmMetrics) {
  const ready = rows.filter((r) => !pick(r).error)
  const precHits = mean(ready.map((r) => pick(r).precision).filter((x): x is number => x !== null))
  const precZero = mean(ready.map((r) => pick(r).precision ?? 0))
  const signalHits = mean(ready.map((r) => pick(r).signalDensity).filter((x): x is number => x !== null))
  const signalZero = mean(ready.map((r) => pick(r).signalDensity ?? 0))
  const budget = mean(ready.map((r) => pick(r).onTopicAt1500))
  const sents = mean(ready.map((r) => pick(r).sentsPerKChars).filter((x): x is number => x !== null))
  const charsHit = mean(ready.map((r) => pick(r).charsPerResult).filter((x): x is number => x !== null))
  const emptyN = ready.filter((r) => pick(r).n === 0).length
  console.log(
    `  ${label}: empty=${emptyN}/${ready.length}  ` +
    `prec(hits)=${fmtPrec(precHits)}  prec(empty=0)=${fmtPrec(precZero)}  ` +
    `signal(hits)=${fmtPrec(signalHits)}  signal(empty=0)=${fmtPrec(signalZero)}  ` +
    `on-topic@${CONTEXT_BUDGET_CHARS}=${fmtNum(budget, 2)}  ` +
    `sents/1000c=${fmtNum(sents, 2)}  ` +
    `chars/hit=${fmtNum(charsHit)}`,
  )
}

function printBlock(
  title: string,
  note: string,
  rows: Row[],
  vectorizePick: (r: Row) => ArmMetrics,
  vectorizeLabel: string,
) {
  console.log(`\n${title}`)
  console.log('='.repeat(title.length))
  console.log(note)
  if (rows.length === 0) {
    console.log('(no questions in this block)')
    return
  }
  console.log(
    'id\tkw_n\tkw_prec\tkw_sig\tkw@1500\tkw_s/k\t' +
    'hy_n\thy_prec\thy_sig\thy@1500\thy_s/k\t' +
    'fl_n\tfl_prec\tfl_sig\tfl@1500\tfl_s/k\t' +
    'vec_n\tvec_prec\tvec_sig\tvec@1500\tvec_s/k',
  )
  for (const row of rows) {
    const k = row.keyword
    const h = row.hybrid
    const f = row.hybridFloor
    const v = vectorizePick(row)
    console.log(
      [
        row.testCase.id,
        cell(k, 'n'), cell(k, 'precision', 'prec'), cell(k, 'signalDensity', 'prec'), cell(k, 'onTopicAt1500'), cell(k, 'sentsPerKChars', 'num'),
        cell(h, 'n'), cell(h, 'precision', 'prec'), cell(h, 'signalDensity', 'prec'), cell(h, 'onTopicAt1500'), cell(h, 'sentsPerKChars', 'num'),
        cell(f, 'n'), cell(f, 'precision', 'prec'), cell(f, 'signalDensity', 'prec'), cell(f, 'onTopicAt1500'), cell(f, 'sentsPerKChars', 'num'),
        cell(v, 'n'), cell(v, 'precision', 'prec'), cell(v, 'signalDensity', 'prec'), cell(v, 'onTopicAt1500'), cell(v, 'sentsPerKChars', 'num'),
      ].join('\t'),
    )
  }

  console.log(`n_questions=${rows.length}  (n=7 precision gaps of a few hundredths are noise; do not declare a winner on precision)`)
  printArmMeans('keyword', rows, (r) => r.keyword)
  printArmMeans('hybrid (no floor)', rows, (r) => r.hybrid)
  printArmMeans('hybrid-floor (memory)', rows, (r) => r.hybridFloor)
  printArmMeans(vectorizeLabel, rows, vectorizePick)
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))

  const store = mergeCagStores(cli.stores.map((dir) => loadCagStore(dir)))
  const embeddings = mergeEmbeddings(cli.stores.map((dir) => loadEmbeddingsJsonl(dir)))
  const storeTexts = corpusTexts(store)
  const questions = loadQuestions(cli.questionsPath, storeTexts)
  const roomFilenames = roomFilenamesFromStore(store)

  console.log(`--store ${cli.stores.join(' --store ')}`)
  console.log(`questions: ${questions.length}  topK=${cli.topK}`)
  console.log(`memory store: ${store.memories.length} memories, ${store.links.length} links, ${embeddings.size} embeddings`)
  console.log(`Vectorize index: ${VECTORIZE_INDEX_NAME}  embed=${EMBEDDING_MODEL}`)
  console.log(`query prefix: buildQueryEmbeddingInput  minCosine=${DEFAULT_VECTORIZE_MIN_COSINE_SCORE}`)
  console.log(`same-room Vectorize: query topK=${SAME_ROOM_QUERY_TOP_K}, keep up to ${cli.topK} whose metadata.filename is in the memory room set`)
  console.log('memory configs: keyword | hybrid (no floor) | hybrid-floor (cosine 0.45 unless keyword hit)')
  console.log('These /tmp stores predate resolve-section-ids.ts — memory hits are expected to show sectionId=null and file:// hrefs. Retrieval quality only; citability is not exercised.')
  if (cli.noLlm) {
    console.log('note: --no-llm is ignored for reporting; all three memory configs always run.')
  }

  console.log(`\nMemory rooms (${roomFilenames.size}) — Vectorize same-room filter uses these filenames:`)
  for (const name of [...roomFilenames].sort()) {
    console.log(`  ${name}`)
  }

  console.log('\nCorpus term counts (this merge; memories + quotes + entities + tags)')
  const seenTerms = new Set<string>()
  for (const testCase of questions) {
    for (const term of testCase.topicTerms) {
      if (seenTerms.has(term)) continue
      seenTerms.add(term)
      console.log(`  ${countTermHits(storeTexts, term)}\t${term}`)
    }
  }

  let vectorizePair: (question: string, topK: number) => Promise<{
    archive: RetrievedItem[]
    sameRoom: RetrievedItem[]
    overlap: { inRoom: number; aboveFloor: number; sample: string[] }
  }>
  try {
    const auth = resolveCfAuth()
    console.log(`\nVectorize credentials: ${auth.mechanism}`)
    console.log(`account id present: yes (len=${auth.accountId.length})  token present: yes (len=${auth.token.length})`)
    vectorizePair = createVectorizePair(auth, roomFilenames)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`\nVectorize credentials: FAILED — ${message}`)
    vectorizePair = async () => {
      throw new Error(message)
    }
  }

  const rows: Row[] = []

  for (const testCase of questions) {
    const mark =
      testCase.block === 'in-corpus'
        ? ' [in-corpus]'
        : testCase.block === 'out-of-corpus'
          ? ' [out-of-corpus / named 7]'
          : ' [other — not in named 7; topic absent from 96-memory merge]'
    console.log(`\n${testCase.id}${mark}`)
    console.log(`  Q: ${testCase.question}`)
    console.log(`  topic terms: ${testCase.topicTerms.join(' · ') || '(none)'}`)

    let keyword: ArmHits
    let hybrid: ArmHits
    let hybridFloor: ArmHits
    try {
      const arms = await retrieveMemoryArms(testCase.question, cli.topK, store, embeddings)
      keyword = { items: arms.keyword, error: null }
      hybrid = { items: arms.hybrid, error: null }
      hybridFloor = { items: arms.hybridFloor, error: null }
      console.log(`  hybrid-floor dropped ${arms.floorDropped} hybrid hit(s) below cosine ${DEFAULT_VECTORIZE_MIN_COSINE_SCORE} with no keyword hit`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      keyword = { items: [], error: message }
      hybrid = { items: [], error: message }
      hybridFloor = { items: [], error: message }
    }

    const keywordMetrics = metricsFor(keyword, testCase.topicTerms)
    const hybridMetrics = metricsFor(hybrid, testCase.topicTerms)
    const floorMetrics = metricsFor(hybridFloor, testCase.topicTerms)
    printArm('keyword', keyword, keywordMetrics, testCase.topicTerms)
    printArm('hybrid', hybrid, hybridMetrics, testCase.topicTerms)
    printArm('hybrid-floor', hybridFloor, floorMetrics, testCase.topicTerms)

    if (!hybridFloor.error) {
      const messages = buildCagMessages(testCase.question, hybridFloor.items)
      const chars = messages.reduce((n, m) => n + m.content.length, 0)
      console.log(`  hybrid-floor buildCagMessages full-prompt chars: ${chars} (density uses assembled source claims only)`)
    }

    let vectorize: ArmHits
    let vectorizeSame: ArmHits
    try {
      const pair = await vectorizePair(testCase.question, cli.topK)
      vectorize = { items: pair.archive, error: null }
      vectorizeSame = { items: pair.sameRoom, error: null }
      console.log(
        `  same-room overlap: ${pair.overlap.inRoom}/${pair.overlap.aboveFloor} neighbors ≥${DEFAULT_VECTORIZE_MIN_COSINE_SCORE} ` +
        `are in the ${roomFilenames.size}-room set (queried topK=${SAME_ROOM_QUERY_TOP_K})`,
      )
      console.log(`  neighbor filename sample: ${pair.overlap.sample.join(' · ') || '(none)'}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      vectorize = { items: [], error: message }
      vectorizeSame = { items: [], error: message }
    }
    const vectorizeMetrics = metricsFor(vectorize, testCase.topicTerms)
    const sameRoomMetrics = metricsFor(vectorizeSame, testCase.topicTerms)
    printArm('vectorize-archive', vectorize, vectorizeMetrics, testCase.topicTerms)
    printArm('vectorize-same-room', vectorizeSame, sameRoomMetrics, testCase.topicTerms)

    rows.push({
      testCase,
      keyword: keywordMetrics,
      hybrid: hybridMetrics,
      hybridFloor: floorMetrics,
      vectorize: vectorizeMetrics,
      vectorizeSameRoom: sameRoomMetrics,
    })
  }

  const inCorpus = rows.filter((r) => r.testCase.block === 'in-corpus')
  const outCorpus = rows.filter((r) => r.testCase.block === 'out-of-corpus')
  const other = rows.filter((r) => r.testCase.block === 'other')

  printBlock(
    '1. In-corpus, whole-archive Vectorize — Vectorize advantage is corpus size',
    'Topic terms exist in the 96-memory merge, but Vectorize still searches 9191 archive sections. Not a like-for-like method comparison.',
    inCorpus,
    (r) => r.vectorize,
    'vectorize-archive (whole index)',
  )
  printBlock(
    '2. Out-of-corpus subset — coverage of the 8-room slice, NOT quality',
    'The 7 questions whose topics are absent (vTaiwan, 口罩, 幽默/謠言, 資通安全, 公民參與, 假訊息, 開放政府/激進透明). ' +
    'Empty memory results are correct behaviour. Do not score this as a retrieval-quality loss.',
    outCorpus,
    (r) => r.vectorize,
    'vectorize-archive (whole index)',
  )
  if (other.length > 0) {
    printBlock(
      '2b. Other absent-topic questions (not in the named 7)',
      'Also zero in this 96-memory merge. Reported separately so they are not blended into the headline or the named-7 coverage statement.',
      other,
      (r) => r.vectorize,
      'vectorize-archive (whole index)',
    )
  }
  printBlock(
    '3. All 21, whole-archive Vectorize — confounded by corpus size',
    'Vectorize indexes the whole archive; memories are the room merge. Completeness only.',
    rows,
    (r) => r.vectorize,
    'vectorize-archive (whole index)',
  )
  printBlock(
    '4. same-room (HEADLINE) — same corpus, same questions, two retrieval methods',
    'In-corpus questions only. Vectorize post-filtered to metadata.filename ∈ memory roomId minus .md. ' +
    `Queried topK=${SAME_ROOM_QUERY_TOP_K} then kept up to 8 in-room hits above cosine ${DEFAULT_VECTORIZE_MIN_COSINE_SCORE}. ` +
    'n=7: a few hundredths of precision is noise; report the split, do not declare a precision winner. ' +
    'If same-room Vectorize is empty, that means none of the top-100 archive neighbors are in these rooms — a ranking miss, not a filter bug, when overlap logging shows 0 in-room neighbors.',
    inCorpus,
    (r) => r.vectorizeSameRoom,
    'vectorize-same-room',
  )

  const vecErrors = rows.filter((r) => r.vectorize.error).length
  const sameErrors = rows.filter((r) => r.vectorizeSameRoom.error).length
  if (vecErrors > 0 || sameErrors > 0) {
    console.log(`\nvectorize errors: archive ${vecErrors}/${rows.length}  same-room ${sameErrors}/${rows.length} (no invented counts)`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
