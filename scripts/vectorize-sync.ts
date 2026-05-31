/**
 * Issue #15 — 建置 / 增量同步 Cloudflare Vectorize 語意索引（可中斷續跑）。
 *
 * 一支冪等腳本同時涵蓋 issue 的第 2～4 步：
 *   1.（若不存在）建立 D1 記帳表 askit_vectorize_progress(section_id, is_vectorized, …)
 *   2. 將「符合 fuse index 條件」的段落 section_id 同步進該表（INSERT OR IGNORE）
 *      並以 content_sha 偵測內容變更 → 重設 is_vectorized=0 以重嵌
 *   3. 逐批處理 is_vectorized=0 的段落：REST 嵌入 → wrangler vectorize upsert → 標記 1
 *   每批標記後即落地，故腳本中斷後再跑可從中斷處續跑。
 *
 * 用法（從 repo 根目錄）：
 *   npm run vectorize:sync          # 首次=全量建置；之後再跑=增量補新
 *   DRY_RUN=1 npm run vectorize:sync
 *   LIMIT=50 npm run vectorize:sync # 只處理前 50 筆（煙霧測試）
 *
 * 必要環境變數（嵌入走 Workers AI REST）：
 *   CLOUDFLARE_ACCOUNT_ID   目標帳號 ID
 *   CLOUDFLARE_API_TOKEN    需含 Workers AI Read + Edit、Vectorize Edit、D1 Edit 權限
 *
 * 選填環境變數：
 *   D1_DATABASE             逐字稿來源 D1（預設 sayit-database）
 *   VECTORIZE_D1_DATABASE   記帳表所在 D1（預設同 D1_DATABASE；可指向獨立 DB 以零碰撞）
 *   VECTORIZE_PROGRESS_TABLE 記帳表名（預設 askit_vectorize_progress）
 *   VECTORIZE_INDEX         Vectorize 索引名（預設 askit-audrey-tang）
 *   SPEAKER_LIKE            speakers.name LIKE（預設 '唐鳳%'，與 build:index 一致）
 *   MAX_SECTION_CHARS       段落純文字字數上限（預設 100，與 build:index 一致）
 *   YEARS_BACK              只收最近幾年（預設 2，與 build:index 一致）
 *   EMBED_BATCH             每次 REST 嵌入筆數（預設 96，上限 100）
 *   UPSERT_BATCH            wrangler vectorize upsert 的 --batch-size（預設 1000）
 *   LIMIT                   本次最多處理幾筆 pending（預設不限）
 *   LOCAL=1                 對 D1 下 --local（預設 --remote）
 *   DRY_RUN=1               不嵌入 / 不 upsert / 不寫 D1，只報告
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { SectionRow } from '../src/utils/askIndexFormat'
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  VECTORIZE_INDEX_NAME,
  buildDocumentEmbeddingInput,
  extractEmbeddings,
  type VectorizeSectionMetadata,
} from '../src/utils/vectorize'

const D1_DATABASE = process.env.D1_DATABASE ?? 'sayit-database'
const VECTORIZE_D1_DATABASE = process.env.VECTORIZE_D1_DATABASE ?? D1_DATABASE
const PROGRESS_TABLE = process.env.VECTORIZE_PROGRESS_TABLE ?? 'askit_vectorize_progress'
const VECTORIZE_INDEX = process.env.VECTORIZE_INDEX ?? VECTORIZE_INDEX_NAME
const SPEAKER_LIKE = process.env.SPEAKER_LIKE ?? '唐鳳%'
const MAX_SECTION_CHARS = Number(process.env.MAX_SECTION_CHARS ?? '100')
const YEARS_BACK = Number(process.env.YEARS_BACK ?? '2')
const EMBED_BATCH = Math.min(100, Math.max(1, Number(process.env.EMBED_BATCH ?? '96')))
const UPSERT_BATCH = Math.max(1, Number(process.env.UPSERT_BATCH ?? '1000'))
const LIMIT = process.env.LIMIT ? Math.max(0, Number(process.env.LIMIT)) : Infinity
const D1_FLAG = process.env.LOCAL === '1' ? '--local' : '--remote'
const DRY_RUN = process.env.DRY_RUN === '1'

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? ''

// 記帳表必備欄位（用於 guard：若同名表缺這些欄位 → 視為他人的表，拒絕觸碰）。
const REQUIRED_COLUMNS = ['section_id', 'is_vectorized', 'content_sha']
// 合法 table 名（防注入；只允許英數與底線）。
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// ── 小工具（與 build-ask-index 一致的純文字處理）─────────────────────────────
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

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// ── D1 CLI（沿用 build-ask-index 的 execSync + --json envelope 解析）────────────
type D1Envelope = {
  success?: boolean
  results?: Record<string, unknown>[]
  error?: string
}

function parseD1Json(out: string): D1Envelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    // 容錯：wrangler 偶爾在 JSON 前後夾雜輸出，截取第一個 JSON 區塊。
    const start = out.search(/[[{]/)
    const end = Math.max(out.lastIndexOf(']'), out.lastIndexOf('}'))
    if (start === -1 || end === -1 || end < start) {
      throw new Error(`無法解析 wrangler d1 --json 輸出：${out.slice(0, 500)}`)
    }
    parsed = JSON.parse(out.slice(start, end + 1))
  }
  const envelope = Array.isArray(parsed) ? (parsed[0] as D1Envelope) : (parsed as D1Envelope)
  if (!envelope || envelope.success === false) {
    throw new Error(`D1 查詢失敗：${envelope?.error ?? 'unknown error'}`)
  }
  return envelope
}

function d1Query(database: string, sql: string): Record<string, unknown>[] {
  const cmd =
    `npx wrangler d1 execute ${shellQuote(database)} ${D1_FLAG} ` +
    `--json --command ${shellQuote(sql)}`
  const out = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 })
  return parseD1Json(out).results ?? []
}

function d1ExecFile(database: string, filePath: string): void {
  const cmd =
    `npx wrangler d1 execute ${shellQuote(database)} ${D1_FLAG} ` +
    `--file ${shellQuote(filePath)} --yes`
  execSync(cmd, { stdio: 'inherit' })
}

function d1ExecCommand(database: string, sql: string): void {
  const cmd =
    `npx wrangler d1 execute ${shellQuote(database)} ${D1_FLAG} ` +
    `--command ${shellQuote(sql)} --yes`
  execSync(cmd, { stdio: 'inherit' })
}

// ── 安全護欄：絕不蓋過任何已存在的 table ─────────────────────────────────────
function ensureProgressTable(outDir: string): Promise<void> {
  return (async () => {
    if (!TABLE_NAME_RE.test(PROGRESS_TABLE)) {
      throw new Error(`記帳表名不合法：${PROGRESS_TABLE}`)
    }
    const existing = d1Query(
      VECTORIZE_D1_DATABASE,
      `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlString(PROGRESS_TABLE)}`,
    )

    if (existing.length > 0) {
      // 表已存在 → 確認是「我們的」表，否則中止，絕不寫入他人的表。
      const cols = d1Query(VECTORIZE_D1_DATABASE, `PRAGMA table_info(${sqlString(PROGRESS_TABLE)})`)
      const colNames = new Set(cols.map((c) => String(c.name)))
      const missing = REQUIRED_COLUMNS.filter((c) => !colNames.has(c))
      if (missing.length > 0) {
        throw new Error(
          `偵測到資料庫 ${VECTORIZE_D1_DATABASE} 已存在名為「${PROGRESS_TABLE}」的表，` +
            `但缺少必要欄位 [${missing.join(', ')}]（現有欄位：${[...colNames].join(', ')}）。` +
            `為避免覆寫既有資料，已中止。請設定 VECTORIZE_PROGRESS_TABLE 為其他名稱。`,
        )
      }
      console.log(`[vectorize-sync] 記帳表 ${PROGRESS_TABLE} 已存在且結構相符，沿用。`)
      return
    }

    // 不存在才建立；用 IF NOT EXISTS 再加一層保險，永不 DROP / 永不覆寫。
    // 註：即使 DRY_RUN 也會建立這張（空的、加護欄的）記帳表，後續成員預覽才讀得到；
    // 真正有成本/不可逆的動作（嵌入、upsert、標記）仍受 DRY_RUN 阻擋。
    const createSql = path.join(outDir, 'vectorize-progress-create.sql')
    await writeFile(
      createSql,
      `CREATE TABLE IF NOT EXISTS ${PROGRESS_TABLE} (\n` +
        `  section_id INTEGER PRIMARY KEY,\n` +
        `  is_vectorized INTEGER NOT NULL DEFAULT 0,\n` +
        `  content_sha TEXT,\n` +
        `  updated_at TEXT\n` +
        `);\n` +
        `CREATE INDEX IF NOT EXISTS idx_${PROGRESS_TABLE}_pending\n` +
        `  ON ${PROGRESS_TABLE} (is_vectorized);\n`,
    )
    d1ExecFile(VECTORIZE_D1_DATABASE, createSql)
    console.log(`[vectorize-sync] 已建立記帳表 ${PROGRESS_TABLE}`)
  })()
}

// ── Workers AI REST 嵌入 ─────────────────────────────────────────────────────
async function embedTexts(texts: string[]): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: texts }),
  })
  if (!res.ok) {
    throw new Error(`嵌入 HTTP ${res.status}：${(await res.text()).slice(0, 500)}`)
  }
  const json = (await res.json()) as { success?: boolean; errors?: unknown }
  if (json.success === false) {
    throw new Error(`嵌入 API 回傳錯誤：${JSON.stringify(json.errors)}`)
  }
  const vectors = extractEmbeddings(json)
  if (vectors.length !== texts.length) {
    throw new Error(`嵌入筆數不符：送 ${texts.length} 收 ${vectors.length}`)
  }
  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIM) {
      throw new Error(`嵌入維度不符：預期 ${EMBEDDING_DIM} 收到 ${v.length}`)
    }
  }
  return vectors
}

// ── Vectorize upsert（透過 wrangler CLI；冪等 last-write-wins）─────────────────
function vectorizeUpsert(ndjsonPath: string): void {
  const cmd =
    `npx wrangler vectorize upsert ${shellQuote(VECTORIZE_INDEX)} ` +
    `--file ${shellQuote(ndjsonPath)} --batch-size ${UPSERT_BATCH}`
  execSync(cmd, { stdio: 'inherit' })
}

function assertVectorizeIndexExists(): void {
  try {
    execSync(`npx wrangler vectorize info ${shellQuote(VECTORIZE_INDEX)}`, { stdio: 'ignore' })
  } catch {
    throw new Error(
      `找不到 Vectorize 索引「${VECTORIZE_INDEX}」。請先建立：\n` +
        `  npx wrangler vectorize create ${VECTORIZE_INDEX} --dimensions=${EMBEDDING_DIM} --metric=cosine`,
    )
  }
}

// ── 取得「符合 fuse index 條件」的段落（含內容，與 build:index 同一套過濾）──────
type QualifyingRow = {
  sectionId: number
  plainText: string
  contentSha: string
  metadata: VectorizeSectionMetadata
}

function loadQualifyingRows(): Map<number, QualifyingRow> {
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

  console.log(`[vectorize-sync] 從 D1 (${D1_FLAG}) ${D1_DATABASE} 取符合條件段落…`)
  const rows = d1Query(D1_DATABASE, sql) as unknown as SectionRow[]

  const map = new Map<number, QualifyingRow>()
  for (const row of rows) {
    const sectionId = Number(row.section_id)
    if (!Number.isInteger(sectionId)) continue
    const plainText = htmlToPlainText(row.section_content ?? '')
    if (plainText === '' || textLength(plainText) > MAX_SECTION_CHARS) continue

    const metadata: VectorizeSectionMetadata = {
      section_id: sectionId,
      filename: row.filename,
      content: row.section_content ?? '',
      display_name: row.display_name ?? row.filename,
    }
    if (row.nest_filename) metadata.nest_filename = row.nest_filename
    if (row.name) metadata.speaker = row.name

    map.set(sectionId, {
      sectionId,
      plainText,
      contentSha: sha256Hex(plainText),
      metadata,
    })
  }
  console.log(
    `[vectorize-sync] 取得 ${rows.length} 筆，符合 ≤${MAX_SECTION_CHARS} 字者 ${map.size} 筆（speaker LIKE '${SPEAKER_LIKE}'、近 ${YEARS_BACK} 年）`,
  )
  return map
}

// ── 同步記帳表成員（新增 / 內容變更重設）──────────────────────────────────────
type ProgressRow = { section_id: number; content_sha: string | null; is_vectorized: number }

async function syncMembership(
  outDir: string,
  qualifying: Map<number, QualifyingRow>,
): Promise<void> {
  const existingRows = d1Query(
    VECTORIZE_D1_DATABASE,
    `SELECT section_id, content_sha, is_vectorized FROM ${PROGRESS_TABLE}`,
  ) as unknown as ProgressRow[]
  const existing = new Map<number, ProgressRow>()
  for (const r of existingRows) existing.set(Number(r.section_id), r)

  const toInsert: QualifyingRow[] = []
  const toReset: QualifyingRow[] = [] // 內容變更 → 重嵌
  for (const row of qualifying.values()) {
    const prev = existing.get(row.sectionId)
    if (!prev) toInsert.push(row)
    else if (prev.content_sha !== row.contentSha) toReset.push(row)
  }
  const stale = [...existing.keys()].filter((id) => !qualifying.has(id))

  console.log(
    `[vectorize-sync] 成員同步：新增 ${toInsert.length}、內容變更重設 ${toReset.length}、` +
      `已不符合條件（保留不刪）${stale.length}`,
  )

  if (DRY_RUN || (toInsert.length === 0 && toReset.length === 0)) {
    if (DRY_RUN) console.log('[vectorize-sync] (DRY_RUN) 略過成員寫入')
    return
  }

  const now = new Date().toISOString()
  const statements: string[] = []
  // 多筆一句 INSERT OR IGNORE（內容皆為整數與 hex，inline 安全）。
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200)
    const values = chunk
      .map((r) => `(${r.sectionId}, 0, ${sqlString(r.contentSha)}, ${sqlString(now)})`)
      .join(', ')
    statements.push(
      `INSERT OR IGNORE INTO ${PROGRESS_TABLE} (section_id, is_vectorized, content_sha, updated_at) VALUES ${values};`,
    )
  }
  for (const r of toReset) {
    statements.push(
      `UPDATE ${PROGRESS_TABLE} SET is_vectorized=0, content_sha=${sqlString(r.contentSha)}, updated_at=${sqlString(now)} WHERE section_id=${r.sectionId};`,
    )
  }

  const syncSql = path.join(outDir, 'vectorize-progress-sync.sql')
  await writeFile(syncSql, statements.join('\n') + '\n')
  d1ExecFile(VECTORIZE_D1_DATABASE, syncSql)
  console.log('[vectorize-sync] 成員同步已寫入 D1')
}

// ── 處理 pending：嵌入 → upsert → 標記 ───────────────────────────────────────
async function processPending(
  outDir: string,
  qualifying: Map<number, QualifyingRow>,
): Promise<void> {
  const pendingRows = d1Query(
    VECTORIZE_D1_DATABASE,
    `SELECT section_id FROM ${PROGRESS_TABLE} WHERE is_vectorized=0 ORDER BY section_id`,
  ) as unknown as { section_id: number }[]
  let pendingIds = pendingRows.map((r) => Number(r.section_id)).filter(Number.isInteger)
  if (Number.isFinite(LIMIT)) pendingIds = pendingIds.slice(0, LIMIT)

  console.log(`[vectorize-sync] 待向量化 ${pendingIds.length} 筆${Number.isFinite(LIMIT) ? `（LIMIT=${LIMIT}）` : ''}`)
  if (DRY_RUN) {
    console.log('[vectorize-sync] (DRY_RUN) 略過嵌入 / upsert / 標記')
    return
  }
  if (pendingIds.length === 0) return

  assertVectorizeIndexExists()

  const ndjsonPath = path.join(outDir, 'vectorize-upsert.ndjson')
  let done = 0
  for (let i = 0; i < pendingIds.length; i += EMBED_BATCH) {
    const batchIds = pendingIds.slice(i, i + EMBED_BATCH)
    const rows = batchIds
      .map((id) => qualifying.get(id))
      .filter((r): r is QualifyingRow => r !== undefined)
    const skipped = batchIds.length - rows.length
    if (skipped > 0) {
      console.warn(`[vectorize-sync] 跳過 ${skipped} 筆（pending 但已不在符合條件集合中）`)
    }
    if (rows.length === 0) continue

    const inputs = rows.map((r) => buildDocumentEmbeddingInput(r.plainText))
    const vectors = await embedTexts(inputs)

    const ndjson = rows
      .map((r, idx) =>
        JSON.stringify({
          id: String(r.sectionId),
          values: vectors[idx],
          metadata: r.metadata,
        }),
      )
      .join('\n')
    await writeFile(ndjsonPath, ndjson + '\n')
    vectorizeUpsert(ndjsonPath)

    // upsert 成功後才標記；故崩潰重跑頂多重嵌同一批（upsert 冪等）。
    const now = new Date().toISOString()
    const idList = rows.map((r) => r.sectionId).join(', ')
    d1ExecCommand(
      VECTORIZE_D1_DATABASE,
      `UPDATE ${PROGRESS_TABLE} SET is_vectorized=1, updated_at=${sqlString(now)} WHERE section_id IN (${idList})`,
    )

    done += rows.length
    console.log(`[vectorize-sync] 進度 ${done}/${pendingIds.length}`)
  }

  await rm(ndjsonPath, { force: true })
}

async function main() {
  if (!DRY_RUN && (ACCOUNT_ID === '' || API_TOKEN === '')) {
    throw new Error(
      '缺少 CLOUDFLARE_ACCOUNT_ID 或 CLOUDFLARE_API_TOKEN（嵌入走 Workers AI REST 需要）。' +
        '可 DRY_RUN=1 先做不需嵌入的乾跑。',
    )
  }

  const outDir = path.resolve('build')
  await mkdir(outDir, { recursive: true })

  await ensureProgressTable(outDir)
  const qualifying = loadQualifyingRows()
  if (qualifying.size === 0) {
    throw new Error('符合條件段落為 0，請檢查 SPEAKER_LIKE / YEARS_BACK / MAX_SECTION_CHARS')
  }
  await syncMembership(outDir, qualifying)
  await processPending(outDir, qualifying)
  console.log('[vectorize-sync] 完成。')
}

main().catch((err) => {
  console.error('[vectorize-sync] Fatal:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
