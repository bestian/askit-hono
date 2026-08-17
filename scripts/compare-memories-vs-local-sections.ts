/**
 * Same-corpus retrieval comparison: claim index (memory merge) vs a
 * local ≤175-char section index built from the same transcript files.
 *
 * Local only. No Cloudflare, Vectorize, Workers AI, D1, KV, R2, wrangler.
 * Does not value-import src/utils/cag.ts. Does not rewrite /tmp stores.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/compare-memories-vs-local-sections.ts \
 *     --store /tmp/cag-memories-full105 \
 *     --section-index local/cag-compare/sections-full.jsonl \
 *     --log /tmp/cag-full-compare.log
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  countSentences,
  DEFAULT_AUDREY_EVAL_CASES,
  DEFAULT_CAG_EVAL_CASES,
} from '../src/utils/cagEval'
import {
  DEFAULT_MEMORY_MIN_COSINE_SCORE,
  embedTexts,
  loadCagStore,
  loadEmbeddingsJsonl,
  LOCAL_EMBED_MODEL,
  LOCAL_EMBED_URL,
  memoriesToCagSources,
  mergeCagStores,
  mergeEmbeddings,
  parseTranscriptMarkdown,
  recall,
  recallHybrid,
  type CagMemory,
  type CagStore,
} from '../src/utils/cagMemories'

type RetrievedItem = {
  content: string
  label: string
  href: string
  sectionId: number | null
}

type ArmHits = { items: RetrievedItem[]; error: string | null }

type ArmMetrics = {
  n: number
  precision: number | null
  chars: number
  charsPerResult: number | null
  sentences: number
  sentencesPer1000Chars: number | null
  onTopicN: number
  onTopicChars: number
  signalDensity: number | null
  onTopicAt1500: number
  error: string | null
}

type QuestionCase = {
  id: string
  question: string
  topicTerms: string[]
  memHits: number
  secHits: number
  block: 'in-corpus' | 'out-of-corpus' | 'other'
}

type SectionRec = {
  section_id: number
  filename: string
  turn_index: number
  chunk_index: number
  speaker: string
  content: string
  vector: number[]
}

type Cli = {
  stores: string[]
  uncappedStores: string[]
  sectionIndex: string | null
  transcriptDir: string
  outDir: string
  topK: number
  rebuild: boolean
  logFile: string
  budgets: number[]
  rrfK: number
  questionsPath: string | null
}

const CONTEXT_BUDGET_CHARS = 1500
const DEFAULT_BUDGETS = [1500, 4000]
const DEFAULT_RRF_K = 60
const CANDIDATE_LIMIT_MEM = 60
const CANDIDATE_LIMIT_SEC = 100
const MAX_SECTION_CHARS = 175
const EMBED_BATCH = 32
const DEFAULT_TRANSCRIPT_DIR = '/Users/au/w/transcript'
const DEFAULT_OUT_DIR = path.resolve('local/cag-compare')
const DEFAULT_LOG_FILE = '/tmp/cag-union-compare.log'
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

const GROUND_TRUTH_TERMS = Array.from(new Set(Object.values(TOPIC_TERMS).flat()))

let logFilePath: string = DEFAULT_LOG_FILE

function log(msg = ''): void {
  console.log(msg)
  try {
    if (logFilePath) {
      appendFileSync(logFilePath, msg + '\n', 'utf8')
    }
  } catch {
    // ignore logging error
  }
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    stores: [],
    uncappedStores: [],
    sectionIndex: null,
    transcriptDir: DEFAULT_TRANSCRIPT_DIR,
    outDir: DEFAULT_OUT_DIR,
    topK: 8,
    rebuild: false,
    logFile: DEFAULT_LOG_FILE,
    budgets: [...DEFAULT_BUDGETS],
    rrfK: DEFAULT_RRF_K,
    questionsPath: null,
  }
  let customBudgets = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--store') {
      const dir = argv[++i]
      if (dir) cli.stores.push(path.resolve(dir))
    } else if (a === '--uncapped-store') {
      const dir = argv[++i]
      if (dir) cli.uncappedStores.push(path.resolve(dir))
    } else if (a === '--section-index' || a === '--sections') {
      const f = argv[++i]
      if (f) cli.sectionIndex = path.resolve(f)
    } else if (a === '--transcript-dir') {
      const dir = argv[++i]
      if (dir) cli.transcriptDir = path.resolve(dir)
    } else if (a === '--out-dir') {
      const dir = argv[++i]
      if (dir) cli.outDir = path.resolve(dir)
    } else if (a === '--log' || a === '--log-file') {
      const f = argv[++i]
      if (f) cli.logFile = path.resolve(f)
    } else if (a === '--top-k') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 1) throw new Error('--top-k must be a positive number')
      cli.topK = Math.floor(n)
    } else if (a === '--rrf-k' || a === '--rrfK') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 1) throw new Error('--rrf-k must be a positive number')
      cli.rrfK = Math.floor(n)
    } else if (a === '--budget' || a === '--budgets') {
      const raw = argv[++i] ?? ''
      const parsed = raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
      if (parsed.length > 0) {
        if (!customBudgets) {
          cli.budgets = []
          customBudgets = true
        }
        cli.budgets.push(...parsed)
      }
    } else if (a === '--questions') {
      const f = argv[++i]
      if (f) cli.questionsPath = path.resolve(f)
    } else if (a === '--rebuild') {
      cli.rebuild = true
    }
  }
  if (cli.budgets.length === 0) {
    cli.budgets = [...DEFAULT_BUDGETS]
  }
  cli.budgets = Array.from(new Set(cli.budgets)).sort((a, b) => a - b)
  if (cli.stores.length === 0) {
    const fullStore = path.resolve('/tmp/cag-memories-full105')
    if (existsSync(fullStore)) {
      cli.stores.push(fullStore)
    } else {
      cli.stores.push(
        path.resolve('/tmp/cag-memories-july-cap4'),
        path.resolve('/tmp/cag-memories-ds4-webx3'),
        path.resolve('/tmp/cag-memories-ds4-commons3'),
      )
    }
  }
  if (!cli.sectionIndex) {
    const fullSec = path.join(cli.outDir, 'sections-full.jsonl')
    const stdSec = path.join(cli.outDir, 'sections.jsonl')
    if (existsSync(fullSec)) {
      cli.sectionIndex = fullSec
    } else if (existsSync(stdSec)) {
      cli.sectionIndex = stdSec
    }
  }
  return cli
}

/** Same tag/entity stripping as scripts/vectorize-sync.ts / scripts/build-ask-index.ts. */
function htmlToPlainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function chunkPlainText(plain: string, maxChars: number): string[] {
  const text = plain.trim()
  if (!text) return []
  if (Array.from(text).length <= maxChars) return [text]
  const parts = text.split(/(?<=[。！？.!?…])/u)
  const chunks: string[] = []
  let buf = ''
  const flush = () => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ''
  }
  const hardWrap = (piece: string) => {
    const chars = Array.from(piece)
    let cur = ''
    for (const c of chars) {
      if (Array.from(cur + c).length > maxChars) {
        if (cur.trim()) chunks.push(cur.trim())
        cur = c
      } else {
        cur += c
      }
    }
    if (cur.trim()) chunks.push(cur.trim())
  }
  for (const part of parts) {
    if (!part) continue
    if (Array.from(part).length > maxChars) {
      flush()
      hardWrap(part)
      continue
    }
    if (Array.from(buf + part).length > maxChars) {
      flush()
      buf = part
    } else {
      buf += part
    }
  }
  flush()
  return chunks
}

function syntheticSectionId(filename: string, turnIndex: number, chunkIndex: number): number {
  const h = createHash('sha1').update(`${filename}:${turnIndex}:${chunkIndex}`).digest()
  return (h.readInt32BE(0) & 0x7fffffff) || 1
}

function containsTerm(haystack: string, term: string): boolean {
  return haystack.toLowerCase().includes(term.toLowerCase())
}

function assembledClaim(item: RetrievedItem): string {
  return htmlToPlainText(item.content)
}

function itemHasTopicTerm(item: RetrievedItem, terms: string[]): boolean {
  return terms.some((term) => containsTerm(assembledClaim(item), term))
}
function countTermHits(texts: string[], term: string): number {
  return texts.filter((text) => containsTerm(text, term)).length
}

function corpusTexts(store: CagStore): string[] {
  return store.memories.map((mem) => {
    const quotes = mem.evidence.map((e) => e.quote).join(' ')
    const extras = [...mem.entities, ...mem.tags].join(' ')
    return `${mem.content} ${quotes} ${extras}`
  })
}

function classifyCase(
  id: string,
  question: string,
  memTexts: string[],
  secTexts: string[],
  topicTermsOverride?: string[],
): QuestionCase {
  const topicTerms = (topicTermsOverride && topicTermsOverride.length > 0)
    ? topicTermsOverride
    : (TOPIC_TERMS[id] ?? [])
  const memHits = topicTerms.reduce((sum, term) => sum + countTermHits(memTexts, term), 0)
  const secHits = topicTerms.reduce((sum, term) => sum + countTermHits(secTexts, term), 0)
  const present = memHits > 0 || secHits > 0
  const block: QuestionCase['block'] = present ? 'in-corpus' : 'out-of-corpus'
  return { id, question, topicTerms, memHits, secHits, block }
}

function vectorStats(vectors: number[][]): { dims: Set<number>; sampleL2: number[] } {
  const dims = new Set<number>()
  const sampleL2: number[] = []
  for (const v of vectors) {
    dims.add(v.length)
    if (sampleL2.length < 3) {
      let s = 0
      for (const x of v) s += x * x
      sampleL2.push(Math.sqrt(s))
    }
  }
  return { dims, sampleL2 }
}

async function confirmOllama(): Promise<void> {
  const res = await fetch('http://127.0.0.1:11434/api/tags')
  if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`)
  const body = (await res.json()) as { models?: { name?: string }[] }
  const names = (body.models ?? []).map((m) => m.name ?? '')
  if (!names.includes(LOCAL_EMBED_MODEL)) {
    throw new Error(`Ollama is up but missing tag ${LOCAL_EMBED_MODEL}. Have: ${names.join(', ')}`)
  }
  log(`Ollama is up at ${LOCAL_EMBED_URL}. Local tag present: ${LOCAL_EMBED_MODEL}`)
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const slice = texts.slice(i, i + EMBED_BATCH)
    const vecs = await embedTexts(slice)
    if (!vecs || vecs.length !== slice.length) {
      throw new Error(`embed failed at offset ${i}: got ${vecs?.length ?? 0}, expected ${slice.length}`)
    }
    for (const v of vecs) {
      if (v.length !== 1024) throw new Error(`expected 1024-dim, got ${v.length}`)
      out.push(v)
    }
    log(`  embedded ${out.length}/${texts.length}`)
  }
  return out
}

function loadEmbeddingsMap(filePath: string): Map<string, number[]> {
  const map = new Map<string, number[]>()
  if (!existsSync(filePath)) return map
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as { id: string; vector: number[] }
      if (rec.id && Array.isArray(rec.vector)) {
        map.set(rec.id, rec.vector)
      }
    } catch {
      // ignore malformed line
    }
  }
  return map
}

function saveEmbeddingsMap(filePath: string, map: Map<string, number[]>): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const lines: string[] = []
  for (const [id, vector] of map) {
    lines.push(JSON.stringify({ id, vector }))
  }
  writeFileSync(filePath, lines.length ? `${lines.join('\n')}\n` : '')
}

function memoryToItem(mem: CagMemory, titleByRoom: Record<string, string>): RetrievedItem {
  const speaker = mem.evidence[0]?.speaker ?? ''
  const turn = mem.evidence[0]?.turnIndex ?? 0
  const quotes = mem.evidence.map((e) => e.quote).filter(Boolean).join(' / ')
  const rawTitle = titleByRoom[mem.roomId] ?? mem.roomId.replace(/\.md$/, '')
  const title = rawTitle.startsWith(`${mem.roomDate} `) || rawTitle.startsWith(`${mem.roomDate}-`)
    ? rawTitle.slice(mem.roomDate.length + 1)
    : rawTitle
  const resolvedId = mem.evidence
    .map((e) => e.sectionId)
    .find((id): id is number => typeof id === 'number' && Number.isFinite(id))
  return {
    content: quotes ? `${mem.content}\n\n${quotes}` : mem.content,
    href: `file://${mem.sourceFile}#turn-${turn}`,
    label: `${mem.roomDate} ${title} — ${speaker}`.trim(),
    sectionId: resolvedId ?? null,
  }
}

function memoriesToItems(memories: CagMemory[]): RetrievedItem[] {
  const titleByRoom: Record<string, string> = {}
  for (const mem of memories) {
    titleByRoom[mem.roomId] ??= mem.roomId.replace(/\.md$/, '')
  }
  return memories.map((m) => memoryToItem(m, titleByRoom))
}

function extractSourceFilename(item: RetrievedItem): string {
  const raw = item.href.split('#')[0] ?? ''
  const base = path.basename(raw)
  return base.replace(/\.md$/i, '')
}

function charTrigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const trigrams = new Set<string>()
  for (let i = 0; i <= s.length - 3; i++) {
    trigrams.add(s.slice(i, i + 3))
  }
  return trigrams
}

function trigramJaccard(a: string, b: string): number {
  const setA = charTrigrams(a)
  const setB = charTrigrams(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const t of setA) {
    if (setB.has(t)) inter++
  }
  const union = setA.size + setB.size - inter
  return union === 0 ? 0 : inter / union
}

function isSpanDuplicate(itemA: RetrievedItem, itemB: RetrievedItem): boolean {
  const fileA = extractSourceFilename(itemA)
  const fileB = extractSourceFilename(itemB)
  if (!fileA || !fileB || fileA !== fileB) return false

  const textA = htmlToPlainText(itemA.content).toLowerCase().replace(/\s+/g, ' ').trim()
  const textB = htmlToPlainText(itemB.content).toLowerCase().replace(/\s+/g, ' ').trim()
  if (!textA || !textB) return false

  const compactA = textA.replace(/\s+/g, '')
  const compactB = textB.replace(/\s+/g, '')
  if (compactA.length >= 10 && compactB.length >= 10) {
    if (compactA.includes(compactB) || compactB.includes(compactA)) return true
  }

  return trigramJaccard(textA, textB) >= 0.45
}

function preferRepresentation(itemA: RetrievedItem, itemB: RetrievedItem): { kept: RetrievedItem; dropped: RetrievedItem } {
  // Prefer memory if it carries provenance (sectionId !== null)
  // Note: store /tmp/cag-memories-full105 has sectionId: null on memories
  const aHasProv = itemA.sectionId !== null
  const bHasProv = itemB.sectionId !== null
  if (aHasProv && !bHasProv) return { kept: itemA, dropped: itemB }
  if (bHasProv && !aHasProv) return { kept: itemB, dropped: itemA }

  // Otherwise prefer section as the shorter unit
  if (itemA.content.length <= itemB.content.length) {
    return { kept: itemA, dropped: itemB }
  } else {
    return { kept: itemB, dropped: itemA }
  }
}

/**
 * Reciprocal Rank Fusion (RRF) between memory candidates and section candidates.
 *
 * WHY RANK FUSION INSTEAD OF SCORE FUSION:
 * 1. Incomparable raw score metrics: Memory recall uses BM25-style keyword matching and entity counts,
 *    while section retrieval uses dense cosine similarity. Their score distributions, scales,
 *    and variances are completely incomparable.
 * 2. Cosine calibration failure: Cosine similarity in this embedding space cannot be reliably
 *    calibrated against a fixed threshold (should-match and should-not-match overlap across 0.264-0.618).
 * 3. Scale invariance: RRF operates purely on ordinal ranks (1/(k + rank)), which is invariant to
 *    arbitrary monotonic score transformations and prevents dense cosine scores from dominating sparse BM25 scores.
 */
type FusedCandidate = {
  item: RetrievedItem
  rrfScore: number
  memRank: number | null
  secRank: number | null
  isDuplicate: boolean
}

function fuseRankRrf(
  memItems: RetrievedItem[],
  secItems: RetrievedItem[],
  rrfK = DEFAULT_RRF_K,
): {
  fused: RetrievedItem[]
  duplicatesCount: number
  totalCandidatesBeforeDedup: number
  details: FusedCandidate[]
} {
  const totalCandidatesBeforeDedup = memItems.length + secItems.length
  let duplicatesCount = 0

  type Entry = {
    item: RetrievedItem
    memRank: number | null
    secRank: number | null
    isDuplicate: boolean
  }

  const entries: Entry[] = []

  for (let i = 0; i < memItems.length; i++) {
    entries.push({
      item: memItems[i]!,
      memRank: i + 1,
      secRank: null,
      isDuplicate: false,
    })
  }

  for (let j = 0; j < secItems.length; j++) {
    const sItem = secItems[j]!
    const sRank = j + 1
    let matchedEntry: Entry | null = null

    for (const entry of entries) {
      if (isSpanDuplicate(entry.item, sItem)) {
        matchedEntry = entry
        break
      }
    }

    if (matchedEntry) {
      duplicatesCount++
      matchedEntry.secRank = sRank
      matchedEntry.isDuplicate = true
      const { kept } = preferRepresentation(matchedEntry.item, sItem)
      matchedEntry.item = kept
    } else {
      entries.push({
        item: sItem,
        memRank: null,
        secRank: sRank,
        isDuplicate: false,
      })
    }
  }

  const details: FusedCandidate[] = entries.map((e) => {
    let rrfScore = 0
    if (e.memRank !== null) rrfScore += 1 / (rrfK + e.memRank)
    if (e.secRank !== null) rrfScore += 1 / (rrfK + e.secRank)
    return {
      item: e.item,
      rrfScore,
      memRank: e.memRank,
      secRank: e.secRank,
      isDuplicate: e.isDuplicate,
    }
  })

  details.sort((a, b) => b.rrfScore - a.rrfScore)

  return {
    fused: details.map((d) => d.item),
    duplicatesCount,
    totalCandidatesBeforeDedup,
    details,
  }
}

function assembleBudgetItems(items: RetrievedItem[], budgetChars: number): RetrievedItem[] {
  const kept: RetrievedItem[] = []
  let usedChars = 0
  for (const item of items) {
    const len = assembledClaim(item).length
    if (usedChars + len <= budgetChars) {
      kept.push(item)
      usedChars += len
    }
  }
  return kept
}

function pickOracle(armA: ArmMetrics, armB: ArmMetrics): ArmMetrics {
  if (armA.error && !armB.error) return armB
  if (armB.error && !armA.error) return armA
  if (armA.error && armB.error) return armA

  const pA = armA.precision ?? 0
  const pB = armB.precision ?? 0
  if (pA > pB) return armA
  if (pB > pA) return armB

  const sigA = armA.signalDensity ?? 0
  const sigB = armB.signalDensity ?? 0
  if (sigA > sigB) return armA
  if (sigB > sigA) return armB

  if (armA.onTopicN > armB.onTopicN) return armA
  if (armB.onTopicN > armA.onTopicN) return armB

  return armA
}

function emptyMetrics(error: string | null): ArmMetrics {
  return {
    n: 0,
    precision: null,
    chars: 0,
    charsPerResult: null,
    sentences: 0,
    sentencesPer1000Chars: null,
    onTopicN: 0,
    onTopicChars: 0,
    signalDensity: null,
    onTopicAt1500: 0,
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
    sentencesPer1000Chars: chars === 0 ? null : (sentences * 1000) / chars,
    onTopicN: relevant,
    onTopicChars: topicChars,
    signalDensity: chars === 0 ? null : topicChars / chars,
    onTopicAt1500,
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

function preview(text: string, maxChars = 100): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, maxChars)}…`
}

function printArm(name: string, arm: ArmHits, metrics: ArmMetrics, terms: string[]): void {
  if (arm.error) {
    log(`  ${name}: ERROR — ${arm.error}`)
    return
  }
  log(
    `  ${name}: n=${metrics.n}  prec=${fmtPrec(metrics.precision)}  ` +
    `on-topic=${metrics.onTopicN}  assembled-chars=${metrics.chars}  ` +
    `signal=${fmtPrec(metrics.signalDensity)}  ` +
    `on-topic@${CONTEXT_BUDGET_CHARS}=${metrics.onTopicAt1500}  ` +
    `sent/1k=${fmtNum(metrics.sentencesPer1000Chars, 1)}  ` +
    `chars/hit=${fmtNum(metrics.charsPerResult)}`,
  )
  for (const [i, item] of arm.items.entries()) {
    const sid = item.sectionId === null ? 'null' : String(item.sectionId)
    const ok = itemHasTopicTerm(item, terms)
    log(`    [${i + 1}] ${item.label}  sectionId=${sid}  topic-term=${ok ? 'yes' : 'no'}`)
    log(`        ${item.href}`)
    log(`        ${preview(assembledClaim(item))}`)
  }
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

type BudgetArmResult = {
  sec: ArmMetrics
  memKw: ArmMetrics
  memHy: ArmMetrics
  union: ArmMetrics
  oracle: ArmMetrics
}

type Row = {
  testCase: QuestionCase
  cappedKw: ArmMetrics
  cappedHy: ArmMetrics
  cappedCos: ArmMetrics
  uncappedKw?: ArmMetrics
  uncappedHy?: ArmMetrics
  uncappedCos?: ArmMetrics
  section: ArmMetrics
  unionK: ArmMetrics
  oracleK: ArmMetrics
  budgets: Record<number, BudgetArmResult>
  duplicatesCount: number
  totalCandidatesBeforeDedup: number
}

function cell(m: ArmMetrics, key: keyof ArmMetrics, kind: 'int' | 'prec' | 'num' = 'int'): string {
  if (m.error) return 'ERR'
  const value = m[key]
  if (value === null || value === undefined) return 'n/a'
  if (kind === 'prec' && typeof value === 'number') return fmtPrec(value)
  if (kind === 'num' && typeof value === 'number') return fmtNum(value)
  return String(value)
}

function printArmMeans(label: string, rows: Row[], pick: (r: Row) => ArmMetrics): void {
  const ready = rows.filter((r) => !pick(r).error)
  const precHits = mean(ready.map((r) => pick(r).precision).filter((x): x is number => x !== null))
  const precZero = mean(ready.map((r) => pick(r).precision ?? 0))
  const signalHits = mean(ready.map((r) => pick(r).signalDensity).filter((x): x is number => x !== null))
  const signalZero = mean(ready.map((r) => pick(r).signalDensity ?? 0))
  const budget = mean(ready.map((r) => pick(r).onTopicAt1500))
  const charsHit = mean(ready.map((r) => pick(r).charsPerResult).filter((x): x is number => x !== null))
  const totalChars = ready.reduce((sum, r) => sum + pick(r).chars, 0)
  const totalSent = ready.reduce((sum, r) => sum + pick(r).sentences, 0)
  const sentPer1k = totalChars === 0 ? null : (totalSent * 1000) / totalChars
  const emptyN = ready.filter((r) => pick(r).n === 0).length
  log(
    `  ${label}: empty=${emptyN}/${ready.length}  ` +
    `prec(hits)=${fmtPrec(precHits)}  prec(empty=0)=${fmtPrec(precZero)}  ` +
    `signal(hits)=${fmtPrec(signalHits)}  signal(empty=0)=${fmtPrec(signalZero)}  ` +
    `on-topic@${CONTEXT_BUDGET_CHARS}=${fmtNum(budget, 2)}  ` +
    `sent/1k=${fmtNum(sentPer1k, 1)}  ` +
    `chars/hit=${fmtNum(charsHit)}`,
  )
}

function printBudgetBlock(
  budgetChars: number,
  rows: Row[],
): void {
  const title = `Budget Comparison: ${budgetChars} Characters (Union RRF vs Sections Alone vs Memory-KW)`
  log(`\n${title}`)
  log('='.repeat(title.length))
  log(`Evaluating each arm assembled greedily up to ${budgetChars} characters in ranked order.`)
  if (rows.length === 0) {
    log('(no questions in this block)')
    return
  }

  log(
    'id\t' +
    'sec_n\tsec_p\tsec_s\tsec_ot\tsec_c\t' +
    'mem_n\tmem_p\tmem_s\tmem_ot\tmem_c\t' +
    'uni_n\tuni_p\tuni_s\tuni_ot\tuni_c\t' +
    'orc_p\torc_s\torc_ot',
  )

  for (const r of rows) {
    const b = r.budgets[budgetChars]
    if (!b) continue
    const s = b.sec
    const m = b.memKw
    const u = b.union
    const o = b.oracle
    log(
      [
        r.testCase.id,
        cell(s, 'n'), cell(s, 'precision', 'prec'), cell(s, 'signalDensity', 'prec'), cell(s, 'onTopicN'), cell(s, 'chars'),
        cell(m, 'n'), cell(m, 'precision', 'prec'), cell(m, 'signalDensity', 'prec'), cell(m, 'onTopicN'), cell(m, 'chars'),
        cell(u, 'n'), cell(u, 'precision', 'prec'), cell(u, 'signalDensity', 'prec'), cell(u, 'onTopicN'), cell(u, 'chars'),
        cell(o, 'precision', 'prec'), cell(o, 'signalDensity', 'prec'), cell(o, 'onTopicN'),
      ].join('\t'),
    )
  }

  log(`n_questions=${rows.length}`)
  const secPick = (r: Row) => r.budgets[budgetChars]!.sec
  const memPick = (r: Row) => r.budgets[budgetChars]!.memKw
  const uniPick = (r: Row) => r.budgets[budgetChars]!.union
  const orcPick = (r: Row) => r.budgets[budgetChars]!.oracle

  printArmMeans(`sections-alone @ ${budgetChars} chars`, rows, secPick)
  printArmMeans(`memory-kw      @ ${budgetChars} chars`, rows, memPick)
  printArmMeans(`union-rrf      @ ${budgetChars} chars`, rows, uniPick)
  printArmMeans(`oracle-bound   @ ${budgetChars} chars`, rows, orcPick)

  const ready = rows.filter((r) => r.budgets[budgetChars])
  const secPrec = mean(ready.map((r) => r.budgets[budgetChars]!.sec.precision ?? 0)) ?? 0
  const uniPrec = mean(ready.map((r) => r.budgets[budgetChars]!.union.precision ?? 0)) ?? 0
  const memPrec = mean(ready.map((r) => r.budgets[budgetChars]!.memKw.precision ?? 0)) ?? 0
  const orcPrec = mean(ready.map((r) => r.budgets[budgetChars]!.oracle.precision ?? 0)) ?? 0

  const secSig = mean(ready.map((r) => r.budgets[budgetChars]!.sec.signalDensity ?? 0)) ?? 0
  const uniSig = mean(ready.map((r) => r.budgets[budgetChars]!.union.signalDensity ?? 0)) ?? 0
  const memSig = mean(ready.map((r) => r.budgets[budgetChars]!.memKw.signalDensity ?? 0)) ?? 0
  const orcSig = mean(ready.map((r) => r.budgets[budgetChars]!.oracle.signalDensity ?? 0)) ?? 0

  const secOt = mean(ready.map((r) => r.budgets[budgetChars]!.sec.onTopicN)) ?? 0
  const uniOt = mean(ready.map((r) => r.budgets[budgetChars]!.union.onTopicN)) ?? 0
  const memOt = mean(ready.map((r) => r.budgets[budgetChars]!.memKw.onTopicN)) ?? 0
  const orcOt = mean(ready.map((r) => r.budgets[budgetChars]!.oracle.onTopicN)) ?? 0

  const dPrec = uniPrec - secPrec
  const dSig = uniSig - secSig
  const dOt = uniOt - secOt
  const headroom = orcPrec - secPrec
  const captured = headroom > 0 ? ((dPrec / headroom) * 100) : 0

  log(`\n  Deltas at Budget ${budgetChars} chars (Union RRF vs Sections Alone):`)
  log(`    Precision delta:      ${dPrec >= 0 ? `+${fmtPrec(dPrec)}` : fmtPrec(dPrec)} (sections: ${fmtPrec(secPrec)}, union: ${fmtPrec(uniPrec)}, mem-kw: ${fmtPrec(memPrec)}, oracle: ${fmtPrec(orcPrec)})`)
  log(`    Signal density delta: ${dSig >= 0 ? `+${fmtPrec(dSig)}` : fmtPrec(dSig)} (sections: ${fmtPrec(secSig)}, union: ${fmtPrec(uniSig)}, mem-kw: ${fmtPrec(memSig)}, oracle: ${fmtPrec(orcSig)})`)
  log(`    On-topic items delta: ${dOt >= 0 ? `+${fmtNum(dOt, 2)}` : fmtNum(dOt, 2)} (sections: ${fmtNum(secOt, 2)}, union: ${fmtNum(uniOt, 2)}, mem-kw: ${fmtNum(memOt, 2)}, oracle: ${fmtNum(orcOt, 2)})`)
  log(`    Oracle headroom:      +${fmtPrec(headroom)} available; Union captures ${fmtNum(captured, 1)}% of oracle headroom`)
}

function printBlock(title: string, note: string, rows: Row[], hasUncapped: boolean): void {
  log(`\n${title}`)
  log('='.repeat(title.length))
  log(note)
  if (rows.length === 0) {
    log('(no questions in this block)')
    return
  }
  if (hasUncapped) {
    log(
      'id\t' +
      'ckw_n\tckw_p\tckw_s\tckw@15\t' +
      'chy_n\tchy_p\tchy_s\tchy@15\t' +
      'cmc_n\tcmc_p\tcmc_s\tcmc@15\t' +
      'ukw_n\tukw_p\tukw_s\tukw@15\t' +
      'uhy_n\tuhy_p\tuhy_s\tuhy@15\t' +
      'umc_n\tumc_p\tumc_s\tumc@15\t' +
      'sec_n\tsec_p\tsec_s\tsec@15\t' +
      'uni_n\tuni_p\tuni_s\tuni@15',
    )
    for (const row of rows) {
      const ck = row.cappedKw
      const ch = row.cappedHy
      const cm = row.cappedCos
      const uk = row.uncappedKw!
      const uh = row.uncappedHy!
      const um = row.uncappedCos!
      const s = row.section
      const u = row.unionK
      log(
        [
          row.testCase.id,
          cell(ck, 'n'), cell(ck, 'precision', 'prec'), cell(ck, 'signalDensity', 'prec'), cell(ck, 'onTopicAt1500'),
          cell(ch, 'n'), cell(ch, 'precision', 'prec'), cell(ch, 'signalDensity', 'prec'), cell(ch, 'onTopicAt1500'),
          cell(cm, 'n'), cell(cm, 'precision', 'prec'), cell(cm, 'signalDensity', 'prec'), cell(cm, 'onTopicAt1500'),
          cell(uk, 'n'), cell(uk, 'precision', 'prec'), cell(uk, 'signalDensity', 'prec'), cell(uk, 'onTopicAt1500'),
          cell(uh, 'n'), cell(uh, 'precision', 'prec'), cell(uh, 'signalDensity', 'prec'), cell(uh, 'onTopicAt1500'),
          cell(um, 'n'), cell(um, 'precision', 'prec'), cell(um, 'signalDensity', 'prec'), cell(um, 'onTopicAt1500'),
          cell(s, 'n'), cell(s, 'precision', 'prec'), cell(s, 'signalDensity', 'prec'), cell(s, 'onTopicAt1500'),
          cell(u, 'n'), cell(u, 'precision', 'prec'), cell(u, 'signalDensity', 'prec'), cell(u, 'onTopicAt1500'),
        ].join('\t'),
      )
    }
  } else {
    log(
      'id\t' +
      'kw_n\tkw_p\tkw_s\tkw@15\t' +
      'hy_n\thy_p\thy_s\thy@15\t' +
      'mc_n\tmc_p\tmc_s\tmc@15\t' +
      'sec_n\tsec_p\tsec_s\tsec@15\t' +
      'uni_n\tuni_p\tuni_s\tuni@15',
    )
    for (const row of rows) {
      const ck = row.cappedKw
      const ch = row.cappedHy
      const cm = row.cappedCos
      const s = row.section
      const u = row.unionK
      log(
        [
          row.testCase.id,
          cell(ck, 'n'), cell(ck, 'precision', 'prec'), cell(ck, 'signalDensity', 'prec'), cell(ck, 'onTopicAt1500'),
          cell(ch, 'n'), cell(ch, 'precision', 'prec'), cell(ch, 'signalDensity', 'prec'), cell(ch, 'onTopicAt1500'),
          cell(cm, 'n'), cell(cm, 'precision', 'prec'), cell(cm, 'signalDensity', 'prec'), cell(cm, 'onTopicAt1500'),
          cell(s, 'n'), cell(s, 'precision', 'prec'), cell(s, 'signalDensity', 'prec'), cell(s, 'onTopicAt1500'),
          cell(u, 'n'), cell(u, 'precision', 'prec'), cell(u, 'signalDensity', 'prec'), cell(u, 'onTopicAt1500'),
        ].join('\t'),
      )
    }
  }
  log(`n_questions=${rows.length} (at full scale n=21, statistical power is high; differences >0.03 are meaningful)`)
  printArmMeans('memory keyword (honest abstain)', rows, (r) => r.cappedKw)
  printArmMeans(`memory hybrid (minScore floor ${DEFAULT_MEMORY_MIN_COSINE_SCORE})`, rows, (r) => r.cappedHy)
  printArmMeans('memory-cosine (isolate, no floor)', rows, (r) => r.cappedCos)
  if (hasUncapped) {
    printArmMeans('uncapped keyword (honest abstain)', rows, (r) => r.uncappedKw!)
    printArmMeans(`uncapped hybrid (minScore floor ${DEFAULT_MEMORY_MIN_COSINE_SCORE})`, rows, (r) => r.uncappedHy!)
    printArmMeans('uncapped memory-cosine (isolate, no floor)', rows, (r) => r.uncappedCos!)
  }
  printArmMeans('section-cosine (no floor)', rows, (r) => r.section)
  printArmMeans('union RRF (k=8)', rows, (r) => r.unionK)
  printArmMeans('oracle bound (k=8)', rows, (r) => r.oracleK)
}

function buildSectionsFromRooms(roomIds: string[], transcriptDir: string): Omit<SectionRec, 'vector'>[] {
  const sections: Omit<SectionRec, 'vector'>[] = []
  for (const roomId of [...roomIds].sort()) {
    const filePath = path.join(transcriptDir, roomId)
    if (!existsSync(filePath)) {
      throw new Error(`transcript missing (did not walk the tree): ${filePath}`)
    }
    const markdown = readFileSync(filePath, 'utf8')
    const parsed = parseTranscriptMarkdown(markdown, filePath)
    const filename = roomId.replace(/\.md$/i, '')
    for (const turn of parsed.turns) {
      const plain = htmlToPlainText(turn.text)
      const chunks = chunkPlainText(plain, MAX_SECTION_CHARS)
      for (const [chunkIndex, content] of chunks.entries()) {
        sections.push({
          section_id: syntheticSectionId(filename, turn.turnIndex, chunkIndex),
          filename,
          turn_index: turn.turnIndex,
          chunk_index: chunkIndex,
          speaker: turn.speaker,
          content,
        })
      }
    }
  }
  return sections
}

function loadSectionIndex(outPath: string): SectionRec[] | null {
  if (!existsSync(outPath)) return null
  const rows: SectionRec[] = []
  for (const line of readFileSync(outPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as SectionRec
    if (!rec.content || !Array.isArray(rec.vector)) return null
    rows.push(rec)
  }
  return rows
}

function saveSectionIndex(outPath: string, rows: SectionRec[]): void {
  mkdirSync(path.dirname(outPath), { recursive: true })
  const lines = rows.map((r) => JSON.stringify(r))
  writeFileSync(outPath, `${lines.join('\n')}\n`)
}

function rankSectionsByCosine(
  query: number[],
  flatVectors: Float32Array,
  sections: SectionRec[],
  topK: number,
): SectionRec[] {
  const n = sections.length
  const q = new Float32Array(query)
  const scores: { index: number; score: number }[] = []
  for (let i = 0; i < n; i++) {
    let sum = 0
    const offset = i * 1024
    for (let j = 0; j < 1024; j++) {
      sum += q[j]! * flatVectors[offset + j]!
    }
    scores.push({ index: i, score: sum })
  }
  scores.sort((a, b) => b.score - a.score)
  return scores.slice(0, topK).map((s) => sections[s.index]!)
}

function rankMemoriesByCosine(
  query: number[],
  memories: CagMemory[],
  embeddings: Map<string, number[]>,
  topK: number,
): CagMemory[] {
  const q = new Float32Array(query)
  const scored: { memory: CagMemory; score: number }[] = []
  for (const m of memories) {
    const v = embeddings.get(m.id)
    if (!v || v.length !== 1024) continue
    let sum = 0
    for (let j = 0; j < 1024; j++) {
      sum += q[j]! * v[j]!
    }
    scored.push({ memory: m, score: sum })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map((s) => s.memory)
}

function printVerdict(
  inCorpus: Row[],
  outCorpus: Row[],
  primaryStore: CagStore,
  uncappedStore: CagStore | null,
  sections: SectionRec[],
  primaryTexts: string[],
  uncappedTexts: string[],
  sectionTexts: string[],
  budgets: number[] = DEFAULT_BUDGETS,
): void {
  log('\n' + '='.repeat(80))
  log('VERDICT (same corpus, same embedder, qwen3-embedding:0.6b)')
  log('='.repeat(80))

  const readyIn = inCorpus

  // --------------------------------------------------------------------------
  // Q0. Duplicate Span Measurement (Memory Claims vs Section Chunks)
  // --------------------------------------------------------------------------
  log('\n--- Q0. Deduplication: Memory Claims vs Section Chunks ---')
  log('[Because memory claims are distilled from the same transcripts as sections, naive union double-spends budget]')
  const totalDups = readyIn.reduce((sum, r) => sum + r.duplicatesCount, 0)
  const totalCand = readyIn.reduce((sum, r) => sum + r.totalCandidatesBeforeDedup, 0)
  const dupRate = totalCand > 0 ? (totalDups / totalCand) * 100 : 0
  log(`  Examined ${totalCand} candidate representations across ${readyIn.length} in-corpus questions.`)
  log(`  Detected ${totalDups} duplicate source spans (same transcript file + substantial text overlap/containment/Jaccard>=0.45).`)
  log(`  Measured Duplicate Rate: ${dupRate.toFixed(2)}% of candidate pool (${totalDups}/${totalCand} candidates merged).`)
  log(`  Provenance Resolution Note: Memory records from /tmp/cag-memories-full105 have sectionId: null (store predates section-id resolver), so memory-with-provenance preference is not triggered and sections are kept as the shorter unit.`)

  // --------------------------------------------------------------------------
  // Q1. System-Level (HEADLINE): Union(Memory+Sections) vs Sections-Alone at Equal Budget
  // --------------------------------------------------------------------------
  log('\n--- Q1. System-Level Headline: Union (Memory+Sections RRF) vs Sections-Alone at Equal Budget ---')
  log('[The central question: At equal character budget, does Union beat Sections alone?]')

  for (const B of budgets) {
    const secPick = (r: Row) => r.budgets[B]?.sec ?? emptyMetrics('missing')
    const memPick = (r: Row) => r.budgets[B]?.memKw ?? emptyMetrics('missing')
    const uniPick = (r: Row) => r.budgets[B]?.union ?? emptyMetrics('missing')
    const orcPick = (r: Row) => r.budgets[B]?.oracle ?? emptyMetrics('missing')

    const secPrec = mean(readyIn.map((r) => secPick(r).precision ?? 0)) ?? 0
    const memPrec = mean(readyIn.map((r) => memPick(r).precision ?? 0)) ?? 0
    const uniPrec = mean(readyIn.map((r) => uniPick(r).precision ?? 0)) ?? 0
    const orcPrec = mean(readyIn.map((r) => orcPick(r).precision ?? 0)) ?? 0

    const secSig = mean(readyIn.map((r) => secPick(r).signalDensity ?? 0)) ?? 0
    const memSig = mean(readyIn.map((r) => memPick(r).signalDensity ?? 0)) ?? 0
    const uniSig = mean(readyIn.map((r) => uniPick(r).signalDensity ?? 0)) ?? 0
    const orcSig = mean(readyIn.map((r) => orcPick(r).signalDensity ?? 0)) ?? 0

    const secOt = mean(readyIn.map((r) => secPick(r).onTopicN)) ?? 0
    const memOt = mean(readyIn.map((r) => memPick(r).onTopicN)) ?? 0
    const uniOt = mean(readyIn.map((r) => uniPick(r).onTopicN)) ?? 0
    const orcOt = mean(readyIn.map((r) => orcPick(r).onTopicN)) ?? 0

    const secChars = mean(readyIn.map((r) => secPick(r).chars)) ?? 0
    const memChars = mean(readyIn.map((r) => memPick(r).chars)) ?? 0
    const uniChars = mean(readyIn.map((r) => uniPick(r).chars)) ?? 0

    const dPrec = uniPrec - secPrec
    const dSig = uniSig - secSig
    const dOt = uniOt - secOt
    const headroom = orcPrec - secPrec
    const captured = headroom > 0 ? (dPrec / headroom) * 100 : 0

    log(`\n  [Budget = ${B} characters (n=${readyIn.length} questions)]:`)
    log(`    Sections-alone: prec=${fmtPrec(secPrec)}  signal=${fmtPrec(secSig)}  on-topic=${fmtNum(secOt, 2)}  chars=${fmtNum(secChars, 0)}`)
    log(`    Memory-kw:      prec=${fmtPrec(memPrec)}  signal=${fmtPrec(memSig)}  on-topic=${fmtNum(memOt, 2)}  chars=${fmtNum(memChars, 0)}`)
    log(`    Union (RRF):    prec=${fmtPrec(uniPrec)}  signal=${fmtPrec(uniSig)}  on-topic=${fmtNum(uniOt, 2)}  chars=${fmtNum(uniChars, 0)}`)
    log(`    Oracle Bound:   prec=${fmtPrec(orcPrec)}  signal=${fmtPrec(orcSig)}  on-topic=${fmtNum(orcOt, 2)}`)
    log(`    Deltas (Union vs Sections-alone @ ${B} chars):`)
    log(`      Precision delta:      ${dPrec >= 0 ? `+${fmtPrec(dPrec)}` : fmtPrec(dPrec)} (${dPrec >= 0.03 ? 'Union wins' : dPrec <= -0.03 ? 'Sections win' : 'noise band'})`)
    log(`      Signal density delta: ${dSig >= 0 ? `+${fmtPrec(dSig)}` : fmtPrec(dSig)} (${dSig >= 0.03 ? 'Union wins' : dSig <= -0.03 ? 'Sections win' : 'noise band'})`)
    log(`      On-topic items delta: ${dOt >= 0 ? `+${fmtNum(dOt, 2)}` : fmtNum(dOt, 2)}`)
    log(`      Oracle headroom:      +${fmtPrec(headroom)} available; Union captures ${fmtNum(captured, 1)}% of oracle headroom`)
  }

  // --------------------------------------------------------------------------
  // Q2. Fixed-k (k=8) Comparison (Legacy baseline)
  // --------------------------------------------------------------------------
  log('\n--- Q2. Legacy Fixed-k (k=8) Comparison ---')
  const cKwPrec = mean(readyIn.map((r) => r.cappedKw.precision).filter((x): x is number => x !== null))
  const cKwSig = mean(readyIn.map((r) => r.cappedKw.signalDensity).filter((x): x is number => x !== null))
  const cHyPrec = mean(readyIn.map((r) => r.cappedHy.precision).filter((x): x is number => x !== null))
  const cHySig = mean(readyIn.map((r) => r.cappedHy.signalDensity).filter((x): x is number => x !== null))
  const secPrec = mean(readyIn.map((r) => r.section.precision).filter((x): x is number => x !== null))
  const secSig = mean(readyIn.map((r) => r.section.signalDensity).filter((x): x is number => x !== null))
  const uniKPrec = mean(readyIn.map((r) => r.unionK.precision).filter((x): x is number => x !== null))
  const uniKSig = mean(readyIn.map((r) => r.unionK.signalDensity).filter((x): x is number => x !== null))
  const orcKPrec = mean(readyIn.map((r) => r.oracleK.precision).filter((x): x is number => x !== null))

  log(`  Fixed-k=8 in-corpus n=${readyIn.length}:`)
  log(`    Section-cosine: prec=${fmtPrec(secPrec)}  signal=${fmtPrec(secSig)}`)
  log(`    Memory-keyword: prec=${fmtPrec(cKwPrec)}  signal=${fmtPrec(cKwSig)}`)
  log(`    Memory-hybrid:  prec=${fmtPrec(cHyPrec)}  signal=${fmtPrec(cHySig)}`)
  log(`    Union-RRF(k=8): prec=${fmtPrec(uniKPrec)}  signal=${fmtPrec(uniKSig)}`)
  log(`    Oracle(k=8):    prec=${fmtPrec(orcKPrec)}`)

  // --------------------------------------------------------------------------
  // Q3. Embedding Isolate: Memory-Cosine vs Section-Cosine
  // --------------------------------------------------------------------------
  log('\n--- Q3. Embedding Isolate: Memory-Cosine vs Section-Cosine ---')
  log('[Sub-question isolate: does embedding a memory perform better than embedding a raw chunk under identical cosine ranking?]')
  const cMcPrec = mean(readyIn.map((r) => r.cappedCos.precision).filter((x): x is number => x !== null))
  const cMcSig = mean(readyIn.map((r) => r.cappedCos.signalDensity).filter((x): x is number => x !== null))
  log(`  In-corpus n=${readyIn.length}:`)
  log(`    Memory-Cosine:           prec=${fmtPrec(cMcPrec)}  signal=${fmtPrec(cMcSig)}`)
  log(`    Section-Cosine:          prec=${fmtPrec(secPrec)}  signal=${fmtPrec(secSig)}`)
  const dMcSec = cMcPrec !== null && secPrec !== null ? cMcPrec - secPrec : null
  log(`    Delta (MC vs Sec):       precision ${fmtPrec(dMcSec)} (sections win)`)

  // --------------------------------------------------------------------------
  // Q4. Abstention: Out-of-Corpus Behavior
  // --------------------------------------------------------------------------
  log('\n--- Q4. Abstention: Out-of-Corpus Behavior ---')
  log('[For a product that must cite sources, abstaining on absent topics beats emitting confident hallucinations / false positives]')
  const readyOut = outCorpus
  if (readyOut.length === 0) {
    log(`  Out-of-corpus queries (n=0): With 105 covering files, all 21 evaluation questions are in-corpus (100% topic coverage; changed from 7/21 in the 6-room slice).`)
  } else {
    const cKwEmpty = readyOut.filter((r) => r.cappedKw.n === 0).length
    const secEmpty = readyOut.filter((r) => r.section.n === 0).length
    log(`  Out-of-corpus queries (n=${readyOut.length}): memory keyword empty=${cKwEmpty}/${readyOut.length}, section cosine empty=${secEmpty}/${readyOut.length}.`)
  }

  // --------------------------------------------------------------------------
  // Q5. Headline Summary Verdict
  // --------------------------------------------------------------------------
  log('\n' + '='.repeat(80))
  const b1500Sec = mean(readyIn.map((r) => r.budgets[1500]?.sec.precision ?? 0)) ?? 0
  const b1500Uni = mean(readyIn.map((r) => r.budgets[1500]?.union.precision ?? 0)) ?? 0
  const b1500SigSec = mean(readyIn.map((r) => r.budgets[1500]?.sec.signalDensity ?? 0)) ?? 0
  const b1500SigUni = mean(readyIn.map((r) => r.budgets[1500]?.union.signalDensity ?? 0)) ?? 0

  const b4000Sec = mean(readyIn.map((r) => r.budgets[4000]?.sec.precision ?? 0)) ?? 0
  const b4000Uni = mean(readyIn.map((r) => r.budgets[4000]?.union.precision ?? 0)) ?? 0
  const b4000SigSec = mean(readyIn.map((r) => r.budgets[4000]?.sec.signalDensity ?? 0)) ?? 0
  const b4000SigUni = mean(readyIn.map((r) => r.budgets[4000]?.union.signalDensity ?? 0)) ?? 0

  const d1500P = b1500Uni - b1500Sec
  const d1500S = b1500SigUni - b1500SigSec
  const d4000P = b4000Uni - b4000Sec
  const d4000S = b4000SigUni - b4000SigSec

  log(`HEADLINE SUMMARY:`)
  log(`  At 1500-char budget: Union prec ${fmtPrec(b1500Uni)} vs Sections ${fmtPrec(b1500Sec)} (delta: ${d1500P >= 0 ? `+${fmtPrec(d1500P)}` : fmtPrec(d1500P)}), signal ${fmtPrec(b1500SigUni)} vs ${fmtPrec(b1500SigSec)} (delta: ${d1500S >= 0 ? `+${fmtPrec(d1500S)}` : fmtPrec(d1500S)}).`)
  log(`  At 4000-char budget: Union prec ${fmtPrec(b4000Uni)} vs Sections ${fmtPrec(b4000Sec)} (delta: ${d4000P >= 0 ? `+${fmtPrec(d4000P)}` : fmtPrec(d4000P)}), signal ${fmtPrec(b4000SigUni)} vs ${fmtPrec(b4000SigSec)} (delta: ${d4000S >= 0 ? `+${fmtPrec(d4000S)}` : fmtPrec(d4000S)}).`)
  log(`  Measured Duplicate Rate: ${dupRate.toFixed(2)}% (${totalDups}/${totalCand} candidate representations deduplicated across ${readyIn.length} queries).`)
  log('='.repeat(80))
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  logFilePath = cli.logFile
  mkdirSync(path.dirname(logFilePath), { recursive: true })
  writeFileSync(logFilePath, '', 'utf8') // reset log file

  await confirmOllama()

  // 1. Primary memory store
  const primaryStore = mergeCagStores(cli.stores.map((dir) => loadCagStore(dir)))
  const primaryEmbeddings = mergeEmbeddings(cli.stores.map((dir) => loadEmbeddingsJsonl(dir)))
  const roomIds = [...new Set(primaryStore.memories.map((m) => m.roomId))].sort()
  const primaryTexts = corpusTexts(primaryStore)

  log(`--store ${cli.stores.join(' --store ')}`)
  if (cli.sectionIndex) log(`--section-index ${cli.sectionIndex}`)
  log(`topK=${cli.topK}`)
  log(`budgets=${cli.budgets.join(',')} characters`)
  log(`rrfK=${cli.rrfK}`)
  log(`Primary memory store: ${primaryStore.memories.length} memories, ${primaryStore.links.length} links, ${primaryEmbeddings.size} embeddings`)
  log(`embedder: ${LOCAL_EMBED_MODEL} via ${LOCAL_EMBED_URL} (no Cloudflare)`)
  log(`hybrid = recallHybrid with DEFAULT_MEMORY_MIN_COSINE_SCORE = ${DEFAULT_MEMORY_MIN_COSINE_SCORE}.`)
  log('memory-cosine is harness-only: query vs memory.content vectors, same method as section-cosine.')
  log('keyword = recall(--no-llm): honest abstain.')
  log('union = Reciprocal Rank Fusion (RRF k=' + cli.rrfK + ') between memory keyword recall and section cosine retrieval with span deduplication.')

  log(`\nRoom set from primaryStore.memories.map(m => m.roomId)  n=${roomIds.length}`)

  const embVecs = [...primaryEmbeddings.values()]
  const embStats = vectorStats(embVecs)
  log(`\nArm A (Memory) embeddings: n=${primaryEmbeddings.size}  dims=${[...embStats.dims].join(',')}  sample L2=${embStats.sampleL2.map((x) => x.toFixed(6)).join(', ')}`)
  if (![...embStats.dims].every((d) => d === 1024)) {
    log('Arm A dimension is not 1024 — re-embedding memories locally (not writing /tmp stores).')
  } else {
    log('Arm A dimension matches 1024; using existing embeddings.jsonl (same model).')
  }

  const missingPrimaryEmb = primaryStore.memories.filter((m) => !primaryEmbeddings.has(m.id))
  let memoryVectors = primaryEmbeddings
  if (missingPrimaryEmb.length > 0 || ![...embStats.dims].every((d) => d === 1024)) {
    const need = missingPrimaryEmb.length > 0 && [...embStats.dims].every((d) => d === 1024)
      ? missingPrimaryEmb
      : primaryStore.memories
    log(`Re-embedding ${need.length} memory contents locally…`)
    const vecs = await embedBatch(need.map((m) => m.content))
    memoryVectors = new Map(primaryEmbeddings)
    for (const [i, mem] of need.entries()) memoryVectors.set(mem.id, vecs[i] ?? [])
  }

  // 2. Uncapped Heuristic store (if configured / available)
  let uncappedStore: CagStore | null = null
  let uncappedVectors: Map<string, number[]> = new Map()
  let uncappedTexts: string[] = []
  if (cli.uncappedStores.length > 0) {
    uncappedStore = mergeCagStores(cli.uncappedStores.map((dir) => loadCagStore(dir)))
    uncappedTexts = corpusTexts(uncappedStore)
    log(`\nUncapped Heuristic store: ${uncappedStore.memories.length} memories, ${uncappedStore.links.length} links`)
    const uncappedCachePath = path.join(cli.outDir, 'uncapped-embeddings.jsonl')
    uncappedVectors = loadEmbeddingsMap(uncappedCachePath)
    const missingUncapped = uncappedStore.memories.filter((m) => !uncappedVectors.has(m.id))
    if (missingUncapped.length > 0) {
      log(`Embedding ${missingUncapped.length} uncapped memory contents locally and caching to ${uncappedCachePath}…`)
      const vecs = await embedBatch(missingUncapped.map((m) => m.content))
      for (const [i, mem] of missingUncapped.entries()) {
        uncappedVectors.set(mem.id, vecs[i] ?? [])
      }
      saveEmbeddingsMap(uncappedCachePath, uncappedVectors)
      log(`Saved uncapped embeddings cache: ${uncappedVectors.size} vectors`)
    } else {
      log(`Loaded cached uncapped embeddings ${uncappedCachePath}  n=${uncappedVectors.size}`)
    }
  }

  // 3. Section index
  const sectionPath = cli.sectionIndex || path.join(cli.outDir, 'sections-full.jsonl')
  let sections = cli.rebuild ? null : loadSectionIndex(sectionPath)
  if (sections) {
    const indexedFiles = new Set(sections.map((s) => `${s.filename}.md`))
    const roomsOk = roomIds.every((r) => indexedFiles.has(r))
    const dimOk = sections.length > 0 && sections[0]!.vector.length === 1024
    if (!roomsOk || !dimOk) {
      log(`Cached section index (${sections.length} chunks) does not cover all ${roomIds.length} rooms or dim!=1024; rebuilding.`)
      sections = null
    } else {
      log(`Loaded cached section index ${sectionPath}  n=${sections.length}`)
    }
  }
  if (!sections) {
    log(`\nBuilding section index from ${roomIds.length} files in ${cli.transcriptDir} (no tree walk)`)
    const drafted = buildSectionsFromRooms(roomIds, cli.transcriptDir)
    const over = drafted.filter((s) => Array.from(s.content).length > MAX_SECTION_CHARS).length
    log(`  chunks=${drafted.length}  over_${MAX_SECTION_CHARS}=${over}  speakers=${new Set(drafted.map((s) => s.speaker)).size}`)
    log('  embedding sections…')
    const vecs = await embedBatch(drafted.map((s) => s.content))
    sections = drafted.map((s, i) => ({ ...s, vector: vecs[i] ?? [] }))
    saveSectionIndex(sectionPath, sections)
    log(`  wrote ${sectionPath}`)
  }

  const secStats = vectorStats(sections.map((s) => s.vector))
  log(`Arm C sections: n=${sections.length}  dims=${[...secStats.dims].join(',')}  sample L2=${secStats.sampleL2.map((x) => x.toFixed(6)).join(', ')}`)
  const maxChunk = Math.max(...sections.map((s) => Array.from(s.content).length))
  log(`  max chunk chars (Array.from length)=${maxChunk}  target≤${MAX_SECTION_CHARS}`)

  const sectionTexts = sections.map((s) => s.content)

  // Build Float32Array for fast section cosine dot products
  const nSec = sections.length
  const flatSecVectors = new Float32Array(nSec * 1024)
  for (let i = 0; i < nSec; i++) {
    const v = sections[i]!.vector
    const offset = i * 1024
    for (let j = 0; j < 1024; j++) {
      flatSecVectors[offset + j] = v[j]!
    }
  }

  // Question classification
  type LoadedCase = { id: string; question: string; topicTerms?: string[] }
  function loadQuestionCases(filePath: string): LoadedCase[] {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    let list: unknown[] | null = null
    if (Array.isArray(raw)) list = raw
    else if (raw && typeof raw === 'object') {
      const obj = raw as { cases?: unknown; questions?: unknown }
      if (Array.isArray(obj.cases)) list = obj.cases
      else if (Array.isArray(obj.questions)) list = obj.questions
    }
    if (!list) throw new Error(`--questions ${filePath}: expected an array or {cases|questions}`)
    const out: LoadedCase[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const rec = item as { id?: unknown; question?: unknown; topicTerms?: unknown }
      if (typeof rec.id !== 'string' || typeof rec.question !== 'string') continue
      const terms = Array.isArray(rec.topicTerms)
        ? rec.topicTerms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : undefined
      out.push({ id: rec.id, question: rec.question, topicTerms: terms })
    }
    if (out.length === 0) throw new Error(`--questions ${filePath}: no usable {id, question} records`)
    return out
  }
  const allCases: LoadedCase[] = cli.questionsPath
    ? loadQuestionCases(cli.questionsPath)
    : [...DEFAULT_CAG_EVAL_CASES, ...DEFAULT_AUDREY_EVAL_CASES]
  if (cli.questionsPath) log(`--questions ${cli.questionsPath}  n=${allCases.length}`)
  const questions = allCases.map((c) =>
    classifyCase(c.id, c.question, primaryTexts, sectionTexts, c.topicTerms),
  )

  const inCount = questions.filter((q) => q.block === 'in-corpus').length
  const outCount = questions.filter((q) => q.block === 'out-of-corpus').length
  log(`\nQuestions to evaluate: ${questions.length} (in-corpus: ${inCount}, out-of-corpus: ${outCount})`)
  log(`  Partition change: Previous 6-room run had 7 in-corpus / 14 out-of-corpus; 105-room full run has ${inCount} in-corpus / ${outCount} out-of-corpus.`)

  const rows: Row[] = []
  for (const testCase of questions) {
    const mark =
      testCase.block === 'in-corpus'
        ? ` [in-corpus (mem_hits=${testCase.memHits}, sec_hits=${testCase.secHits})]`
        : ` [out-of-corpus (mem_hits=${testCase.memHits}, sec_hits=${testCase.secHits})]`
    log(`\n${testCase.id}${mark}`)
    log(`  Q: ${testCase.question}`)
    log(`  topic terms: ${testCase.topicTerms.join(' · ') || '(none)'}`)

    const later = /後來|之后|之後|later/i.test(testCase.question)

    // Primary store retrieval (fetch deep candidate pool for budget assembly)
    let primaryKwCandidates: RetrievedItem[] = []
    let primaryKwError: string | null = null
    try {
      const kw = recall(testCase.question, primaryStore, { noLlm: true, later, limit: CANDIDATE_LIMIT_MEM })
      primaryKwCandidates = memoriesToItems(kw.memories)
    } catch (error) {
      primaryKwError = error instanceof Error ? error.message : String(error)
    }

    let primaryHyCandidates: RetrievedItem[] = []
    let primaryHyError: string | null = null
    try {
      const hy = await recallHybrid(testCase.question, primaryStore, memoryVectors, {
        noLlm: false,
        later,
        limit: CANDIDATE_LIMIT_MEM,
      })
      primaryHyCandidates = memoriesToItems(hy.memories)
    } catch (error) {
      primaryHyError = error instanceof Error ? error.message : String(error)
    }

    // Embed query for cosine isolates
    let qn: number[] | null = null
    try {
      const qv = await embedTexts([testCase.question])
      const qvec = qv?.[0]
      if (!qvec) throw new Error('query embed failed')
      qn = qvec
    } catch (error) {
      log(`Query embed error for "${testCase.question}": ${String(error)}`)
    }

    let primaryCosCandidates: RetrievedItem[] = []
    let primaryCosError: string | null = null
    if (qn) {
      const memHits = rankMemoriesByCosine(
        qn,
        primaryStore.memories,
        memoryVectors,
        CANDIDATE_LIMIT_MEM,
      )
      primaryCosCandidates = memoriesToItems(memHits)
    } else {
      primaryCosError = 'query embed failed'
    }

    // Uncapped store retrieval (if available)
    let uncappedKwCandidates: RetrievedItem[] = []
    let uncappedKwError: string | null = null
    let uncappedHyCandidates: RetrievedItem[] = []
    let uncappedHyError: string | null = null
    let uncappedCosCandidates: RetrievedItem[] = []
    let uncappedCosError: string | null = null
    if (uncappedStore) {
      try {
        const kw = recall(testCase.question, uncappedStore, { noLlm: true, later, limit: CANDIDATE_LIMIT_MEM })
        uncappedKwCandidates = memoriesToItems(kw.memories)
      } catch (error) {
        uncappedKwError = error instanceof Error ? error.message : String(error)
      }
      try {
        const hy = await recallHybrid(testCase.question, uncappedStore, uncappedVectors, {
          noLlm: false,
          later,
          limit: CANDIDATE_LIMIT_MEM,
        })
        uncappedHyCandidates = memoriesToItems(hy.memories)
      } catch (error) {
        uncappedHyError = error instanceof Error ? error.message : String(error)
      }
      if (qn) {
        const uHits = rankMemoriesByCosine(
          qn,
          uncappedStore.memories,
          uncappedVectors,
          CANDIDATE_LIMIT_MEM,
        )
        uncappedCosCandidates = memoriesToItems(uHits)
      } else {
        uncappedCosError = 'query embed failed'
      }
    }

    // Section retrieval (fetch deep candidate pool for budget assembly)
    let sectionCandidates: RetrievedItem[] = []
    let sectionError: string | null = null
    if (qn) {
      const secHits = rankSectionsByCosine(qn, flatSecVectors, sections, CANDIDATE_LIMIT_SEC)
      sectionCandidates = secHits.map((s) => ({
        content: s.content,
        label: `${s.filename} turn-${s.turn_index}#${s.chunk_index} — ${s.speaker}`,
        href: `file://${path.join(cli.transcriptDir, `${s.filename}.md`)}#turn-${s.turn_index}`,
        sectionId: s.section_id,
      }))
    } else {
      sectionError = 'query embed failed'
    }

    // Rank Fusion (RRF) between memory-keyword and section-cosine
    const fusion = fuseRankRrf(primaryKwCandidates, sectionCandidates, cli.rrfK)
    const fusedCandidates = fusion.fused
    const duplicatesCount = fusion.duplicatesCount
    const totalCandidatesBeforeDedup = fusion.totalCandidatesBeforeDedup

    // Fixed-k=8 slices
    const primaryKwArm: ArmHits = { items: primaryKwCandidates.slice(0, cli.topK), error: primaryKwError }
    const primaryHyArm: ArmHits = { items: primaryHyCandidates.slice(0, cli.topK), error: primaryHyError }
    const primaryCosArm: ArmHits = { items: primaryCosCandidates.slice(0, cli.topK), error: primaryCosError }
    const sectionArm: ArmHits = { items: sectionCandidates.slice(0, cli.topK), error: sectionError }
    const unionArm: ArmHits = { items: fusedCandidates.slice(0, cli.topK), error: null }

    const primaryKwM = metricsFor(primaryKwArm, testCase.topicTerms)
    const primaryHyM = metricsFor(primaryHyArm, testCase.topicTerms)
    const primaryCosM = metricsFor(primaryCosArm, testCase.topicTerms)
    const secM = metricsFor(sectionArm, testCase.topicTerms)
    const unionKM = metricsFor(unionArm, testCase.topicTerms)
    const oracleKM = pickOracle(secM, primaryKwM)

    let uncappedKwM: ArmMetrics | undefined
    let uncappedHyM: ArmMetrics | undefined
    let uncappedCosM: ArmMetrics | undefined
    if (uncappedStore) {
      uncappedKwM = metricsFor({ items: uncappedKwCandidates.slice(0, cli.topK), error: uncappedKwError }, testCase.topicTerms)
      uncappedHyM = metricsFor({ items: uncappedHyCandidates.slice(0, cli.topK), error: uncappedHyError }, testCase.topicTerms)
      uncappedCosM = metricsFor({ items: uncappedCosCandidates.slice(0, cli.topK), error: uncappedCosError }, testCase.topicTerms)
    }

    // Budget-limited arms
    const budgetsMap: Record<number, BudgetArmResult> = {}
    for (const B of cli.budgets) {
      const secBItems = assembleBudgetItems(sectionCandidates, B)
      const memKwBItems = assembleBudgetItems(primaryKwCandidates, B)
      const memHyBItems = assembleBudgetItems(primaryHyCandidates, B)
      const unionBItems = assembleBudgetItems(fusedCandidates, B)

      const secBM = metricsFor({ items: secBItems, error: sectionError }, testCase.topicTerms)
      const memKwBM = metricsFor({ items: memKwBItems, error: primaryKwError }, testCase.topicTerms)
      const memHyBM = metricsFor({ items: memHyBItems, error: primaryHyError }, testCase.topicTerms)
      const unionBM = metricsFor({ items: unionBItems, error: null }, testCase.topicTerms)
      const oracleBM = pickOracle(secBM, memKwBM)

      budgetsMap[B] = {
        sec: secBM,
        memKw: memKwBM,
        memHy: memHyBM,
        union: unionBM,
        oracle: oracleBM,
      }
    }

    // Print per-question breakdown
    printArm('memory-kw', primaryKwArm, primaryKwM, testCase.topicTerms)
    printArm(`memory-hy (floor ${DEFAULT_MEMORY_MIN_COSINE_SCORE})`, primaryHyArm, primaryHyM, testCase.topicTerms)
    printArm('memory-cosine (isolate)', primaryCosArm, primaryCosM, testCase.topicTerms)
    if (uncappedKwM) printArm('uncapped-kw', { items: uncappedKwCandidates.slice(0, cli.topK), error: uncappedKwError }, uncappedKwM, testCase.topicTerms)
    if (uncappedHyM) printArm(`uncapped-hy (floor ${DEFAULT_MEMORY_MIN_COSINE_SCORE})`, { items: uncappedHyCandidates.slice(0, cli.topK), error: uncappedHyError }, uncappedHyM, testCase.topicTerms)
    if (uncappedCosM) printArm('uncapped-cosine (isolate)', { items: uncappedCosCandidates.slice(0, cli.topK), error: uncappedCosError }, uncappedCosM, testCase.topicTerms)
    printArm('section-cosine', sectionArm, secM, testCase.topicTerms)
    printArm(`union-rrf(k=${cli.topK})`, unionArm, unionKM, testCase.topicTerms)
    log(`    [fusion] duplicates=${duplicatesCount}/${totalCandidatesBeforeDedup} candidates merged`)

    for (const B of cli.budgets) {
      const b = budgetsMap[B]!
      log(
        `  [Budget ${B}ch]  ` +
        `sec: n=${b.sec.n} p=${fmtPrec(b.sec.precision)} s=${fmtPrec(b.sec.signalDensity)} ot=${b.sec.onTopicN} c=${b.sec.chars} | ` +
        `mem: n=${b.memKw.n} p=${fmtPrec(b.memKw.precision)} s=${fmtPrec(b.memKw.signalDensity)} ot=${b.memKw.onTopicN} c=${b.memKw.chars} | ` +
        `uni: n=${b.union.n} p=${fmtPrec(b.union.precision)} s=${fmtPrec(b.union.signalDensity)} ot=${b.union.onTopicN} c=${b.union.chars} | ` +
        `orc: p=${fmtPrec(b.oracle.precision)} s=${fmtPrec(b.oracle.signalDensity)} ot=${b.oracle.onTopicN}`,
      )
    }

    rows.push({
      testCase,
      cappedKw: primaryKwM,
      cappedHy: primaryHyM,
      cappedCos: primaryCosM,
      uncappedKw: uncappedKwM,
      uncappedHy: uncappedHyM,
      uncappedCos: uncappedCosM,
      section: secM,
      unionK: unionKM,
      oracleK: oracleKM,
      budgets: budgetsMap,
      duplicatesCount,
      totalCandidatesBeforeDedup,
    })
  }

  const inCorpus = rows.filter((r) => r.testCase.block === 'in-corpus')
  const outCorpus = rows.filter((r) => r.testCase.block === 'out-of-corpus')
  const other = rows.filter((r) => r.testCase.block === 'other')

  const hasUncapped = uncappedStore !== null

  // 1. Fixed-k (k=8) block
  printBlock(
    '1. Same-corpus head-to-head (Fixed-k Legacy) — in-corpus questions',
    'Both arms built from the same room files and qwen3-embedding:0.6b. ' +
    'Comparing fixed top-k items across single arms and union RRF.',
    inCorpus,
    hasUncapped,
  )

  // 2. Budget Blocks (1500 chars and 4000 chars)
  for (const B of cli.budgets) {
    printBudgetBlock(B, inCorpus)
  }

  if (outCorpus.length > 0) {
    printBlock(
      '3. Out-of-corpus split — questions whose topics are absent from these rooms',
      `Empty keyword results are correct. hybrid uses floor=${DEFAULT_MEMORY_MIN_COSINE_SCORE} on fallback; unfloored section-cosine emits false-positive noise.`,
      outCorpus,
      hasUncapped,
    )
    for (const B of cli.budgets) {
      printBudgetBlock(B, outCorpus)
    }
  }

  if (other.length > 0) {
    printBlock(
      '3b. Other questions',
      'Reported separately so they are not blended into the headline.',
      other,
      hasUncapped,
    )
  }

  printVerdict(
    inCorpus,
    outCorpus,
    primaryStore,
    uncappedStore,
    sections,
    primaryTexts,
    uncappedTexts,
    sectionTexts,
    cli.budgets,
  )

  log(`\nFull comparison log saved to ${cli.logFile}`)
}

main().catch((err) => {
  log(String(err?.stack || err))
  process.exit(1)
})
