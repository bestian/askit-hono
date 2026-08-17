/**
 * Honest-abstention measurement: out-of-archive questions vs claim-index
 * and local section cosine. Local only. No Cloudflare.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/measure-abstention.ts \
 *     --store /tmp/cag-memories-full105 \
 *     --section-index local/cag-compare/sections-full.jsonl \
 *     --questions local/cag-compare/abstention-questions.json
 *
 * Does not value-import src/utils/cag.ts. Does not rewrite stores.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_MEMORY_MIN_COSINE_SCORE,
  embedTexts,
  loadCagStore,
  loadEmbeddingsJsonl,
  LOCAL_EMBED_MODEL,
  LOCAL_EMBED_URL,
  recall,
  recallHybrid,
  type CagMemory,
  type CagStore,
} from '../src/utils/cagMemories'

/** Production Vectorize floor (`DEFAULT_VECTORIZE_MIN_COSINE_SCORE` in vectorize.ts). */
const DEFAULT_VECTORIZE_MIN_COSINE_SCORE = 0.45
const DEFAULT_TOP_K = 8
const DIM = 1024

type TermEvidence = {
  term: string
  substringCount: number
  filesHit: number | null
  nFilesScanned: number
}

type QuestionRec = {
  id: string
  kind: 'out-of-archive' | 'control'
  question: string
  absentTerms: string[]
  presentTerms?: string[]
  termEvidence: TermEvidence[]
}

type QuestionFile = {
  corpus: { dir: string; glob: string; nFiles: number }
  questions: QuestionRec[]
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

type ArmName =
  | 'memory-keyword'
  | 'memory-hybrid'
  | 'memory-cosine'
  | 'section-cosine-floor'
  | 'section-cosine-unfloored'

type ArmResult = {
  n: number
  abstain: boolean
  topScore: number | null
  error: string | null
}

function parseArgs(argv: string[]) {
  let store = '/tmp/cag-memories-full105'
  let sectionIndex = path.resolve('local/cag-compare/sections-full.jsonl')
  let questions = path.resolve('local/cag-compare/abstention-questions.json')
  let topK = DEFAULT_TOP_K
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const n = argv[i + 1]
    if (a === '--store' && n) { store = n; i++ }
    else if (a === '--section-index' && n) { sectionIndex = path.resolve(n); i++ }
    else if (a === '--questions' && n) { questions = path.resolve(n); i++ }
    else if (a === '--top-k' && n) { topK = Number(n); i++ }
  }
  return { store, sectionIndex, questions, topK }
}

function loadSectionIndex(outPath: string): SectionRec[] {
  if (!existsSync(outPath)) throw new Error(`missing section index: ${outPath}`)
  const rows: SectionRec[] = []
  for (const line of readFileSync(outPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as SectionRec
    if (!rec.content || !Array.isArray(rec.vector)) {
      throw new Error(`malformed section row in ${outPath}`)
    }
    rows.push(rec)
  }
  return rows
}

function flattenSectionVectors(sections: SectionRec[]): Float32Array {
  const flat = new Float32Array(sections.length * DIM)
  for (let i = 0; i < sections.length; i++) {
    const v = sections[i]!.vector
    const offset = i * DIM
    for (let j = 0; j < DIM; j++) flat[offset + j] = v[j]!
  }
  return flat
}

function rankMemoryCosine(
  query: number[],
  memories: CagMemory[],
  embeddings: Map<string, number[]>,
  topK: number,
  minScore: number | null,
): { n: number; topScore: number | null } {
  const q = new Float32Array(query)
  const scores: number[] = []
  for (const m of memories) {
    const v = embeddings.get(m.id)
    if (!v || v.length !== DIM) continue
    let sum = 0
    for (let j = 0; j < DIM; j++) sum += q[j]! * v[j]!
    if (minScore !== null && sum < minScore) continue
    scores.push(sum)
  }
  scores.sort((a, b) => b - a)
  const kept = scores.slice(0, topK)
  return { n: kept.length, topScore: kept[0] ?? null }
}

function rankSectionCosine(
  query: number[],
  flat: Float32Array,
  nSec: number,
  topK: number,
  minScore: number | null,
): { n: number; topScore: number | null } {
  const q = new Float32Array(query)
  const scores: number[] = []
  for (let i = 0; i < nSec; i++) {
    let sum = 0
    const offset = i * DIM
    for (let j = 0; j < DIM; j++) sum += q[j]! * flat[offset + j]!
    if (minScore !== null && sum < minScore) continue
    scores.push(sum)
  }
  scores.sort((a, b) => b - a)
  const kept = scores.slice(0, topK)
  return { n: kept.length, topScore: kept[0] ?? null }
}

function fmtRate(num: number, den: number): string {
  if (den === 0) return 'n/a'
  return `${(num / den).toFixed(3)} (${num}/${den})`
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const qFile = JSON.parse(readFileSync(cli.questions, 'utf8')) as QuestionFile
  const outQs = qFile.questions.filter((q) => q.kind === 'out-of-archive')
  const ctlQs = qFile.questions.filter((q) => q.kind === 'control')
  if (outQs.length !== 15) {
    console.error(`expected 15 out-of-archive questions, got ${outQs.length}`)
  }

  const store: CagStore = loadCagStore(cli.store)
  const embeddings = loadEmbeddingsJsonl(cli.store)
  console.log(`store ${cli.store}`)
  console.log(`  memories=${store.memories.length} links=${store.links.length} embeddings=${embeddings.size}`)
  console.log(`embedder ${LOCAL_EMBED_MODEL} via ${LOCAL_EMBED_URL}`)
  console.log(`hybrid floor DEFAULT_MEMORY_MIN_COSINE_SCORE=${DEFAULT_MEMORY_MIN_COSINE_SCORE}`)
  console.log(`section floor DEFAULT_VECTORIZE_MIN_COSINE_SCORE=${DEFAULT_VECTORIZE_MIN_COSINE_SCORE}`)
  console.log(`topK=${cli.topK}`)

  const ping = await embedTexts(['ping'])
  if (!ping?.[0] || ping[0].length !== DIM) {
    throw new Error(`local embedder unreachable or wrong dim at ${LOCAL_EMBED_URL}`)
  }

  console.log(`loading sections ${cli.sectionIndex} …`)
  const sections = loadSectionIndex(cli.sectionIndex)
  const flat = flattenSectionVectors(sections)
  console.log(`  sections=${sections.length} dim=${sections[0]?.vector.length ?? 0}`)

  const arms: ArmName[] = [
    'memory-keyword',
    'memory-hybrid',
    'memory-cosine',
    'section-cosine-floor',
    'section-cosine-unfloored',
  ]

  type Row = { q: QuestionRec; results: Record<ArmName, ArmResult> }
  const rows: Row[] = []

  for (const rec of [...outQs, ...ctlQs]) {
    console.log(`\n${rec.id} [${rec.kind}]`)
    console.log(`  Q: ${rec.question}`)
    const results = {} as Record<ArmName, ArmResult>

    let kwN = 0
    let kwErr: string | null = null
    try {
      const kw = recall(rec.question, store, { noLlm: true, limit: cli.topK })
      kwN = kw.memories.length
    } catch (error) {
      kwErr = error instanceof Error ? error.message : String(error)
    }
    results['memory-keyword'] = { n: kwN, abstain: kwN === 0, topScore: null, error: kwErr }

    let hyN = 0
    let hyErr: string | null = null
    try {
      const hy = await recallHybrid(rec.question, store, embeddings, {
        noLlm: false,
        limit: cli.topK,
      })
      hyN = hy.memories.length
    } catch (error) {
      hyErr = error instanceof Error ? error.message : String(error)
    }
    results['memory-hybrid'] = { n: hyN, abstain: hyN === 0, topScore: null, error: hyErr }

    let qn: number[] | null = null
    try {
      const qv = await embedTexts([rec.question])
      qn = qv?.[0] ?? null
      if (!qn || qn.length !== DIM) throw new Error('query embed failed')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      results['memory-cosine'] = { n: 0, abstain: true, topScore: null, error: msg }
      results['section-cosine-floor'] = { n: 0, abstain: true, topScore: null, error: msg }
      results['section-cosine-unfloored'] = { n: 0, abstain: true, topScore: null, error: msg }
      rows.push({ q: rec, results })
      for (const name of arms) {
        const r = results[name]
        if (!r) continue
        console.log(`  ${name.padEnd(28)} n=${r.n} abstain=${r.abstain}${r.error ? ` err=${r.error}` : ''}`)
      }
      continue
    }

    const memCos = rankMemoryCosine(qn, store.memories, embeddings, cli.topK, null)
    results['memory-cosine'] = {
      n: memCos.n,
      abstain: memCos.n === 0,
      topScore: memCos.topScore,
      error: null,
    }

    const secFloor = rankSectionCosine(qn, flat, sections.length, cli.topK, DEFAULT_VECTORIZE_MIN_COSINE_SCORE)
    results['section-cosine-floor'] = {
      n: secFloor.n,
      abstain: secFloor.n === 0,
      topScore: secFloor.topScore,
      error: null,
    }

    const secRaw = rankSectionCosine(qn, flat, sections.length, cli.topK, null)
    results['section-cosine-unfloored'] = {
      n: secRaw.n,
      abstain: secRaw.n === 0,
      topScore: secRaw.topScore,
      error: null,
    }

    rows.push({ q: rec, results })
    for (const name of arms) {
      const r = results[name]
      const sat = r.n === cli.topK ? ' SATURATED' : ''
      const sc = r.topScore !== null ? ` top=${r.topScore.toFixed(4)}` : ''
      console.log(`  ${name.padEnd(28)} n=${r.n} abstain=${r.abstain}${sc}${sat}${r.error ? ` err=${r.error}` : ''}`)
    }
  }

  const outRows = rows.filter((r) => r.q.kind === 'out-of-archive')
  const ctlRows = rows.filter((r) => r.q.kind === 'control')

  console.log('\n' + '='.repeat(80))
  console.log('ABSTENTION (out-of-archive n=15; correct answer is zero results)')
  console.log('='.repeat(80))

  const summary: Record<string, { abstain: number; n: number; returned: number[]; saturated: number }> = {}
  for (const name of arms) {
    const abs = outRows.filter((r) => r.results[name].abstain).length
    const returned = outRows.filter((r) => !r.results[name].abstain).map((r) => r.results[name].n)
    const saturated = returned.filter((n) => n === cli.topK).length
    summary[name] = { abstain: abs, n: outRows.length, returned, saturated }
    const avgRet = mean(returned)
    console.log(
      `  ${name.padEnd(28)} abstain=${fmtRate(abs, outRows.length)}` +
        `  non-abstain n=${returned.length}` +
        `  returned=[${returned.join(',')}]` +
        `  meanReturned=${avgRet === null ? 'n/a' : avgRet.toFixed(2)}` +
        `  saturated@${cli.topK}=${saturated}`,
    )
  }

  console.log('\n' + '='.repeat(80))
  console.log('CONTROLS (in-archive; abstaining arm must still retrieve)')
  console.log('='.repeat(80))
  for (const row of ctlRows) {
    console.log(`  ${row.q.id}  ${row.q.question}`)
    for (const name of arms) {
      const r = row.results[name]
      console.log(`    ${name.padEnd(28)} n=${r.n} abstain=${r.abstain}`)
    }
  }

  const kwAbs = summary['memory-keyword']!.abstain / outRows.length
  const hyAbs = summary['memory-hybrid']!.abstain / outRows.length
  const secAbs = summary['section-cosine-floor']!.abstain / outRows.length
  const secRawAbs = summary['section-cosine-unfloored']!.abstain / outRows.length
  const claimAbs = Math.max(kwAbs, hyAbs)
  const ctlKwOk = ctlRows.every((r) => r.results['memory-keyword'].n > 0)
  const ctlHyOk = ctlRows.every((r) => r.results['memory-hybrid'].n > 0)
  const ctlSecOk = ctlRows.every((r) => r.results['section-cosine-floor'].n > 0)

  console.log('\n' + '='.repeat(80))
  console.log('VERDICT')
  console.log('='.repeat(80))
  const honest = claimAbs > secAbs
  console.log(
    `Claim index abstains more honestly than floored section retrieval: ` +
      `memory-keyword ${kwAbs.toFixed(3)} / memory-hybrid ${hyAbs.toFixed(3)} vs ` +
      `section-cosine@0.45 ${secAbs.toFixed(3)} (unfloored ${secRawAbs.toFixed(3)}). ` +
      `controls still fire: kw=${ctlKwOk} hy=${ctlHyOk} secFloor=${ctlSecOk}. ` +
      `${honest ? 'YES — claim index is the more honest abstainer.' : 'NO — claim index does not abstain more than floored sections.'}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
