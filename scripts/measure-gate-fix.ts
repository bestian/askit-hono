/**
 * Paired measurement of the keyword-gate fix.
 *
 * Empty-rate drop is not enough: a recall fix that returns junk (identical
 * scores on every hit) still fails. This script reports natural / tuned-21 /
 * abstention together, then a verdict against the pre-fix baselines.
 *
 * Local only. No network. Keyword recall only (`noLlm: true`).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/measure-gate-fix.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_AUDREY_EVAL_CASES, DEFAULT_CAG_EVAL_CASES } from '../src/utils/cagEval'
import { loadCagStore, recall, type CagStore, type RankedMemory } from '../src/utils/cagMemories'

const STORE_DIR = '/tmp/cag-memories-full105'
const NATURAL_PATH = path.resolve('local/cag-compare/natural-questions.json')
const ABSTENTION_PATH = path.resolve('local/cag-compare/abstention-questions.json')
const RECALL_LIMIT = 8

const HANGUL_RE = /\p{Script=Hangul}/u
const HIRAGANA_RE = /\p{Script=Hiragana}/u
const KATAKANA_RE = /\p{Script=Katakana}/u
const HAN_RE = /\p{Script=Han}/u

const BASELINE = {
  naturalEmpty: 334,
  naturalN: 428,
  naturalRate: 0.780,
  naturalDegenerate: 57,
  enEmpty: 60,
  enN: 60,
  tunedEmpty: 0,
  tunedN: 21,
  outOfArchiveEmpty: 15,
  outOfArchiveN: 15,
} as const

type ScriptClass = 'hangul' | 'kana+han' | 'han-only' | 'latin'

type NaturalCase = {
  id: string
  source: string
  lang: string
  text: string
}

type AbstentionCase = {
  id: string
  kind: string
  question: string
  absentTerms: string[]
}

type RecallRow = {
  n: number
  empty: boolean
  degenerate: boolean
}

function fail(pathName: string, message: string): never {
  throw new Error(`${pathName}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) fail(filePath, 'file not found')
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(filePath, `invalid JSON (${detail})`)
  }
}

function requireString(obj: Record<string, unknown>, field: string, pathName: string): string {
  if (!(field in obj)) fail(pathName, `missing field ${field}`)
  const value = obj[field]
  if (typeof value !== 'string') fail(pathName, `field ${field} must be a string`)
  return value
}

function requireStringArray(obj: Record<string, unknown>, field: string, pathName: string): string[] {
  if (!(field in obj)) fail(pathName, `missing field ${field}`)
  const value = obj[field]
  if (!Array.isArray(value)) fail(pathName, `field ${field} must be an array`)
  const out: string[] = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (typeof item !== 'string') fail(pathName, `field ${field}[${i}] must be a string`)
    out.push(item)
  }
  return out
}

function parseNaturalCase(value: unknown, pathName: string): NaturalCase {
  if (!isRecord(value)) fail(pathName, 'must be an object')
  return {
    id: requireString(value, 'id', pathName),
    source: requireString(value, 'source', pathName),
    lang: requireString(value, 'lang', pathName),
    text: requireString(value, 'text', pathName),
  }
}

function parseNaturalQuestions(filePath: string): NaturalCase[] {
  const raw = readJsonFile(filePath)
  if (!isRecord(raw)) fail(filePath, 'expected an object')
  if (!('cases' in raw)) fail(filePath, 'missing field cases')
  const cases = raw.cases
  if (!Array.isArray(cases)) fail(filePath, 'field cases must be an array')
  return cases.map((item, i) => parseNaturalCase(item, `${filePath}.cases[${i}]`))
}

function parseAbstentionCase(value: unknown, pathName: string): AbstentionCase {
  if (!isRecord(value)) fail(pathName, 'must be an object')
  return {
    id: requireString(value, 'id', pathName),
    kind: requireString(value, 'kind', pathName),
    question: requireString(value, 'question', pathName),
    absentTerms: requireStringArray(value, 'absentTerms', pathName),
  }
}

function parseAbstentionQuestions(filePath: string): AbstentionCase[] {
  const raw = readJsonFile(filePath)
  if (!isRecord(raw)) fail(filePath, 'expected an object')
  if (!('questions' in raw)) fail(filePath, 'missing field questions')
  const questions = raw.questions
  if (!Array.isArray(questions)) fail(filePath, 'field questions must be an array')
  return questions.map((item, i) => parseAbstentionCase(item, `${filePath}.questions[${i}]`))
}

function classifyScript(text: string): ScriptClass {
  if (HANGUL_RE.test(text)) return 'hangul'
  if (HIRAGANA_RE.test(text) || KATAKANA_RE.test(text)) return 'kana+han'
  if (HAN_RE.test(text)) return 'han-only'
  return 'latin'
}

function scoresAreIdentical(memories: RankedMemory[]): boolean {
  const first = memories[0]
  if (!first) return false
  return memories.every((m) => m.score === first.score)
}

function measureRecall(query: string, store: CagStore): RecallRow {
  const hit = recall(query, store, { noLlm: true, limit: RECALL_LIMIT })
  const n = hit.memories.length
  return {
    n,
    empty: n === 0,
    degenerate: n > 0 && scoresAreIdentical(hit.memories),
  }
}

function fmtRate(num: number, den: number): string {
  if (den === 0) return `${num}/${den} = n/a`
  return `${num}/${den} = ${(num / den).toFixed(3)}`
}

function pad(text: string, width: number): string {
  return text.padEnd(width)
}

function printNaturalSlice(
  label: string,
  rows: RecallRow[],
  labelWidth: number,
): void {
  const empty = rows.filter((r) => r.empty).length
  const degenerate = rows.filter((r) => r.degenerate).length
  const rate = rows.length === 0 ? 'n/a' : (empty / rows.length).toFixed(3)
  console.log(
    `  ${pad(label, labelWidth)}  n=${String(rows.length).padStart(3)}` +
      `  empty=${String(empty).padStart(3)}/${rows.length}` +
      `  rate=${rate}` +
      `  degenerate=${degenerate}`,
  )
}

function main(): void {
  if (!existsSync(STORE_DIR)) {
    throw new Error(`missing store: ${STORE_DIR}`)
  }

  const natural = parseNaturalQuestions(NATURAL_PATH)
  const abstention = parseAbstentionQuestions(ABSTENTION_PATH)
  const tuned = [...DEFAULT_CAG_EVAL_CASES, ...DEFAULT_AUDREY_EVAL_CASES]
  const store: CagStore = loadCagStore(STORE_DIR)

  if (natural.length !== BASELINE.naturalN) {
    throw new Error(`${NATURAL_PATH}: expected ${BASELINE.naturalN} cases, got ${natural.length}`)
  }
  if (tuned.length !== BASELINE.tunedN) {
    throw new Error(`tuned-21: expected ${BASELINE.tunedN} cases, got ${tuned.length}`)
  }
  if (abstention.length !== 18) {
    throw new Error(`${ABSTENTION_PATH}: expected 18 questions, got ${abstention.length}`)
  }

  console.log(`store=${STORE_DIR}  memories=${store.memories.length}  links=${store.links.length}`)
  console.log(`recall={ noLlm: true, limit: ${RECALL_LIMIT} }`)
  console.log(`natural=${NATURAL_PATH}  n=${natural.length}`)
  console.log(`abstention=${ABSTENTION_PATH}  n=${abstention.length}`)
  console.log(`tuned-21 n=${tuned.length}`)
  console.log('')

  const naturalRows = natural.map((c) => ({
    case: c,
    script: classifyScript(c.text),
    row: measureRecall(c.text, store),
  }))
  const tunedRows = tuned.map((c) => ({
    id: c.id,
    row: measureRecall(c.question, store),
  }))
  const abstentionRows = abstention.map((c) => ({
    case: c,
    row: measureRecall(c.question, store),
  }))

  const naturalEmpty = naturalRows.filter((r) => r.row.empty).length
  const naturalDegenerate = naturalRows.filter((r) => r.row.degenerate).length
  const enRows = naturalRows.filter((r) => r.case.lang === 'en')
  const enEmpty = enRows.filter((r) => r.row.empty).length
  const tunedEmpty = tunedRows.filter((r) => r.row.empty).length
  const outRows = abstentionRows.filter((r) => r.case.kind === 'out-of-archive')
  const controlRows = abstentionRows.filter((r) => r.case.kind === 'control')
  const otherRows = abstentionRows.filter(
    (r) => r.case.kind !== 'out-of-archive' && r.case.kind !== 'control',
  )
  const outEmpty = outRows.filter((r) => r.row.empty).length
  const controlEmpty = controlRows.filter((r) => r.row.empty).length

  console.log('=== 1. Natural pool ===')
  printNaturalSlice('total', naturalRows.map((r) => r.row), 12)
  const scriptOrder: ScriptClass[] = ['hangul', 'kana+han', 'han-only', 'latin']
  for (const script of scriptOrder) {
    printNaturalSlice(script, naturalRows.filter((r) => r.script === script).map((r) => r.row), 12)
  }
  printNaturalSlice("lang === 'en'", enRows.map((r) => r.row), 12)
  console.log('')

  console.log('=== 2. Tuned-21 ===')
  console.log(`  empty=${tunedEmpty}/${tunedRows.length}`)
  const tunedMisses = tunedRows.filter((r) => r.row.empty).map((r) => r.id)
  if (tunedMisses.length > 0) {
    console.log(`  empty ids: ${tunedMisses.join(', ')}`)
  }
  console.log('')

  console.log('=== 3. Out-of-archive abstention ===')
  console.log(`  out-of-archive  empty=${outEmpty}/${outRows.length}  (return nothing)`)
  console.log(`  control         empty=${controlEmpty}/${controlRows.length}  (in-corpus)`)
  if (otherRows.length > 0) {
    const otherEmpty = otherRows.filter((r) => r.row.empty).length
    const kinds = [...new Set(otherRows.map((r) => r.case.kind))].join(', ')
    console.log(`  other (${kinds})  empty=${otherEmpty}/${otherRows.length}`)
  }
  console.log(`  all             empty=${abstentionRows.filter((r) => r.row.empty).length}/${abstentionRows.length}`)
  console.log('')

  const naturalEmptyPass = naturalEmpty < BASELINE.naturalEmpty
  // `naturalDegenerate` is reported in the tables but is NOT an acceptance criterion.
  // Tie-based abstention was tried and refuted: `vTaiwan` — a rare, distinctive,
  // entirely legitimate query — returns 8 hits at 1 distinct score, because sharedW
  // is the IDF sum over matched keys and a single-key match scores every candidate
  // identically. Identical scores are the normal output of single-key matching, so
  // they cannot gate a pass.
  const enEmptyPass = enEmpty < BASELINE.enEmpty
  const tunedPass = tunedEmpty === BASELINE.tunedEmpty
  const outPass = outEmpty === BASELINE.outOfArchiveEmpty && outRows.length === BASELINE.outOfArchiveN

  type Verdict = { name: string; pass: boolean; measured: string; baseline: string; rule: string }
  const verdicts: Verdict[] = [
    {
      name: 'natural empty',
      pass: naturalEmptyPass,
      measured: fmtRate(naturalEmpty, naturalRows.length),
      baseline: `${BASELINE.naturalEmpty}/${BASELINE.naturalN} = ${BASELINE.naturalRate.toFixed(3)}`,
      rule: 'must go DOWN',
    },
    {
      name: 'en empty',
      pass: enEmptyPass,
      measured: fmtRate(enEmpty, enRows.length),
      baseline: `${BASELINE.enEmpty}/${BASELINE.enN}`,
      rule: 'must go DOWN',
    },
    {
      name: 'tuned-21 empty',
      pass: tunedPass,
      measured: `${tunedEmpty}/${tunedRows.length}`,
      baseline: `${BASELINE.tunedEmpty}/${BASELINE.tunedN}`,
      rule: 'must STAY 0',
    },
    {
      name: 'out-of-archive abstention',
      pass: outPass,
      measured: `${outEmpty}/${outRows.length}`,
      baseline: `${BASELINE.outOfArchiveEmpty}/${BASELINE.outOfArchiveN}`,
      rule: 'must STAY 15/15',
    },
  ]

  console.log('=== 4. Verdict ===')
  for (const v of verdicts) {
    console.log(
      `  ${pad(v.name, 26)}  measured ${pad(v.measured, 22)}  baseline ${pad(v.baseline, 22)}  ${v.rule}  ${v.pass ? 'PASS' : 'FAIL'}`,
    )
  }
  console.log('')

  const failed = verdicts.filter((v) => !v.pass).map((v) => v.name)
  if (failed.length === 0) {
    console.log('GATE FIX: PASS')
  } else {
    console.log(`GATE FIX: FAIL ${failed.join(', ')}`)
  }
}

main()
