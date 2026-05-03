/**
 * Pre-build the Fuse.js index for askit-hono and upload it to R2.
 *
 * 用法（從 repo 根目錄執行）：
 *   npm run build:index
 *
 * 環境變數（皆為選填）：
 *   D1_DATABASE   D1 資料庫名稱（預設 sayit-database，需與 wrangler.jsonc 內 binding 對應）
 *   SPEAKER_LIKE  speakers.name 的 LIKE 條件（預設 '唐鳳%'）
 *   R2_BUCKET     R2 bucket 名稱（預設 askit-fuse-index-cache）
 *   R2_KEY        上傳到 R2 的 key（預設 ask-index/audrey-tang.json）
 *   MAX_SECTION_CHARS  段落純文字字數上限（預設 100）
 *   YEARS_BACK    只保留最近幾年的內容（預設 2，以 filename 開頭日期判斷）
 *   LOCAL=1       對 D1 下 --local（預設用 --remote 對線上資料庫查詢）
 *   SKIP_UPLOAD=1 只在本地產出 JSON，不上傳 R2
 */
import { execSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Fuse from 'fuse.js'
import {
  ASK_FUSE_OPTIONS,
  ASK_INDEX_R2_KEY,
  ASK_INDEX_VERSION,
  type AskIndexPayload,
  type SectionRow,
} from '../src/utils/askIndexFormat'

const D1_DATABASE = process.env.D1_DATABASE ?? 'sayit-database'
const R2_BUCKET = process.env.R2_BUCKET ?? 'askit-fuse-index-cache' // or askit-fuse-index-cache-preview
const SPEAKER_LIKE = process.env.SPEAKER_LIKE ?? '唐鳳%'
const R2_KEY = process.env.R2_KEY ?? ASK_INDEX_R2_KEY
const MAX_SECTION_CHARS = Number(process.env.MAX_SECTION_CHARS ?? '100')
const YEARS_BACK = Number(process.env.YEARS_BACK ?? '2')
const SKIP_UPLOAD = process.env.SKIP_UPLOAD === '1'
const D1_FLAG = process.env.LOCAL === '1' ? '--local' : '--remote'

type WranglerD1Envelope = {
  success?: boolean
  results?: SectionRow[]
  error?: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function dateYearsAgo(years: number): string {
  const date = new Date()
  date.setUTCFullYear(date.getUTCFullYear() - years)
  return date.toISOString().slice(0, 10)
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

function textLength(s: string): number {
  return Array.from(s).length
}

function runD1Query(sql: string): SectionRow[] {
  console.log(
    `[build-ask-index] Querying D1 (${D1_FLAG}) database=${D1_DATABASE}...`,
  )
  const cmd =
    `npx wrangler d1 execute ${shellQuote(D1_DATABASE)} ${D1_FLAG} ` +
    `--json --command ${shellQuote(sql)}`

  const out = execSync(cmd, {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 256,
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
  return (envelope.results ?? []) as SectionRow[]
}

async function main() {
  // SPEAKER_LIKE 直接內嵌進 SQL；避免 single quote 注入
  const speakerLikeForSql = SPEAKER_LIKE.replace(/'/g, "''")
  const cutoffDate = dateYearsAgo(YEARS_BACK)
  const sql =
    `SELECT filename, nest_filename, section_id, section_speaker, ` +
    `section_content, display_name, name ` +
    `FROM sections ` +
    `WHERE name LIKE '${speakerLikeForSql}' ` +
    `AND section_content IS NOT NULL ` +
    `AND TRIM(section_content) != '' ` +
    `AND filename GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' ` +
    `AND substr(filename, 1, 10) >= '${cutoffDate}'`

  const queriedRows = runD1Query(sql)
  const rows = queriedRows.filter((row) => {
    const plainText = htmlToPlainText(row.section_content ?? '')
    return plainText !== '' && textLength(plainText) <= MAX_SECTION_CHARS
  })
  console.log(
    `[build-ask-index] Got ${queriedRows.length} recent sections matching name LIKE '${SPEAKER_LIKE}' since ${cutoffDate}`,
  )
  console.log(
    `[build-ask-index] Kept ${rows.length} sections with plain text <= ${MAX_SECTION_CHARS} chars`,
  )

  if (rows.length === 0) {
    throw new Error(
      'Refusing to build empty index — check SPEAKER_LIKE, YEARS_BACK, and MAX_SECTION_CHARS',
    )
  }

  const keys = (ASK_FUSE_OPTIONS.keys ?? []) as string[]
  const fuseIndex = Fuse.createIndex<SectionRow>(keys, rows)

  const payload: AskIndexPayload = {
    v: ASK_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    speakerLike: SPEAKER_LIKE,
    rowCount: rows.length,
    rows,
    index: fuseIndex.toJSON(),
  }

  const outDir = path.resolve('build')
  await mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, path.basename(R2_KEY))
  const json = JSON.stringify(payload)
  await writeFile(outPath, json)
  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2)
  console.log(`[build-ask-index] Wrote ${outPath} (${sizeMB} MB)`)

  if (SKIP_UPLOAD) {
    console.log('[build-ask-index] SKIP_UPLOAD=1, not uploading to R2')
    return
  }

  console.log(
    `[build-ask-index] Uploading to R2 ${R2_BUCKET}/${R2_KEY} ...`,
  )
  const upCmd =
    `npx wrangler r2 object put ${shellQuote(`${R2_BUCKET}/${R2_KEY}`)} ` +
    `--file ${shellQuote(outPath)} ` +
    `--content-type "application/json; charset=utf-8" ` +
    `--remote`
  execSync(upCmd, { stdio: 'inherit' })
  console.log('[build-ask-index] Done.')
}

main().catch((err) => {
  console.error('[build-ask-index] Fatal:', err)
  process.exitCode = 1
})
