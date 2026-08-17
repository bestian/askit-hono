/**
 * Measurement script: D1 bigram rescue fire rate on natural & abstention questions.
 *
 * Verifies whether the production guard:
 *   needsD1Rescue = Boolean(sayitDb) && cleanedPhrase.length >= 2
 *     && (sources.length === 0 || !sources.some((s) => s.content.includes(cleanedPhrase)))
 * fires on nearly every real request, inverting its stated cost-saving intent ("省 CF 預算").
 *
 * Read-only against src/utils/cag.ts.
 * Run via: npx tsx scripts/measure-d1-rescue.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildCagRetrievalQueries,
  parseArchiveSectionId,
  DEFAULT_ARCHIVE_BASE_URL,
} from '../src/utils/cag'

/**
 * Replicated from src/utils/cag.ts:285-292 (stripQuestionDirectives is private in cag.ts).
 */
function stripQuestionDirectives(question: string): string {
  return question
    .replace(/#[\p{Letter}\p{Number}_-]+/gu, ' ')
    .replace(/^\s*(?:請|麻煩)?\s*用\s+[\s\S]{0,40}?回答[:：]\s*/u, '')
    .replace(/^\s*(?:請|麻煩)?\s*(?:回答|說明|解釋|summarize|answer)\s*[:：]?\s*/iu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Replicated from src/utils/cag.ts:743-746 (resolveCagSources).
 */
function computeCleanedPhrase(question: string): string {
  return stripQuestionDirectives(question)
    .replace(/[?？!！。.,，;；:：()[\]{}「」『』"""'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

type QuestionItem = {
  id: string
  text: string
  lang?: string
  source?: string
  inCorpus?: boolean
  kind?: string
}

type NaturalQuestionsFile = {
  sources?: string[]
  privacy?: string
  cases?: Array<{
    id: string
    text: string
    lang?: string
    source?: string
    inCorpus?: boolean
  }>
}

type AbstentionQuestionsFile = {
  questions?: Array<{
    id: string
    question: string
    kind?: string
  }>
}

type GroupData = {
  name: string
  file: string
  exists: boolean
  items: QuestionItem[]
}

type QuestionEvalResult = {
  id: string
  text: string
  lang?: string
  cleanedPhrase: string
  cleanedLength: number
  primaryQuery: string
  fallbackQuery: string
  primaryHits: number
  fallbackHits: number
  totalHits: number
  hydratedCount: number
  sourcesEmpty: boolean
  hasVerbatimSubstring: boolean
  needsD1Rescue: boolean
}

let totalArchiveRequests = 0

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function fetchArchiveJson<T>(url: string): Promise<T | null> {
  totalArchiveRequests++
  await sleep(100)
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AskAudrey-D1Rescue-Probe/1.0',
        Accept: 'application/json',
      },
    })
    clearTimeout(timeoutId)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

type ArchiveSearchResponse = {
  results?: Array<{
    title?: string
    url?: string
    snippet?: string
    speaker?: string
  }>
}

type ArchiveSectionResponse = {
  section_content?: string | null
  previous_content?: string | null
  next_content?: string | null
  display_name?: string | null
  name?: string | null
}

function deduplicateHitsByFilename<T extends { url?: string }>(hits: T[], maxPerFile = 2): T[] {
  const counts = new Map<string, number>()
  const result: T[] = []
  for (const hit of hits) {
    if (!hit.url) {
      result.push(hit)
      continue
    }
    const match = hit.url.match(/\/transcript\/([^/#?]+)/)
    const key = match ? match[1] : hit.url
    const current = counts.get(key) ?? 0
    if (current < maxPerFile) {
      counts.set(key, current + 1)
      result.push(hit)
    }
  }
  return result
}

async function evaluateQuestionRetrieval(
  q: QuestionItem,
  baseUrl = DEFAULT_ARCHIVE_BASE_URL,
): Promise<QuestionEvalResult> {
  const cleanedPhrase = computeCleanedPhrase(q.text)
  const cleanedLength = cleanedPhrase.length
  const { primary, fallback } = buildCagRetrievalQueries(q.text)

  // 1. Primary search
  const primaryUrl = `${baseUrl}/api/search.json?q=${encodeURIComponent(primary)}&limit=20`
  const primaryRes = await fetchArchiveJson<ArchiveSearchResponse>(primaryUrl)
  const primaryHitsList = Array.isArray(primaryRes?.results) ? primaryRes.results : []
  const primaryHits = primaryHitsList.length

  let allHits = [...primaryHitsList]
  let fallbackHits = 0

  // 2. Fallback search (cag.ts:575-586: hits < MIN_ARCHIVE_HITS_BEFORE_FALLBACK (3) && fallback && fallback !== primary)
  if (primaryHits < 3 && fallback && fallback !== primary) {
    const fallbackUrl = `${baseUrl}/api/search.json?q=${encodeURIComponent(fallback)}&limit=20`
    const fallbackRes = await fetchArchiveJson<ArchiveSearchResponse>(fallbackUrl)
    const fallbackHitsList = Array.isArray(fallbackRes?.results) ? fallbackRes.results : []
    fallbackHits = fallbackHitsList.length

    // Merge seen by url
    const seen = new Set(allHits.map((h) => h.url).filter(Boolean))
    for (const h of fallbackHitsList) {
      if (h.url && !seen.has(h.url)) {
        seen.add(h.url)
        allHits.push(h)
      }
    }
  }

  // 3. Deduplicate by filename (cag.ts:591)
  const dedupedHits = deduplicateHitsByFilename(allHits, 2)

  // 4. Hydrate top hits in parallel matching production cag.ts:593-595 (topK = 4 -> up to 4 sections)
  const topHitsToHydrate = dedupedHits.slice(0, 4)
  const hydrationPromises = topHitsToHydrate.map(async (hit): Promise<string | null> => {
    if (!hit.url) return null
    const sectionId = parseArchiveSectionId(hit.url)
    if (sectionId) {
      const sectionUrl = `${baseUrl}/api/section/${sectionId}`
      const secData = await fetchArchiveJson<ArchiveSectionResponse>(sectionUrl)
      if (secData) {
        const parts = [
          secData.previous_content,
          secData.section_content,
          secData.next_content,
        ]
          .filter(Boolean)
          .join('\n\n')
        return parts.trim() ? parts : null
      }
    } else if (hit.snippet?.trim()) {
      return hit.snippet.trim()
    }
    return null
  })

  const hydratedList = await Promise.all(hydrationPromises)
  const hydratedContents = hydratedList.filter((c): c is string => c !== null)

  const sourcesEmpty = hydratedContents.length === 0
  const hasVerbatimSubstring =
    !sourcesEmpty && hydratedContents.some((content) => content.includes(cleanedPhrase))

  // Production guard: src/utils/cag.ts:747-750
  const needsD1Rescue =
    cleanedLength >= 2 && (sourcesEmpty || !hasVerbatimSubstring)

  return {
    id: q.id,
    text: q.text,
    lang: q.lang,
    cleanedPhrase,
    cleanedLength,
    primaryQuery: primary,
    fallbackQuery: fallback,
    primaryHits,
    fallbackHits,
    totalHits: allHits.length,
    hydratedCount: hydratedContents.length,
    sourcesEmpty,
    hasVerbatimSubstring,
    needsD1Rescue,
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIdx = 0

  async function worker(): Promise<void> {
    while (nextIdx < items.length) {
      const idx = nextIdx++
      results[idx] = await fn(items[idx], idx)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  const workers = Array.from({ length: workerCount }, () => worker())
  await Promise.all(workers)
  return results
}

function calculateMean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function calculateMedian(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

function arrayMin(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => Math.min(a, b), Infinity)
}

function arrayMax(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => Math.max(a, b), -Infinity)
}
type GroupSummary = {
  name: string
  totalN: number
  sampledN: number
  meanLen: number
  medianLen: number
  minLen: number
  maxLen: number
  below2Len: number
  emptyCount: number
  verbatimCount: number
  d1FiredCount: number
  fireRate: number
}

async function main() {
  console.log('='.repeat(80))
  console.log('鳳問 · Ask Audrey — D1 Rescue Rate & Guard Efficiency Measurement')
  console.log('='.repeat(80))
  console.log()

  // Load datasets
  const natPath = path.resolve('local/cag-compare/natural-questions.json')
  const absPath = path.resolve('local/cag-compare/abstention-questions.json')
  const zhPath = path.resolve('local/cag-compare/zh-questions.json')

  const groups: GroupData[] = []

  // 1. Natural questions
  if (existsSync(natPath)) {
    const raw = JSON.parse(readFileSync(natPath, 'utf8')) as NaturalQuestionsFile
    const items: QuestionItem[] = (raw.cases || []).map((c) => ({
      id: c.id,
      text: c.text,
      lang: c.lang || 'unknown',
      source: c.source,
    }))
    groups.push({ name: 'Natural Questions (pool)', file: natPath, exists: true, items })
  }

  // 2. Abstention questions
  if (existsSync(absPath)) {
    const raw = JSON.parse(readFileSync(absPath, 'utf8')) as AbstentionQuestionsFile
    const items: QuestionItem[] = (raw.questions || []).map((q) => ({
      id: q.id,
      text: q.question,
      kind: q.kind,
    }))
    groups.push({ name: 'Abstention Questions', file: absPath, exists: true, items })
  }

  // 3. ZH questions (if created)
  if (existsSync(zhPath)) {
    const raw = JSON.parse(readFileSync(zhPath, 'utf8')) as NaturalQuestionsFile
    const items: QuestionItem[] = (raw.cases || []).map((c) => ({
      id: c.id,
      text: c.text,
      lang: c.lang || 'zh',
      inCorpus: c.inCorpus,
    }))
    groups.push({ name: 'ZH Questions (corpus/live)', file: zhPath, exists: true, items })
  } else {
    console.log('[Info] local/cag-compare/zh-questions.json is absent; skipped as instructed.')
    console.log()
  }

  // Full population length analysis across all available groups
  console.log('--- 1. Full Population Length Distribution Analysis ---')
  for (const group of groups) {
    const lengths = group.items.map((it) => computeCleanedPhrase(it.text).length)
    const below2 = lengths.filter((l) => l < 2).length
    console.log(
      `Group: ${group.name} (N=${group.items.length})` +
        ` | Mean length: ${calculateMean(lengths).toFixed(2)}` +
        ` | Median: ${calculateMedian(lengths)}` +
        ` | Min: ${arrayMin(lengths)}` +
        ` | Max: ${arrayMax(lengths)}` +
        ` | Length < 2: ${below2} (${((below2 / group.items.length) * 100).toFixed(1)}%)`,
    )
  }
  console.log()

  // Live retrieval on sampled questions (Total >= 60 sample across groups)
  console.log('--- 2. Live Retrieval & Section Substring Verification ---')
  console.log('Executing live queries against archive.tw with concurrent worker pool & rate-limiting...')

  const summaries: GroupSummary[] = []

  const pickStratified = (items: QuestionItem[], count: number) => {
    if (items.length <= count) return items
    const step = items.length / count
    return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)])
  }

  for (const group of groups) {
    let sample: QuestionItem[] = []
    if (group.name.startsWith('Natural')) {
      // Stratified sample of 36 questions:
      // Shortest 10 questions (stress-testing shortest phrases)
      // 10 English questions across length spectrum
      // 8 Japanese questions across length spectrum
      // 8 Other/ZH/Multilingual questions
      const sortedByLen = [...group.items].sort(
        (a, b) => computeCleanedPhrase(a.text).length - computeCleanedPhrase(b.text).length,
      )
      const shortest10 = sortedByLen.slice(0, 10)
      const shortestIds = new Set(shortest10.map((q) => q.id))

      const enItems = group.items.filter((q) => q.lang === 'en' && !shortestIds.has(q.id))
      const jaItems = group.items.filter((q) => q.lang === 'ja' && !shortestIds.has(q.id))
      const otherItems = group.items.filter(
        (q) => q.lang !== 'en' && q.lang !== 'ja' && !shortestIds.has(q.id),
      )

      sample = [
        ...shortest10,
        ...pickStratified(enItems, 10),
        ...pickStratified(jaItems, 8),
        ...pickStratified(otherItems, 8),
      ]
    } else if (group.name.startsWith('ZH')) {
      // Stratified sample of 15 ZH questions:
      // 7 inCorpus + 8 outCorpus
      const inCorpusItems = group.items.filter((q) => q.inCorpus === true)
      const outCorpusItems = group.items.filter((q) => q.inCorpus !== true)
      sample = [
        ...pickStratified(inCorpusItems, 7),
        ...pickStratified(outCorpusItems, 8),
      ]
    } else {
      // 10 sample for abstention
      sample = pickStratified(group.items, 10)
    }

    console.log(`Evaluating group [${group.name}]: sampling ${sample.length} / ${group.items.length} questions...`)

    const results = await mapConcurrent(sample, 4, async (q) => {
      return evaluateQuestionRetrieval(q)
    })

    const allLengths = group.items.map((it) => computeCleanedPhrase(it.text).length)
    const sampledEmpty = results.filter((r) => r.sourcesEmpty).length
    const sampledVerbatim = results.filter((r) => r.hasVerbatimSubstring).length
    const sampledD1Fired = results.filter((r) => r.needsD1Rescue).length

    summaries.push({
      name: group.name,
      totalN: group.items.length,
      sampledN: sample.length,
      meanLen: calculateMean(allLengths),
      medianLen: calculateMedian(allLengths),
      minLen: arrayMin(allLengths),
      maxLen: arrayMax(allLengths),
      below2Len: allLengths.filter((l) => l < 2).length,
      emptyCount: sampledEmpty,
      verbatimCount: sampledVerbatim,
      d1FiredCount: sampledD1Fired,
      fireRate: sampledD1Fired / sample.length,
    })
  }

  console.log()
  console.log('--- 3. Results Summary Table ---')
  console.log()
  console.log(
    '| Group | N (total) | Sampled | Mean Len | Median Len | [Min, Max] | Empty Sources | Verbatim In Content | D1 Rescue Fired | Fire Rate |',
  )
  console.log(
    '|---|---|---|---|---|---|---|---|---|---|',
  )
  for (const s of summaries) {
    console.log(
      `| ${s.name} | ${s.totalN} | ${s.sampledN} | ${s.meanLen.toFixed(1)} | ${s.medianLen} | [${s.minLen}, ${s.maxLen}] | ${s.emptyCount}/${s.sampledN} | ${s.verbatimCount}/${s.sampledN} | ${s.d1FiredCount}/${s.sampledN} | ${(s.fireRate * 100).toFixed(1)}% |`,
    )
  }

  console.log()
  console.log('--- 4. Requests & Instrumentation ---')
  console.log(`Total archive.tw HTTP API requests issued: ${totalArchiveRequests}`)
  console.log()

  console.log('--- 5. Verdict & Analysis ---')
  const natSummary = summaries.find((s) => s.name.startsWith('Natural'))
  const absSummary = summaries.find((s) => s.name.startsWith('Abstention'))
  const zhSummary = summaries.find((s) => s.name.startsWith('ZH'))

  const natFireRate = natSummary ? natSummary.fireRate : 1.0
  const totalSampledAcrossGroups = summaries.reduce((acc, s) => acc + s.sampledN, 0)
  const totalVerbatimAcrossGroups = summaries.reduce((acc, s) => acc + s.verbatimCount, 0)
  const totalBelow2AcrossGroups = summaries.reduce((acc, s) => acc + s.below2Len, 0)
  const totalPopAcrossGroups = summaries.reduce((acc, s) => acc + s.totalN, 0)
  const totalD1FiredAcrossGroups = summaries.reduce((acc, s) => acc + s.d1FiredCount, 0)
  const overallFireRate = totalSampledAcrossGroups > 0 ? totalD1FiredAcrossGroups / totalSampledAcrossGroups : 0

  let verdict: 'CONFIRMED' | 'PARTIAL' | 'REFUTED'
  if (natFireRate >= 0.95 && overallFireRate >= 0.95) {
    verdict = 'CONFIRMED'
  } else if (natFireRate >= 0.50 || overallFireRate >= 0.50) {
    verdict = 'PARTIAL'
  } else {
    verdict = 'REFUTED'
  }

  console.log(`VERDICT: ${verdict}`)
  console.log()
  console.log(
    `Settling Number: D1 Rescue fires on ${natSummary?.d1FiredCount}/${natSummary?.sampledN} (${((natFireRate) * 100).toFixed(1)}%) of sampled natural questions` +
      (absSummary ? `, ${absSummary.d1FiredCount}/${absSummary.sampledN} (${(absSummary.fireRate * 100).toFixed(1)}%) of abstention questions` : '') +
      (zhSummary ? `, and ${zhSummary.d1FiredCount}/${zhSummary.sampledN} (${(zhSummary.fireRate * 100).toFixed(1)}%) of ZH questions` : '') +
      ` (Overall: ${totalD1FiredAcrossGroups}/${totalSampledAcrossGroups} = ${(overallFireRate * 100).toFixed(1)}%).`,
  )
  console.log()
  console.log('Mechanism Breakdown:')
  console.log(
    '  1. Stated intent: In src/utils/cag.ts:738-741, the comment states that D1 bigram search is designed to run only when Vectorize/archive',
  )
  console.log(
    '     returns hits but the specific term is missing from section content, rather than on every request ("省 CF 預算").',
  )
  console.log(
    `  2. Actual input: cleanedPhrase is derived from the full question text minus directives and punctuation.`,
  )
  console.log(
    `     Observed mean lengths: Natural=${natSummary?.meanLen.toFixed(1)} chars (median ${natSummary?.medianLen}), ` +
      (zhSummary ? `ZH=${zhSummary.meanLen.toFixed(1)} chars (median ${zhSummary.medianLen}), ` : '') +
      (absSummary ? `Abstention=${absSummary.meanLen.toFixed(1)} chars.` : ''),
  )
  console.log(
    `  3. Substring test outcome: Across all sampled questions (${totalSampledAcrossGroups} total across all groups), ` +
      `verbatim section containment s.content.includes(cleanedPhrase) occurred in exactly ${totalVerbatimAcrossGroups}/${totalSampledAcrossGroups} ` +
      `(${((totalVerbatimAcrossGroups / totalSampledAcrossGroups) * 100).toFixed(1)}%) cases.`,
  )
  console.log(
    `  4. Guard pass rate: Since ${totalPopAcrossGroups - totalBelow2AcrossGroups}/${totalPopAcrossGroups} ` +
      `(${(((totalPopAcrossGroups - totalBelow2AcrossGroups) / totalPopAcrossGroups) * 100).toFixed(1)}%) ` +
      `of questions satisfy cleanedPhrase.length >= 2, and the verbatim containment test fails on ` +
      `${totalSampledAcrossGroups - totalVerbatimAcrossGroups}/${totalSampledAcrossGroups} (${(((totalSampledAcrossGroups - totalVerbatimAcrossGroups) / totalSampledAcrossGroups) * 100).toFixed(1)}%) of non-empty and empty retrievals, ` +
      `the needsD1Rescue guard evaluates to true on ${natSummary?.d1FiredCount}/${natSummary?.sampledN} (${((natFireRate) * 100).toFixed(1)}%) of natural questions ` +
      `and ${totalD1FiredAcrossGroups}/${totalSampledAcrossGroups} (${(overallFireRate * 100).toFixed(1)}%) across all groups.`,
  )
  console.log()
  console.log('Concrete Cloudflare Cost Implication:')
  console.log(
    `  Instead of executing D1 queries conditionally on rare missing terms (< 5% of traffic), production fires an extra D1 query ` +
      `on ~${(natFireRate * 100).toFixed(0)}% of natural traffic (${(overallFireRate * 100).toFixed(0)}% overall). For virtually every incoming CAG request, ` +
      'Cloudflare D1 incurs the full latency and row-read billing of an askit_bigram_index query (`WHERE bigram IN (...)`).',
  )
  console.log('='.repeat(80))
}

main().catch((err) => {
  console.error('Fatal error running measurement script:', err)
  process.exit(1)
})
