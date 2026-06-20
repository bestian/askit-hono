/**
 * Mine Audrey Tang's voice metrics from the D1 transcript archive.
 *
 * Walks every Audrey-spoken section (name LIKE '唐鳳%' OR name LIKE 'Audrey Tang%')
 * and computes signature-phrase / n-gram / opening / closing / analogy metrics
 * that the portable skill files in `skill/` are written from.
 *
 * 用法（從 repo 根目錄執行）：
 *   npm run skill:mine
 *
 * 環境變數（皆為選填）：
 *   D1_DATABASE     D1 資料庫名稱（預設 sayit-database）
 *   SPEAKER_LIKE    華語 sections 的 name LIKE 條件（預設 '唐鳳%'）
 *   SPEAKER_LIKE_EN English sections 的 name LIKE 條件（預設 'Audrey Tang%'）
 *   LOCAL=1         對 D1 下 --local（預設 --remote 對線上資料庫查詢）
 *   TOP_N           n-gram 與 seed phrase Top-N（預設 60）
 *   SAMPLE          openings / closings / analogies 樣本數（預設 40）
 *   OUT             輸出路徑（預設 skill/outputs/voice-metrics.json）
 *   WRANGLER_USE_API_TOKEN=1  wrangler 子行程強制使用 CLOUDFLARE_API_TOKEN（CI 自動啟用）
 */
import { execSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { aggregate, type VoiceMetricsRow } from './voiceMetrics'
import { buildWranglerEnv } from './wranglerEnv'

const WRANGLER_ENV = buildWranglerEnv()
const D1_DATABASE = process.env.D1_DATABASE ?? 'sayit-database'
const SPEAKER_LIKE = process.env.SPEAKER_LIKE ?? '唐鳳%'
const SPEAKER_LIKE_EN = process.env.SPEAKER_LIKE_EN ?? 'Audrey Tang%'
const D1_FLAG = process.env.LOCAL === '1' ? '--local' : '--remote'
const TOP_N = Number(process.env.TOP_N ?? '60')
const SAMPLE = Number(process.env.SAMPLE ?? '40')
const OUT = process.env.OUT ?? 'skill/outputs/voice-metrics.json'

type WranglerD1Envelope = {
  success?: boolean
  results?: VoiceMetricsRow[]
  error?: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function runD1Query(sql: string): VoiceMetricsRow[] {
  console.log(
    `[skill:mine] Querying D1 (${D1_FLAG}) database=${D1_DATABASE}...`,
  )
  const cmd =
    `npx wrangler d1 execute ${shellQuote(D1_DATABASE)} ${D1_FLAG} ` +
    `--json --command ${shellQuote(sql)}`

  const out = execSync(cmd, {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 256,
    env: WRANGLER_ENV,
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch (e) {
    throw new Error(
      `Failed to parse wrangler d1 execute --json output: ${(e as Error).message}\nFirst 500 chars: ${out.slice(0, 500)}`,
    )
  }

  const envelope: WranglerD1Envelope | undefined = Array.isArray(parsed)
    ? (parsed[0] as WranglerD1Envelope | undefined)
    : (parsed as WranglerD1Envelope | undefined)

  if (!envelope || envelope.success === false) {
    throw new Error(
      `D1 query failed: ${envelope?.error ?? 'unknown error'}`,
    )
  }
  return (envelope.results ?? []) as VoiceMetricsRow[]
}

async function main() {
  // Both speaker names escaped for SQL single-quote context.
  const speakerZh = SPEAKER_LIKE.replace(/'/g, "''")
  const speakerEn = SPEAKER_LIKE_EN.replace(/'/g, "''")
  const sql =
    `SELECT filename, section_id, section_content ` +
    `FROM sections ` +
    `WHERE (name LIKE '${speakerZh}' OR name LIKE '${speakerEn}') ` +
    `AND section_content IS NOT NULL ` +
    `AND TRIM(section_content) != '' ` +
    `AND filename GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`

  const rows = runD1Query(sql)
  console.log(
    `[skill:mine] Got ${rows.length} Audrey sections ` +
      `(name LIKE '${SPEAKER_LIKE}' OR name LIKE '${SPEAKER_LIKE_EN}')`,
  )

  if (rows.length === 0) {
    throw new Error(
      `Refusing to mine empty corpus — check SPEAKER_LIKE / SPEAKER_LIKE_EN ` +
        `and D1_DATABASE (${D1_DATABASE})`,
    )
  }

  const metrics = aggregate(rows, { topN: TOP_N, sample: SAMPLE })

  // Loud warning if either language branch is empty (likely speaker-filter issue).
  const zhEmpty =
    metrics.seedPhrases.zh.length === 0 && metrics.hanNgrams.length === 0
  const enEmpty =
    metrics.seedPhrases.en.length === 0 && metrics.latinNgrams.length === 0
  if (zhEmpty) {
    console.warn(
      `[skill:mine] WARNING: 華語 branch is empty — ` +
        `SPEAKER_LIKE '${SPEAKER_LIKE}' may match nothing.`,
    )
  }
  if (enEmpty) {
    console.warn(
      `[skill:mine] WARNING: English branch is empty — ` +
        `SPEAKER_LIKE_EN '${SPEAKER_LIKE_EN}' may match nothing. ` +
        `Re-query archive.tw/api/search.json with an English phrase and set SPEAKER_LIKE_EN accordingly.`,
    )
  }

  const outPath = path.resolve(OUT)
  await mkdir(path.dirname(outPath), { recursive: true })
  const json = `${JSON.stringify(metrics, null, 2)}\n`
  await writeFile(outPath, json)
  const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1)

  console.log(`[skill:mine] Wrote ${outPath} (${sizeKB} KB)`)
  console.log(
    `[skill:mine] Corpus: ${metrics.corpus.speeches} speeches, ` +
      `${metrics.corpus.audreySections} sections, ` +
      `${metrics.corpus.totalHanChars} Han chars, ` +
      `${metrics.corpus.totalLatinWords} Latin words, ` +
      `dates ${metrics.corpus.dateRange.from} → ${metrics.corpus.dateRange.to}`,
  )
  console.log(
    `[skill:mine] Top Han n-gram: ${metrics.hanNgrams[0]?.gram ?? '(none)'} ` +
      `(${metrics.hanNgrams[0]?.count ?? 0}×) · ` +
      `Top Latin n-gram: ${metrics.latinNgrams[0]?.gram ?? '(none)'} ` +
      `(${metrics.latinNgrams[0]?.count ?? 0}×)`,
  )
  console.log(
    `[skill:mine] Openings: ${metrics.openings.length} · ` +
      `Closings: ${metrics.closings.length} · ` +
      `Analogies: ${metrics.analogies.length}`,
  )
  console.log('[skill:mine] Done.')
}

main().catch((err) => {
  console.error('[skill:mine] Fatal:', err)
  process.exitCode = 1
})
