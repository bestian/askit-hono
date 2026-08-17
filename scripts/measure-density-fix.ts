/**
 * Structural density of packed CAG sources at a 1500-char budget.
 *
 * Reports item count / chars-per-item / distinct ids only.
 * Does not score answers and does not claim quality improvement.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/measure-density-fix.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_AUDREY_EVAL_CASES, DEFAULT_CAG_EVAL_CASES } from '../src/utils/cagEval'
import {
  collapseBrAndWsText,
  embedTexts,
  htmlToPlainText,
  loadCagStore,
  memoriesToCagSources,
  recall,
  type CagMemory,
  type CagQuoteMode,
  type CagStore,
} from '../src/utils/cagMemories'

const STORE_DIR = '/tmp/cag-memories-full105'
const SECTION_INDEX = path.resolve('local/cag-compare/sections-full.jsonl')
const BUDGET_CHARS = 1500
const RECALL_LIMIT = 60
const SECTION_CANDIDATE_LIMIT = 100

type SectionRec = {
  section_id: number
  filename: string
  content: string
  vector: number[]
}

type PackedStats = {
  items: number
  chars: number
  charsPerItem: number | null
  distinctIds: number
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function packedChars(text: string): number {
  return htmlToPlainText(text).length
}

function packTexts(
  items: { text: string; id: string }[],
  budgetChars: number,
): PackedStats {
  const kept: { text: string; id: string }[] = []
  let used = 0
  for (const item of items) {
    const len = packedChars(item.text)
    if (len <= 0) continue
    if (used + len > budgetChars) continue
    kept.push(item)
    used += len
  }
  return {
    items: kept.length,
    chars: used,
    charsPerItem: kept.length === 0 ? null : used / kept.length,
    distinctIds: new Set(kept.map((k) => k.id)).size,
  }
}

function assembleMemoryItems(memories: CagMemory[], quoteMode: CagQuoteMode): { text: string; id: string }[] {
  return memories.map((mem) => {
    const { cited, background } = memoriesToCagSources([mem], {}, { quoteMode })
    const src = cited[0] ?? background[0]
    return { text: src?.content ?? mem.content, id: mem.id }
  })
}

function loadSections(filePath: string): SectionRec[] {
  if (!existsSync(filePath)) throw new Error(`missing section index: ${filePath}`)
  const rows: SectionRec[] = []
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as SectionRec
    if (!rec.content || !Array.isArray(rec.vector)) continue
    rows.push(rec)
  }
  return rows
}

function rankSectionsByCosine(
  query: number[],
  sections: SectionRec[],
  topK: number,
): SectionRec[] {
  const scored: { rec: SectionRec; score: number }[] = []
  for (const rec of sections) {
    const v = rec.vector
    if (v.length !== query.length) continue
    let sum = 0
    for (let i = 0; i < query.length; i++) sum += (query[i] ?? 0) * (v[i] ?? 0)
    scored.push({ rec, score: sum })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map((s) => s.rec)
}

function firstNonEmptyQuote(mem: CagMemory): string {
  return mem.evidence.map((e) => e.quote).find((q) => q && q.trim()) ?? ''
}

function quoteIsSubstringOfContent(quote: string, content: string): boolean {
  const q = collapseBrAndWsText(quote)
  if (!q) return false
  return collapseBrAndWsText(content).includes(q)
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

function preview(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

function printArm(name: string, rows: PackedStats[]): void {
  const items = mean(rows.map((r) => r.items))
  const charsPerItem = mean(rows.filter((r) => r.charsPerItem !== null).map((r) => r.charsPerItem as number))
  const distinct = mean(rows.map((r) => r.distinctIds))
  console.log(
    `${name.padEnd(16)}  mean_items=${fmt(items)}  mean_chars/item=${fmt(charsPerItem)}  mean_distinct_ids=${fmt(distinct)}`,
  )
}

async function main(): Promise<void> {
  const store: CagStore = loadCagStore(STORE_DIR)
  const questions = [...DEFAULT_CAG_EVAL_CASES, ...DEFAULT_AUDREY_EVAL_CASES]
  const sections = loadSections(SECTION_INDEX)

  console.log(`store=${STORE_DIR}  memories=${store.memories.length}  links=${store.links.length}`)
  console.log(`sections=${SECTION_INDEX}  n=${sections.length}`)
  console.log(`questions=${questions.length}  recall={ noLlm: true, limit: ${RECALL_LIMIT} }  budget=${BUDGET_CHARS}`)
  console.log('This script reports packed-context DENSITY only. It does not judge answer quality.\n')

  const nMem = store.memories.length
  let substringMemories = 0
  const lost: { roomId: string; phase: string; quote: string; content: string }[] = []
  for (const mem of store.memories) {
    const quote = firstNonEmptyQuote(mem)
    if (quote && quoteIsSubstringOfContent(quote, mem.content)) {
      substringMemories++
    } else {
      lost.push({ roomId: mem.roomId, phase: mem.phase, quote, content: mem.content })
    }
  }
  const share = nMem === 0 ? 0 : substringMemories / nMem
  console.log('--- Redundancy (quote ⊆ content after <br> + whitespace collapse) ---')
  console.log(
    `substring=${substringMemories}/${nMem}  share=${(share * 100).toFixed(1)}%`,
  )

  const lostQuoteLens = lost.map((row) => row.quote.length)
  const meanLostQuote = mean(lostQuoteLens)
  console.log('\n--- Information lost under content-only (quote is NOT a substring of content) ---')
  const lostObserver = lost.filter((row) => row.phase === 'observer').length
  const lostRooms = new Set(lost.map((row) => row.roomId)).size
  console.log(`non_substring=${lost.length}  mean_quote_len=${fmt(meanLostQuote, 1)}  observer=${lostObserver}  audrey=${lost.length - lostObserver}  distinct_rooms=${lostRooms}`)
  for (const row of lost.slice(0, 3)) {
    console.log(`  roomId=${row.roomId}`)
    console.log(`    quote: ${preview(row.quote, 120)}`)
    console.log(`    content: ${preview(row.content, 120)}`)
  }

  const appendRows: PackedStats[] = []
  const contentOnlyRows: PackedStats[] = []
  const sectionRows: PackedStats[] = []

  for (const testCase of questions) {
    const hit = recall(testCase.question, store, { noLlm: true, limit: RECALL_LIMIT })
    appendRows.push(packTexts(assembleMemoryItems(hit.memories, 'append'), BUDGET_CHARS))
    contentOnlyRows.push(packTexts(assembleMemoryItems(hit.memories, 'content-only'), BUDGET_CHARS))

    const qv = await embedTexts([testCase.question])
    const qvec = qv?.[0]
    if (!qvec) throw new Error(`query embed failed for ${testCase.id}`)
    const ranked = rankSectionsByCosine(qvec, sections, SECTION_CANDIDATE_LIMIT)
    sectionRows.push(
      packTexts(
        ranked.map((s) => ({ text: s.content, id: String(s.section_id) })),
        BUDGET_CHARS,
      ),
    )
  }

  console.log(`\n--- Packed density @ ${BUDGET_CHARS} chars (means over ${questions.length} questions) ---`)
  console.log('mode              mean items packed    mean chars/item    mean distinct ids')
  const line = (name: string, rows: PackedStats[]) => {
    const items = mean(rows.map((r) => r.items))
    const cpi = mean(rows.filter((r) => r.charsPerItem !== null).map((r) => r.charsPerItem as number))
    const ids = mean(rows.map((r) => r.distinctIds))
    console.log(
      `${name.padEnd(16)}  ${fmt(items).padStart(18)}  ${fmt(cpi).padStart(16)}  ${fmt(ids).padStart(18)}`,
    )
  }
  line('append', appendRows)
  line('content-only', contentOnlyRows)
  line('sections', sectionRows)
  console.log('')
  printArm('append', appendRows)
  printArm('content-only', contentOnlyRows)
  printArm('sections', sectionRows)
  console.log('\nDensity only. No answer-quality claim.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
