/**
 * Build a Chinese-language question pool for archive.tw retrieval measurement.
 *
 * Primary: interviewer questions harvested from the 105-file corpus manifest
 * (non-Audrey turns ending in ？/? with ≥2 Han chars). inCorpus: true.
 *
 * Secondary: real event exports under ~/prep if any Chinese questions survive
 * the same language filter. inCorpus: false.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/build-zh-question-pool.ts
 *
 * Writes local/cag-compare/zh-questions.json (gitignored). No Cloudflare.
 * Does not import or modify src/utils/cag.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_MANIFEST_PATH = path.resolve('local/cag-compare/corpus-manifest.json')
export const DEFAULT_TRANSCRIPT_DIR = '/Users/au/w/transcript'
export const DEFAULT_OUT_PATH = path.resolve('local/cag-compare/zh-questions.json')
export const PREP_DIR = path.join(os.homedir(), 'prep')
export const MIN_HAN = 2
export const MIN_CHARS = 8

const HIRAGANA_RE = /\p{Script=Hiragana}/u
const KATAKANA_RE = /\p{Script=Katakana}/u
const HAN_RE = /\p{Script=Han}/u
const IDENTIFIER_KEYS = new Set([
  'participant_id',
  'name',
  'email',
  'guest_id',
  'hash',
  'first_name',
  'last_name',
  'phone',
  'phone_number',
])

export type ZhCase = {
  id: string
  source: string
  lang: 'zh'
  text: string
  inCorpus: boolean
}

export type ZhPool = {
  sources: string[]
  privacy: string
  cases: ZhCase[]
}

type ManifestFile = {
  corpus?: { files?: string[] }
}

type TranscriptTurn = {
  speaker: string
  text: string
}

type Draft = {
  source: string
  text: string
  inCorpus: boolean
}

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

/** Same split as parseTranscriptMarkdown in src/utils/cagMemories.ts. */
export function parseTranscriptTurns(markdown: string): TranscriptTurn[] {
  const chunks = markdown.split(/^### /m)
  const turns: TranscriptTurn[] = []
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? ''
    const nl = chunk.indexOf('\n')
    const header = (nl === -1 ? chunk : chunk.slice(0, nl)).trim()
    const body = nl === -1 ? '' : chunk.slice(nl + 1)
    const speaker = header.replace(/[：:]\s*$/, '').trim()
    turns.push({ speaker, text: body.replace(/\s+$/, '') })
  }
  return turns
}

export function isAudreySpeaker(speaker: string): boolean {
  const s = speaker.normalize('NFKC')
  if (/唐鳳|唐凤/.test(s)) return true
  if (/audrey/i.test(s)) return true
  return false
}

export function charLen(text: string): number {
  return Array.from(text).length
}

export function hanCount(text: string): number {
  return [...text.matchAll(/\p{Script=Han}/gu)].length
}
export function isChineseQuestionText(text: string): boolean {
  if (!text) return false
  if (HIRAGANA_RE.test(text) || KATAKANA_RE.test(text)) return false
  if (hanCount(text) < MIN_HAN) return false
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '')
  return hanCount(letters) * 2 >= Array.from(letters).length
}

export function endsWithQuestionMark(text: string): boolean {
  return /[？?]\s*$/u.test(text)
}

export function normalizeKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function parseCsv(raw: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let inQuotes = false
  while (i < raw.length) {
    const ch = raw[i] ?? ''
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r') {
      i += 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function harvestCorpus(manifestPath: string, transcriptDir: string): Draft[] {
  if (!existsSync(manifestPath)) throw new Error(`manifest missing: ${manifestPath}`)
  const manifest = readJson(manifestPath) as ManifestFile
  const files = manifest.corpus?.files ?? []
  if (files.length === 0) throw new Error(`manifest has no corpus.files: ${manifestPath}`)
  const drafts: Draft[] = []
  for (const filename of files) {
    const filePath = path.join(transcriptDir, filename)
    if (!existsSync(filePath)) throw new Error(`transcript not in manifest path: ${filePath}`)
    const markdown = readFileSync(filePath, 'utf8')
    const turns = parseTranscriptTurns(markdown)
    for (const turn of turns) {
      if (isAudreySpeaker(turn.speaker)) continue
      const text = htmlToPlainText(turn.text)
      if (!endsWithQuestionMark(text)) continue
      if (charLen(text) < MIN_CHARS) continue
      if (!isChineseQuestionText(text)) continue
      drafts.push({ source: 'corpus', text, inCorpus: true })
    }
  }
  return drafts
}

function pushIfZh(drafts: Draft[], source: string, raw: string, inCorpus: boolean): void {
  const text = htmlToPlainText(raw)
  if (charLen(text) < MIN_CHARS) return
  if (!isChineseQuestionText(text)) return
  drafts.push({ source, text, inCorpus })
}

function harvestEurasia(prepDir: string): Draft[] {
  const filePath = path.join(prepDir, '0803-eurasia', 'questions.json')
  if (!existsSync(filePath)) return []
  const raw = readJson(filePath)
  if (!isRecord(raw) || !Array.isArray(raw.questions)) return []
  const drafts: Draft[] = []
  for (const item of raw.questions) {
    if (!isRecord(item) || typeof item.text !== 'string') continue
    pushIfZh(drafts, 'eurasia', item.text, false)
  }
  return drafts
}

function harvestDd2026(prepDir: string): Draft[] {
  const drafts: Draft[] = []
  const files = [
    path.join(prepDir, '0802-dd2026', 'slido-final-all-rooms.json'),
    path.join(prepDir, '0802-dd2026', 'slido-learning-city-final.json'),
  ]
  for (const filePath of files) {
    if (!existsSync(filePath)) continue
    const raw = readJson(filePath)
    const questions: unknown[] = []
    if (isRecord(raw) && Array.isArray(raw.rooms)) {
      for (const room of raw.rooms) {
        if (isRecord(room) && Array.isArray(room.questions)) questions.push(...room.questions)
      }
    } else if (isRecord(raw) && Array.isArray(raw.questions)) {
      questions.push(...raw.questions)
    }
    for (const item of questions) {
      if (!isRecord(item)) continue
      const text =
        (typeof item.text_formatted === 'string' && item.text_formatted) ||
        (typeof item.text === 'string' && item.text) ||
        (typeof item.q_zh === 'string' && item.q_zh) ||
        ''
      if (text) pushIfZh(drafts, 'dd2026', text, false)
    }
  }
  return drafts
}

function harvestLuma(prepDir: string): Draft[] {
  const filePath = path.join(prepDir, 'luma', 'guests.csv')
  if (!existsSync(filePath)) return []
  const rows = parseCsv(readFileSync(filePath, 'utf8'))
  const header = rows[0] ?? []
  const col = header.findIndex((h) => h.includes('最想問什麼問題'))
  if (col < 0) return []
  const drafts: Draft[] = []
  for (const row of rows.slice(1)) {
    const text = row[col] ?? ''
    if (text) pushIfZh(drafts, 'luma', text, false)
  }
  return drafts
}

/** Extra prep question dumps not already covered. Identifier fields are never copied. */
function harvestOtherPrep(prepDir: string, already: Set<string>): Draft[] {
  if (!existsSync(prepDir)) return []
  const drafts: Draft[] = []
  const entries = readdirSync(prepDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const dir = path.join(prepDir, entry.name)
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const filePath = path.join(dir, name)
      if (already.has(filePath)) continue
      if (name === 'questions.json') {
        try {
          const raw = readJson(filePath)
          const list = isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : Array.isArray(raw) ? raw : []
          for (const item of list) {
            if (!isRecord(item)) continue
            const text = typeof item.text === 'string' ? item.text : ''
            if (text) pushIfZh(drafts, slugSource(entry.name), text, false)
          }
        } catch {
          // skip unreadable dumps
        }
      }
    }
  }
  return drafts
}

function slugSource(dirName: string): string {
  const m = dirName.match(/^[0-9]{4}-(.+)$/)
  const rest = (m?.[1] ?? dirName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return rest || 'event'
}

export function dedupeDrafts(drafts: Draft[]): Draft[] {
  const sorted = [...drafts].sort((a, b) => {
    if (a.inCorpus !== b.inCorpus) return a.inCorpus ? -1 : 1
    if (a.source !== b.source) return a.source.localeCompare(b.source)
    return a.text.localeCompare(b.text, 'zh-Hant')
  })
  const kept: Draft[] = []
  const keys: string[] = []
  for (const draft of sorted) {
    const key = normalizeKey(draft.text)
    if (!key) continue
    let drop = false
    for (let i = 0; i < kept.length; i++) {
      const other = keys[i] ?? ''
      if (key === other) {
        drop = true
        break
      }
      const shorter = key.length <= other.length ? key : other
      const longer = key.length <= other.length ? other : key
      if (longer.includes(shorter) && shorter.length >= Math.ceil(longer.length * 0.85)) {
        if (key.length > other.length) {
          kept[i] = draft
          keys[i] = key
        }
        drop = true
        break
      }
    }
    if (!drop) {
      kept.push(draft)
      keys.push(key)
    }
  }
  return kept
}

function assignIds(drafts: Draft[]): ZhCase[] {
  const counters = new Map<string, number>()
  const cases: ZhCase[] = []
  for (const draft of drafts) {
    const n = (counters.get(draft.source) ?? 0) + 1
    counters.set(draft.source, n)
    cases.push({
      id: `zh-${draft.source}-${String(n).padStart(3, '0')}`,
      source: draft.source,
      lang: 'zh',
      text: draft.text,
      inCorpus: draft.inCorpus,
    })
  }
  return cases
}

function assertNoIdentifiers(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoIdentifiers(item, `${trail}[${i}]`))
    return
  }
  if (!isRecord(value)) return
  for (const key of Object.keys(value)) {
    if (IDENTIFIER_KEYS.has(key)) {
      throw new Error(`identifier field leaked at ${trail}.${key}`)
    }
    assertNoIdentifiers(value[key], `${trail}.${key}`)
  }
}

function printSummary(pool: ZhPool, rawBySource: Record<string, number>): void {
  const inCorpus = pool.cases.filter((c) => c.inCorpus).length
  const outCorpus = pool.cases.length - inCorpus
  const bySource = new Map<string, number>()
  let totalLen = 0
  for (const c of pool.cases) {
    bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1)
    totalLen += charLen(c.text)
  }
  const mean = pool.cases.length === 0 ? 0 : totalLen / pool.cases.length
  const rows = [
    ['source', 'raw', 'kept', 'inCorpus'],
    ...[...bySource.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, kept]) => [
        source,
        String(rawBySource[source] ?? 0),
        String(kept),
        source === 'corpus' ? String(kept) : '0',
      ]),
    ['TOTAL', String(Object.values(rawBySource).reduce((a, b) => a + b, 0)), String(pool.cases.length), String(inCorpus)],
  ]
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)))
  console.log('')
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  '))
  }
  console.log('')
  console.log(`cases          ${pool.cases.length}`)
  console.log(`inCorpus true  ${inCorpus}`)
  console.log(`inCorpus false ${outCorpus}`)
  console.log(`mean chars     ${mean.toFixed(1)}`)
  console.log(`sources        ${pool.sources.join(', ')}`)
  console.log('')
  console.log('examples:')
  for (const c of pool.cases.slice(0, 5)) {
    console.log(`  [${c.id}] ${c.text}`)
  }
}

export function buildZhQuestionPool(options?: {
  manifestPath?: string
  transcriptDir?: string
  prepDir?: string
  outPath?: string
}): ZhPool {
  const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH
  const transcriptDir = options?.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR
  const prepDir = options?.prepDir ?? PREP_DIR
  const outPath = options?.outPath ?? DEFAULT_OUT_PATH

  const corpus = harvestCorpus(manifestPath, transcriptDir)
  const eurasia = harvestEurasia(prepDir)
  const dd2026 = harvestDd2026(prepDir)
  const luma = harvestLuma(prepDir)
  const known = new Set([
    path.join(prepDir, '0803-eurasia', 'questions.json'),
    path.join(prepDir, '0802-dd2026', 'slido-final-all-rooms.json'),
    path.join(prepDir, '0802-dd2026', 'slido-learning-city-final.json'),
    path.join(prepDir, 'luma', 'guests.csv'),
  ])
  const other = harvestOtherPrep(prepDir, known)

  const rawBySource: Record<string, number> = {}
  const addRaw = (items: Draft[]) => {
    for (const item of items) rawBySource[item.source] = (rawBySource[item.source] ?? 0) + 1
  }
  addRaw(corpus)
  addRaw(eurasia)
  addRaw(dd2026)
  addRaw(luma)
  addRaw(other)

  const kept = dedupeDrafts([...corpus, ...eurasia, ...dd2026, ...luma, ...other])
  const cases = assignIds(kept)
  const sources = [...new Set(cases.map((c) => c.source))].sort()
  const pool: ZhPool = {
    sources,
    privacy: 'identifiers stripped; gitignored; do not publish or commit',
    cases,
  }
  assertNoIdentifiers(pool, 'pool')
  for (const c of pool.cases) {
    if (c.lang !== 'zh') throw new Error(`non-zh lang: ${c.id}`)
    if (HIRAGANA_RE.test(c.text) || KATAKANA_RE.test(c.text)) {
      throw new Error(`kana leaked: ${c.id}`)
    }
  }
  if (pool.cases.length < 150) {
    throw new Error(`pool too small: ${pool.cases.length} < 150`)
  }

  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(pool, null, 1)}\n`, 'utf8')
  printSummary(pool, rawBySource)
  console.log(`wrote ${outPath}`)
  return pool
}

const invoked = process.argv[1] !== undefined && path.basename(process.argv[1]) === 'build-zh-question-pool.ts'
if (invoked) {
  buildZhQuestionPool()
}
