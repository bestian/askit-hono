/**
 * Answer Quality Evaluation for CAG: Breaking Metric Circularity.
 *
 * Supports:
 *   1. Context Dump Mode (--dump-contexts <path>):
 *      Performs zero LLM calls. Assembles retrieval contexts across 3 arms
 *      (sections, memory-append, memory-content-only) at a fixed 1500-char budget
 *      for all 21 eval questions. Emits an arm-blind contexts JSON with opaque
 *      arm tokens and a separate <path>.key.json mapping tokens to raw arms.
 *      --quote-mode <append|content-only> (default append) is passed to
 *      memoriesToCagSources as { quoteMode } for the memory-append control arm.
 *
 *   2. Answer Scoring Mode (--score-answers <answers.json>):
 *      Performs offline, LLM-free evaluation of returned answers: citation validity
 *      parsing, hallucinated source rates, and scoreCagDepth (bigram grounding,
 *      answer length, shallow flags).
 *
 * Local only. No Cloudflare contacts.
 *
 * Usage:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/eval-answer-quality.ts \
 *     --dump-contexts local/cag-compare/eval-contexts.json
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/eval-answer-quality.ts \
 *     --score-answers local/cag-compare/answers.json \
 *     --key-file local/cag-compare/eval-contexts.json.key.json \
 *     --contexts-file local/cag-compare/eval-contexts.json
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { CagSource } from '../src/utils/cag'
import {
  DEFAULT_AUDREY_EVAL_CASES,
  DEFAULT_CAG_EVAL_CASES,
  scoreCagDepth,
  type CagDepthScore,
  type CagEvalCase,
} from '../src/utils/cagEval'
import {
  embedTexts,
  loadCagStore,
  LOCAL_EMBED_MODEL,
  LOCAL_EMBED_URL,
  memoriesToCagSources,
  mergeCagStores,
  recall,
  type CagMemory,
  type CagQuoteMode,
  type CagStore,
} from '../src/utils/cagMemories'

// ---------------------------------------------------------------------------
// Configuration & Topic Terms
// ---------------------------------------------------------------------------

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

type Cli = {
  stores: string[]
  sectionIndex: string
  dumpContextsPath: string | null
  scoreAnswersPath: string | null
  keyFilePath: string | null
  contextsFilePath: string | null
  logFile: string
  budgetChars: number
  topK: number
  rrfK: number
  embedUrl: string
  embedModel: string
  quoteMode: CagQuoteMode
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    stores: [],
    sectionIndex: path.resolve('local/cag-compare/sections-full.jsonl'),
    dumpContextsPath: null,
    scoreAnswersPath: null,
    keyFilePath: null,
    contextsFilePath: null,
    logFile: '/tmp/cag-answer-eval.log',
    budgetChars: 1500,
    topK: 8,
    rrfK: 60,
    embedUrl: LOCAL_EMBED_URL,
    embedModel: LOCAL_EMBED_MODEL,
    quoteMode: 'append',
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--store') {
      const dir = argv[++i]
      if (dir) cli.stores.push(path.resolve(dir))
    } else if (a === '--section-index') {
      cli.sectionIndex = path.resolve(argv[++i] ?? '')
    } else if (a === '--dump-contexts') {
      cli.dumpContextsPath = path.resolve(argv[++i] ?? '')
    } else if (a === '--score-answers') {
      cli.scoreAnswersPath = path.resolve(argv[++i] ?? '')
    } else if (a === '--key-file') {
      cli.keyFilePath = path.resolve(argv[++i] ?? '')
    } else if (a === '--contexts-file') {
      cli.contextsFilePath = path.resolve(argv[++i] ?? '')
    } else if (a === '--log') {
      cli.logFile = argv[++i] ?? cli.logFile
    } else if (a === '--budget') {
      cli.budgetChars = parseInt(argv[++i] ?? '1500', 10)
    } else if (a === '--top-k') {
      cli.topK = parseInt(argv[++i] ?? '8', 10)
    } else if (a === '--rrf-k') {
      cli.rrfK = parseInt(argv[++i] ?? '60', 10)
    } else if (a === '--quote-mode') {
      const raw = argv[++i] ?? 'append'
      if (raw !== 'append' && raw !== 'content-only') {
        throw new Error(`--quote-mode must be append or content-only, got: ${raw}`)
      }
      cli.quoteMode = raw
    }
  }

  if (cli.stores.length === 0) {
    const defaultTmp = path.resolve('/tmp/cag-memories-full105')
    if (existsSync(defaultTmp)) {
      cli.stores.push(defaultTmp)
    } else {
      cli.stores.push(path.resolve('local/cag-memories'))
    }
  }

  return cli
}

let activeLogFile: string = '/tmp/cag-answer-eval.log'

function log(msg: string): void {
  console.log(msg)
  try {
    appendFileSync(activeLogFile, `${msg}\n`, 'utf8')
  } catch {
    // Ignore log file write errors
  }
}

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

type RetrievedItem = {
  content: string
  label: string
  href: string
  sectionId: number | null
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

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

export type DumpContextItem = {
  questionId: string
  question: string
  topicTerms: string[]
  armToken: string
  charsUsed: number
  itemCount: number
  items: RetrievedItem[]
  messages: ChatMessage[]
}

export type ArmKeyMap = Record<
  string,
  {
    armToken: string
    arm: 'sections' | 'memory' | 'union' | 'memory-append' | 'memory-content-only'
    questionId: string
    charsUsed: number
    itemCount: number
  }
>

type CitationStats = {
  totalCitations: number
  validCitations: number
  hallucinatedCitations: number
  validRate: number
  hallucinatedRate: number
  allValid: boolean
  citedIndices: number[]
}

// ---------------------------------------------------------------------------
// Formatting & Prompt Construction (Local copy of buildCagMessages)
// ---------------------------------------------------------------------------

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

function buildCagMessages(
  question: string,
  sources: CagSource[],
  background: CagSource[] = [],
  answerInstruction = 'Answer concisely. Prefer exact wording from the excerpts where useful.',
  answerLanguage?: 'en',
): ChatMessage[] {
  const lore = sources
    .map((source, index) =>
      sourceBlock(source, {
        id: index + 1,
        tag: 'source',
      }),
    )
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

// ---------------------------------------------------------------------------
// Section & Memory Index Loading & Retrieval
// ---------------------------------------------------------------------------

function loadSectionIndex(filePath: string): SectionRec[] {
  if (!existsSync(filePath)) {
    throw new Error(`Section index not found: ${filePath}`)
  }
  const lines = readFileSync(filePath, 'utf8').split('\n')
  const sections: SectionRec[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as SectionRec
      if (rec.content && Array.isArray(rec.vector)) {
        sections.push(rec)
      }
    } catch {
      // skip corrupted line
    }
  }
  return sections
}

function memoryToItem(mem: CagMemory, titleByRoom: Record<string, string>): RetrievedItem {
  const speaker = mem.evidence[0]?.speaker ?? ''
  const turn = mem.evidence[0]?.turnIndex ?? 0
  const quotes = mem.evidence.map((e) => e.quote).filter(Boolean).join(' / ')
  const rawTitle = titleByRoom[mem.roomId] ?? mem.roomId.replace(/\.md$/, '')
  const title =
    rawTitle.startsWith(`${mem.roomDate} `) || rawTitle.startsWith(`${mem.roomDate}-`)
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

function memoryArmItems(memories: CagMemory[], quoteMode: CagQuoteMode): RetrievedItem[] {
  const items: RetrievedItem[] = []
  for (const mem of memories) {
    const { cited, background } = memoriesToCagSources([mem], {}, { quoteMode })
    for (const src of [...cited, ...background]) {
      items.push({
        content: src.content,
        label: src.label,
        href: src.href,
        sectionId: src.sectionId,
      })
    }
  }
  return items
}

function rankSectionsByCosine(
  queryVector: number[],
  flatSecVectors: Float32Array,
  sections: SectionRec[],
  topK: number,
): SectionRec[] {
  const n = sections.length
  const scores = new Float32Array(n)
  const q = new Float32Array(queryVector)

  for (let i = 0; i < n; i++) {
    const offset = i * 1024
    let dot = 0
    for (let j = 0; j < 1024; j++) {
      dot += q[j]! * flatSecVectors[offset + j]!
    }
    scores[i] = dot
  }

  const indices = new Int32Array(n)
  for (let i = 0; i < n; i++) indices[i] = i
  indices.sort((a, b) => scores[b]! - scores[a]!)

  const result: SectionRec[] = []
  const limit = Math.min(topK, n)
  for (let i = 0; i < limit; i++) {
    result.push(sections[indices[i]!]!)
  }
  return result
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

function extractSourceFilename(item: RetrievedItem): string {
  const raw = item.href.split('#')[0] ?? ''
  const base = path.basename(raw)
  return base.replace(/\.md$/i, '')
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

function preferRepresentation(
  itemA: RetrievedItem,
  itemB: RetrievedItem,
): { kept: RetrievedItem; dropped: RetrievedItem } {
  const aHasProv = itemA.sectionId !== null
  const bHasProv = itemB.sectionId !== null
  if (aHasProv && !bHasProv) return { kept: itemA, dropped: itemB }
  if (bHasProv && !aHasProv) return { kept: itemB, dropped: itemA }

  if (itemA.content.length <= itemB.content.length) {
    return { kept: itemA, dropped: itemB }
  } else {
    return { kept: itemB, dropped: itemA }
  }
}

function fuseRankRrf(
  memItems: RetrievedItem[],
  secItems: RetrievedItem[],
  rrfK = 60,
): RetrievedItem[] {
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

  const details = entries.map((e) => {
    let rrfScore = 0
    if (e.memRank !== null) rrfScore += 1 / (rrfK + e.memRank)
    if (e.secRank !== null) rrfScore += 1 / (rrfK + e.secRank)
    return {
      item: e.item,
      rrfScore,
    }
  })

  details.sort((a, b) => b.rrfScore - a.rrfScore)
  return details.map((d) => d.item)
}

function assembleBudgetSources(
  items: RetrievedItem[],
  budgetChars: number,
): { sources: CagSource[]; items: RetrievedItem[]; charsUsed: number } {
  const keptSources: CagSource[] = []
  const keptItems: RetrievedItem[] = []
  let usedChars = 0

  for (const item of items) {
    const plain = htmlToPlainText(item.content)
    const len = plain.length
    if (usedChars + len <= budgetChars || keptSources.length === 0) {
      keptSources.push({
        content: item.content,
        href: item.href,
        label: item.label,
        sectionId: item.sectionId,
      })
      keptItems.push(item)
      usedChars += len
      if (usedChars >= budgetChars) break
    }
  }

  return { sources: keptSources, items: keptItems, charsUsed: usedChars }
}

// ---------------------------------------------------------------------------
// Citation & Groundedness Scoring (Pure Local / LLM-free)
// ---------------------------------------------------------------------------

function parseCitations(answer: string, sourceCount: number): CitationStats {
  const regex = /\[\^?(\d{1,2}(?:\s*,\s*\^?\d{1,2})*)\]/g
  const citedIndices: number[] = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(answer)) !== null) {
    const inner = match[1] ?? ''
    const parts = inner.split(',')
    for (const p of parts) {
      const numStr = p.replace(/[^\d]/g, '').trim()
      if (numStr) {
        const idx = parseInt(numStr, 10)
        if (Number.isFinite(idx)) citedIndices.push(idx)
      }
    }
  }

  const totalCitations = citedIndices.length
  if (totalCitations === 0) {
    return {
      totalCitations: 0,
      validCitations: 0,
      hallucinatedCitations: 0,
      validRate: 1.0,
      hallucinatedRate: 0.0,
      allValid: true,
      citedIndices: [],
    }
  }

  let validCount = 0
  let hallucinatedCount = 0
  for (const idx of citedIndices) {
    if (idx >= 1 && idx <= sourceCount) {
      validCount++
    } else {
      hallucinatedCount++
    }
  }

  const validRate = totalCitations > 0 ? validCount / totalCitations : 1.0
  const hallucinatedRate = totalCitations > 0 ? hallucinatedCount / totalCitations : 0.0
  const allValid = hallucinatedCount === 0

  return {
    totalCitations,
    validCitations: validCount,
    hallucinatedCitations: hallucinatedCount,
    validRate,
    hallucinatedRate,
    allValid,
    citedIndices,
  }
}

// ---------------------------------------------------------------------------
// Mode 1: Contexts Dump Routine
// ---------------------------------------------------------------------------

async function runDumpContexts(cli: Cli, dumpPath: string): Promise<void> {
  const keyPath = cli.keyFilePath || `${dumpPath}.key.json`

  log('================================================================================')
  log('CAG Contexts Dump (Fixed 1500-Character Budget Assembly)')
  log('================================================================================')
  log(`Stores: ${cli.stores.join(', ')}`)
  log(`Section index: ${cli.sectionIndex}`)
  log(`Budget: ${cli.budgetChars} characters`)
  log(`Quote mode (memory-append control): ${cli.quoteMode}`)
  log(`Output Contexts JSON: ${dumpPath}`)
  log(`Output Key Map JSON:  ${keyPath}`)
  log('--------------------------------------------------------------------------------\n')

  log('Step 1: Loading Memory Store and Section Index...')
  const primaryStore = mergeCagStores(cli.stores.map((s) => loadCagStore(s)))
  log(`  Loaded memory store: ${primaryStore.memories.length} memories, ${primaryStore.links.length} links`)

  const sections = loadSectionIndex(cli.sectionIndex)
  log(`  Loaded section index: ${sections.length} sections`)

  const nSec = sections.length
  const flatSecVectors = new Float32Array(nSec * 1024)
  for (let i = 0; i < nSec; i++) {
    const v = sections[i]!.vector
    const offset = i * 1024
    for (let j = 0; j < 1024; j++) {
      flatSecVectors[offset + j] = v[j]!
    }
  }

  const allCases: CagEvalCase[] = [...DEFAULT_CAG_EVAL_CASES, ...DEFAULT_AUDREY_EVAL_CASES]
  log(`\nAssembling contexts for ${allCases.length} questions across 3 arms (total = ${allCases.length * 3} contexts)...`)

  const dumpItems: DumpContextItem[] = []
  const keyMap: ArmKeyMap = {}

  type DumpArm = 'sections' | 'memory-append' | 'memory-content-only'
  type ArmStat = { counts: number[]; itemChars: number[]; zeroQuestions: string[] }
  const stats: Record<DumpArm, ArmStat> = {
    sections: { counts: [], itemChars: [], zeroQuestions: [] },
    'memory-append': { counts: [], itemChars: [], zeroQuestions: [] },
    'memory-content-only': { counts: [], itemChars: [], zeroQuestions: [] },
  }

  for (const [qIdx, testCase] of allCases.entries()) {
    const topicTerms = TOPIC_TERMS[testCase.id] ?? []
    const later = /後來|之后|之後|later/i.test(testCase.question)

    let qVec: number[] | null = null
    try {
      const embs = await embedTexts([testCase.question])
      qVec = embs?.[0] ?? null
    } catch (err) {
      log(`  Query embedding error for ${testCase.id}: ${String(err)}`)
    }

    // 1. Sections-only Candidates
    let secCandidates: RetrievedItem[] = []
    if (qVec) {
      const topSecs = rankSectionsByCosine(qVec, flatSecVectors, sections, 100)
      secCandidates = topSecs.map((s) => ({
        content: s.content,
        label: `${s.filename} turn-${s.turn_index}#${s.chunk_index} — ${s.speaker}`,
        href: `file://${s.filename}.md#turn-${s.turn_index}`,
        sectionId: s.section_id,
      }))
    }

    // 2. Memory-keyword Candidates (quoteMode threaded into memoriesToCagSources)
    let recalled: CagMemory[] = []
    try {
      const kw = recall(testCase.question, primaryStore, { noLlm: true, later, limit: 60 })
      recalled = kw.memories
    } catch (err) {
      log(`  Memory recall error for ${testCase.id}: ${String(err)}`)
    }
    const memAppendCandidates = memoryArmItems(recalled, cli.quoteMode)
    const memContentOnlyCandidates = memoryArmItems(recalled, 'content-only')

    // Assemble budgets
    const secPack = assembleBudgetSources(secCandidates, cli.budgetChars)
    const memAppendPack = assembleBudgetSources(memAppendCandidates, cli.budgetChars)
    const memContentOnlyPack = assembleBudgetSources(memContentOnlyCandidates, cli.budgetChars)

    const armPacks: Array<{ arm: DumpArm; pack: typeof secPack }> = [
      { arm: 'sections', pack: secPack },
      { arm: 'memory-append', pack: memAppendPack },
      { arm: 'memory-content-only', pack: memContentOnlyPack },
    ]

    for (const { arm, pack } of armPacks) {
      const armToken = `arm_${randomBytes(8).toString('hex')}`
      const messages = buildCagMessages(
        testCase.question,
        pack.sources,
        [],
        'Answer concisely. Prefer exact wording from the excerpts where useful.',
        testCase.requireTraditionalChinese ? undefined : 'en',
      )

      dumpItems.push({
        questionId: testCase.id,
        question: testCase.question,
        topicTerms,
        armToken,
        charsUsed: pack.charsUsed,
        itemCount: pack.items.length,
        items: pack.items,
        messages,
      })

      keyMap[armToken] = {
        armToken,
        arm,
        questionId: testCase.id,
        charsUsed: pack.charsUsed,
        itemCount: pack.items.length,
      }

      stats[arm].counts.push(pack.items.length)
      for (const item of pack.items) {
        stats[arm].itemChars.push(htmlToPlainText(item.content).length)
      }
      if (pack.items.length === 0) stats[arm].zeroQuestions.push(testCase.id)
    }
  }

  // Write dump file and key file
  writeFileSync(dumpPath, JSON.stringify(dumpItems, null, 2), 'utf8')
  writeFileSync(keyPath, JSON.stringify(keyMap, null, 2), 'utf8')

  log(`\nSuccessfully wrote ${dumpItems.length} context items to: ${dumpPath}`)
  log(`Successfully wrote key map to: ${keyPath}\n`)

  log('================================================================================')
  log('CONTEXT RETRIEVAL ASSEMBLY SUMMARY (BUDGET <= 1500 CHARACTERS)')
  log('================================================================================')
  log('Arm                  MeanItems  MinItems  MaxItems  MeanChars/Item  ZeroItemQuestions')

  for (const arm of ['sections', 'memory-append', 'memory-content-only'] as const) {
    const s = stats[arm]
    const meanItems = s.counts.reduce((a, b) => a + b, 0) / s.counts.length
    const minItems = Math.min(...s.counts)
    const maxItems = Math.max(...s.counts)
    const meanCharsPerItem = s.itemChars.length === 0
      ? 0
      : s.itemChars.reduce((a, b) => a + b, 0) / s.itemChars.length
    const zeros = s.zeroQuestions.length === 0 ? 'none' : s.zeroQuestions.join(',')

    log(
      `${arm.padEnd(22)}` +
      `${meanItems.toFixed(1).padStart(9)}  ` +
      `${minItems.toString().padStart(8)}  ` +
      `${maxItems.toString().padStart(8)}  ` +
      `${meanCharsPerItem.toFixed(1).padStart(14)}  ` +
      zeros,
    )
  }
  log('--------------------------------------------------------------------------------')
}

// ---------------------------------------------------------------------------
// Mode 2: Score Answers Routine
// ---------------------------------------------------------------------------

async function runScoreAnswers(cli: Cli, answersPath: string): Promise<void> {
  if (!existsSync(answersPath)) {
    throw new Error(`Answers file not found: ${answersPath}`)
  }

  const rawAnswers = JSON.parse(readFileSync(answersPath, 'utf8')) as unknown
  let keyMap: ArmKeyMap | null = null
  const keyPath = cli.keyFilePath || `${answersPath}.key.json`
  if (existsSync(keyPath)) {
    keyMap = JSON.parse(readFileSync(keyPath, 'utf8')) as ArmKeyMap
  }

  let contextsMap: Record<string, DumpContextItem> = {}
  const contextsPath = cli.contextsFilePath || path.resolve('local/cag-compare/eval-contexts.json')
  if (existsSync(contextsPath)) {
    const rawContexts = JSON.parse(readFileSync(contextsPath, 'utf8')) as DumpContextItem[]
    for (const ctx of rawContexts) {
      contextsMap[ctx.armToken] = ctx
    }
  }

  type ParsedAnswerRecord = {
    armToken?: string
    arm?: 'sections' | 'memory' | 'union'
    questionId: string
    answer: string
    sources: CagSource[]
  }

  const parsedList: ParsedAnswerRecord[] = []

  if (Array.isArray(rawAnswers)) {
    for (const item of rawAnswers) {
      const armToken = item.armToken
      const keyEntry = armToken && keyMap ? keyMap[armToken] : undefined
      const arm = item.arm || keyEntry?.arm
      const questionId = item.questionId || keyEntry?.questionId
      const ctx = armToken ? contextsMap[armToken] : undefined
      const sources: CagSource[] = ctx?.items.map((it) => ({
        content: it.content,
        href: it.href,
        label: it.label,
        sectionId: it.sectionId,
      })) ?? []

      if (arm && questionId && item.answer) {
        parsedList.push({
          armToken,
          arm,
          questionId,
          answer: item.answer,
          sources,
        })
      }
    }
  }

  log('================================================================================')
  log('CAG Offline Answer Scoring Report')
  log('================================================================================')
  log(`Answers file: ${answersPath} (${parsedList.length} answers parsed)`)
  log('--------------------------------------------------------------------------------\n')

  log('1. CITATION VALIDITY & HALLUCINATION RATES')
  log('--------------------------------------------------------------------------------')
  log('Arm       TotalCites  ValidCites  Hallucinated  ValidRate  HallucinatedRate  AllValidAnswers')

  for (const arm of ['sections', 'memory', 'union'] as const) {
    const records = parsedList.filter((r) => r.arm === arm)
    let totalCites = 0
    let validCites = 0
    let hallCites = 0
    let allValidCount = 0

    for (const r of records) {
      const stats = parseCitations(r.answer, r.sources.length)
      totalCites += stats.totalCitations
      validCites += stats.validCitations
      hallCites += stats.hallucinatedCitations
      if (stats.allValid) allValidCount++
    }

    const validRate = totalCites > 0 ? validCites / totalCites : 1.0
    const hallRate = totalCites > 0 ? hallCites / totalCites : 0.0
    const allValidPct = records.length > 0 ? (allValidCount / records.length) * 100 : 0

    log(
      `${arm.padEnd(10)}` +
      `${totalCites.toString().padStart(10)}  ` +
      `${validCites.toString().padStart(10)}  ` +
      `${hallCites.toString().padStart(12)}  ` +
      `${(validRate * 100).toFixed(1).padStart(8)}%  ` +
      `${(hallRate * 100).toFixed(1).padStart(16)}%  ` +
      `${allValidCount}/${records.length} (${allValidPct.toFixed(1)}%)`.padStart(15),
    )
  }

  log('\n2. GROUNDEDNESS & DEPTH METRICS (scoreCagDepth Means)')
  log('--------------------------------------------------------------------------------')
  log('Arm       MeanAnsChars  MeanSrcChars  MeanGrounding  ShallowCount  ShallowRate')

  for (const arm of ['sections', 'memory', 'union'] as const) {
    const records = parsedList.filter((r) => r.arm === arm)
    let totalAnsChars = 0
    let totalSrcChars = 0
    let totalGrounding = 0
    let shallowCount = 0

    for (const r of records) {
      const cStats = parseCitations(r.answer, r.sources.length)
      const depth = scoreCagDepth(
        r.answer,
        r.sources.map((s) => ({ content: s.content })),
        cStats.citedIndices.filter((idx) => idx >= 1 && idx <= r.sources.length),
      )
      totalAnsChars += depth.answerChars
      totalSrcChars += depth.totalSourceChars
      totalGrounding += depth.groundingScore
      if (depth.shallow) shallowCount++
    }

    const count = records.length || 1
    const meanAns = totalAnsChars / count
    const meanSrc = totalSrcChars / count
    const meanGrounding = totalGrounding / count
    const shallowRate = (shallowCount / count) * 100

    log(
      `${arm.padEnd(10)}` +
      `${meanAns.toFixed(1).padStart(12)}  ` +
      `${meanSrc.toFixed(1).padStart(12)}  ` +
      `${meanGrounding.toFixed(3).padStart(13)}  ` +
      `${shallowCount.toString().padStart(12)}  ` +
      `${shallowRate.toFixed(1).padStart(10)}%`,
    )
  }
}

// ---------------------------------------------------------------------------
// Main Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  activeLogFile = cli.logFile

  if (cli.dumpContextsPath) {
    await runDumpContexts(cli, cli.dumpContextsPath)
    return
  }

  if (cli.scoreAnswersPath) {
    await runScoreAnswers(cli, cli.scoreAnswersPath)
    return
  }

  // Default: Dump contexts to local/cag-compare/eval-contexts.json
  const defaultDump = path.resolve('local/cag-compare/eval-contexts.json')
  await runDumpContexts(cli, defaultDump)
}

main().catch((err) => {
  log(`\nFatal error: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
