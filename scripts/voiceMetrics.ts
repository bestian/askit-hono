/**
 * Pure voice-metrics primitives for the Audrey Tang skill miner.
 *
 * No IO, no side effects — unit-testable. The CLI (`mine-audrey-voice.ts`)
 * composes these; `aggregate()` takes already-fetched section rows and returns
 * the metrics object written to `skill/outputs/voice-metrics.json`.
 */

// ---- constants ----

export const EN_STOPWORDS: Set<string> = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'in', 'that', 'it',
  'this', 'we', 'you', 'i', 'so', 'but', 'for', 'on', 'with', 'as', 'be',
  'do', 'can', 'will', 'would', 'or', 'if', 'at', 'by', 'from', 'was',
  'were', 'am', 'been', 'has', 'have', 'had', 'not', 'they', 'their',
])

export const SEED_PHRASES: { zh: string[]; en: string[] } = {
  zh: [
    '我覺得', '我想', '其實', '其實就是', '當然', '所以', '比如說', '比如',
    '假設', '也就是說', '換句話說', '這個', '對不對', '然後', '可是', '但是',
    '因為', '如果', '就像', '好像', '譬如', '大家', '我們', '一起', '共同',
    '開放', '透明', '多元', '傾聽', '共識',
  ],
  en: [
    'i think', 'actually', 'for example', 'so', 'in a sense', 'let me',
    'you know', 'broad listening', 'rough consensus', 'plurality',
    'radical transparency', 'prosocial', 'demonstrate', 'we the people',
  ],
}

export const ANALOGY_MARKERS = [
  '就像', '好比', '比如說', '想像', '譬如', '就好像',
  'like a', 'imagine', 'for example',
]

const HAN_PATTERN = /\p{Script=Han}/u
const HAN_RUN_PATTERN = /\p{Script=Han}+/gu
const DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_SAMPLE_TEXT = 200

// ---- pure text helpers ----

// canonical copy: scripts/build-ask-index.ts (also duplicated in vectorize-sync.ts)
export function htmlToPlainText(s: string): string {
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

/**
 * Return 'han' if the text contains any Han character, else 'latin'.
 * Mirrors the app's "no Han characters ⇒ treat as English" rule
 * (src/utils/cag.ts `detectCagAnswerLanguage`).
 */
export function detectScript(s: string): 'han' | 'latin' {
  return HAN_PATTERN.test(s) ? 'han' : 'latin'
}

/**
 * Slide windows of each size within every Han-character run. A window never
 * spans punctuation, whitespace, Latin, or digits — we split on non-Han first.
 */
export function extractHanNgrams(
  text: string,
  sizes: number[] = [2, 3, 4],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const run of text.matchAll(HAN_RUN_PATTERN)) {
    const chars = Array.from(run[0])
    for (const size of sizes) {
      if (chars.length < size) continue
      for (let i = 0; i <= chars.length - size; i++) {
        const gram = chars.slice(i, i + size).join('')
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
      }
    }
  }
  return counts
}

/**
 * Lowercase, split on non-[a-z'] runs, drop stopwords, slide word-windows of
 * each size. For English sections. Typographic apostrophes (U+2018/2019) are
 * normalized to ASCII `'` so contractions like `don't` stay one token.
 */
export function extractLatinNgrams(
  text: string,
  sizes: number[] = [1, 2, 3],
  stop: Set<string> = EN_STOPWORDS,
): Map<string, number> {
  const counts = new Map<string, number>()
  const tokens = text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .split(/[^a-z']+/)
    .filter((t) => t !== '' && !stop.has(t))
  for (const size of sizes) {
    for (let i = 0; i <= tokens.length - size; i++) {
      const gram = tokens.slice(i, i + size).join(' ')
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Per seed, count non-overlapping substring occurrences in `text`.
 */
export function countSeedPhrases(
  text: string,
  seeds: string[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const seed of seeds) {
    if (seed === '') continue
    let count = 0
    let idx = 0
    while ((idx = text.indexOf(seed, idx)) !== -1) {
      count++
      idx += seed.length
    }
    counts.set(seed, count)
  }
  return counts
}

/** Sort by count desc then gram asc; take n. Drops zero-count entries. */
export function topN(
  counts: Map<string, number>,
  n: number,
): Array<{ gram: string; count: number }> {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([gram, count]) => ({ gram, count }))
}

// ---- aggregate types ----

export type VoiceMetricsRow = {
  filename: string
  section_id: number | string
  section_content: string | null
}

export type SeedPhraseCount = { phrase: string; count: number }
export type NgramCount = { gram: string; n: number; count: number }
export type VoiceSample = {
  filename: string
  sectionId: number
  text: string
  href: string
}

export type VoiceMetrics = {
  generatedAt: string
  corpus: {
    speeches: number
    audreySections: number
    totalHanChars: number
    totalLatinWords: number
    dateRange: { from: string; to: string }
  }
  seedPhrases: { zh: SeedPhraseCount[]; en: SeedPhraseCount[] }
  hanNgrams: NgramCount[]
  latinNgrams: NgramCount[]
  openings: VoiceSample[]
  closings: VoiceSample[]
  analogies: VoiceSample[]
}

// ---- aggregate (also pure; no IO) ----

function mergeInto(dst: Map<string, number>, src: Map<string, number>): void {
  for (const [k, v] of src) {
    dst.set(k, (dst.get(k) ?? 0) + v)
  }
}

/**
 * Matches `buildArchiveTwSectionHref` in `src/utils/search.ts` but without
 * `nest_filename` (the mining query omits it; the bare-filename href resolves
 * correctly on archive.tw).
 */
function buildSectionHref(filename: string, sectionId: number): string {
  return `https://archive.tw/${encodeURIComponent(filename)}#s${sectionId}`
}

function truncateText(s: string): string {
  return Array.from(s).slice(0, MAX_SAMPLE_TEXT).join('')
}

function toSectionId(v: number | string): number {
  return typeof v === 'string' ? Number(v) : v
}

/**
 * Takes already-fetched section rows and returns the metrics object.
 *
 * - Each row's `section_content` is converted via `htmlToPlainText` once and
 *   classified with `detectScript`; Han rows feed the Han counters, Latin rows
 *   the Latin counters.
 * - openings/closings: group by `filename`; opening = min `section_id` in that
 *   speech, closing = max; sort speeches by date desc (filename prefix), take
 *   `sample` of each.
 * - analogies: rows whose plain text contains any analogy marker; take
 *   `sample`, longest-first (richer metaphors).
 */
export function aggregate(
  rows: VoiceMetricsRow[],
  opts: { topN?: number; sample?: number; now?: () => Date } = {},
): VoiceMetrics {
  const topNLimit = opts.topN ?? 60
  const sampleLimit = opts.sample ?? 40
  const now = opts.now ?? (() => new Date())

  const plains = rows.map((r) => htmlToPlainText(r.section_content ?? ''))

  const hanNgramCounts = new Map<string, number>()
  const latinNgramCounts = new Map<string, number>()
  const zhSeedCounts = new Map<string, number>()
  const enSeedCounts = new Map<string, number>()

  let totalHanChars = 0
  let totalLatinWords = 0

  const analogyRows: { row: VoiceMetricsRow; plain: string; sectionId: number }[] =
    []

  for (let i = 0; i < rows.length; i++) {
    const plain = plains[i]
    if (plain === '') continue
    const script = detectScript(plain)
    if (script === 'han') {
      mergeInto(hanNgramCounts, extractHanNgrams(plain))
      mergeInto(zhSeedCounts, countSeedPhrases(plain, SEED_PHRASES.zh))
      for (const run of plain.matchAll(HAN_RUN_PATTERN)) {
        totalHanChars += Array.from(run[0]).length
      }
    } else {
      // Lowercase + normalize typographic apostrophes for en seed/n-gram
      // matching (archive.tw uses U+2019; seeds are ASCII lowercase).
      const lowerPlain = plain.toLowerCase().replace(/[\u2018\u2019\u201a\u201b]/g, "'")
      mergeInto(latinNgramCounts, extractLatinNgrams(plain))
      mergeInto(enSeedCounts, countSeedPhrases(lowerPlain, SEED_PHRASES.en))
      totalLatinWords += lowerPlain
        .split(/[^a-z']+/)
        .filter((t) => t !== '').length
    }
    if (ANALOGY_MARKERS.some((m) => plain.includes(m))) {
      analogyRows.push({ row: rows[i], plain, sectionId: toSectionId(rows[i].section_id) })
    }
  }

  // Group by filename → openings (min section_id) / closings (max)
  const byFilename = new Map<
    string,
    { row: VoiceMetricsRow; plain: string; sectionId: number }[]
  >()
  for (let i = 0; i < rows.length; i++) {
    const sid = toSectionId(rows[i].section_id)
    const arr = byFilename.get(rows[i].filename) ?? []
    arr.push({ row: rows[i], plain: plains[i], sectionId: sid })
    byFilename.set(rows[i].filename, arr)
  }

  const speeches = [...byFilename.entries()]
    .map(([filename, sections]) => {
      sections.sort((a, b) => a.sectionId - b.sectionId)
      return {
        filename,
        date: filename.slice(0, 10),
        opening: sections[0]!,
        closing: sections[sections.length - 1]!,
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date))

  const buildSample = (e: {
    row: VoiceMetricsRow
    plain: string
    sectionId: number
  }): VoiceSample => ({
    filename: e.row.filename,
    sectionId: e.sectionId,
    text: truncateText(e.plain),
    href: buildSectionHref(e.row.filename, e.sectionId),
  })

  const openings = speeches.slice(0, sampleLimit).map((s) => buildSample(s.opening))
  const closings = speeches.slice(0, sampleLimit).map((s) => buildSample(s.closing))

  analogyRows.sort((a, b) => b.plain.length - a.plain.length)
  const analogies = analogyRows.slice(0, sampleLimit).map(({ row, plain, sectionId }) => ({
    filename: row.filename,
    sectionId,
    text: truncateText(plain),
    href: buildSectionHref(row.filename, sectionId),
  }))

  const dates = rows
    .map((r) => r.filename.slice(0, 10))
    .filter((d) => DATE_PREFIX_PATTERN.test(d))
    .sort()
  const dateRange =
    dates.length > 0
      ? { from: dates[0]!, to: dates[dates.length - 1]! }
      : { from: '', to: '' }

  const seedPhraseCounts = (map: Map<string, number>): SeedPhraseCount[] =>
    [...map.entries()]
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([phrase, count]) => ({ phrase, count }))

  const hanNgramResults: NgramCount[] = topN(hanNgramCounts, topNLimit).map(
    ({ gram, count }) => ({ gram, n: Array.from(gram).length, count }),
  )
  const latinNgramResults: NgramCount[] = topN(latinNgramCounts, topNLimit).map(
    ({ gram, count }) => ({ gram, n: gram.split(' ').length, count }),
  )

  return {
    generatedAt: now().toISOString(),
    corpus: {
      speeches: byFilename.size,
      audreySections: rows.length,
      totalHanChars,
      totalLatinWords,
      dateRange,
    },
    seedPhrases: {
      zh: seedPhraseCounts(zhSeedCounts),
      en: seedPhraseCounts(enSeedCounts),
    },
    hanNgrams: hanNgramResults,
    latinNgrams: latinNgramResults,
    openings,
    closings,
    analogies,
  }
}
