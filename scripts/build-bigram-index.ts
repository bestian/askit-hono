/**
 * Build the CJK bigram inverted index `askit_bigram_index` inside sayit-database.
 *
 * 問題：`/cag` 與 `/au` 的 D1 內容搜尋回退走 `section_content LIKE '%term%'`——
 * 全表掃描（168K+ rows，D1 按 examined rows 計費），且長查詢會拋
 * `LIKE or GLOB pattern too complex`。本法把罕見 2-char 專有名詞（如「萌典」）
 * 的查找換成有界、有索引的 bigram 倒排索引：runtime 把查詢詞拆成 2-char keys，
 * 在 `askit_bigram_index` 查 `WHERE bigram IN (...)`，受 DF 上限約束。
 *
 * 這是 askit 自有的表（`askit_` 前綴，與 `askit_vectorize_progress` 同一套護欄），
 * 不動任何他人 schema。建表由本腳本負責；runtime 只查不寫。
 *
 * 用法（從 repo 根目錄執行）：
 *   npm run index:bigram                  # 全量重建（DELETE + INSERT，冪等）
 *   DRY_RUN=1 npm run index:bigram        # 唯讀：只印 sizing，不寫 D1
 *   BIGRAM_DF_MAX=100 npm run index:bigram # 調嚴 rare-key 門檻
 *   LOCAL=1 npm run index:bigram          # 用 --local D1
 *
 * 環境變數（皆為選填）：
 *   D1_DATABASE      D1 資料庫名稱（預設 sayit-database）
 *   SPEAKER_LIKE     speakers.name 的 LIKE 條件（預設 '唐鳳%'，與 build:index 一致）
 *   TABLE            目標表名（預設 askit_bigram_index，必須 askit_ 前綴）
 *   BIGRAM_DF_MAX    rare-key 文件頻率上限（預設 200，env 可調）
 *   INSERT_CHUNK     每條 INSERT 的列數（預設 500）
 *   IMPORT_FILE_MAX_BYTES  每個遠端匯入分檔的位元組上限（預設 5MB；避免單一匯入 session 逾時）
 *   IMPORT_RETRIES   單一分檔匯入失敗時的重試次數（預設 4，指數退避）
 *   LOCAL=1          對 D1 下 --local
 *   DRY_RUN=1        不建表 / 不寫 D1，只報告 sizing
 *   WRANGLER_USE_API_TOKEN=1  wrangler 子行程強制使用 CLOUDFLARE_API_TOKEN（CI 自動啟用）
 *
 * 與建置 fuse/vectorize index 不同：**無 YEARS_BACK cutoff、無 MAX_SECTION_CHARS 上限**——
 * 全語料、全文是重點（正是 Vectorize / archive.tw 缺的覆蓋範圍）。
 */
import { execSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { extractIndexKeys } from '../src/utils/bigramKeys'
import { buildWranglerEnv } from './wranglerEnv'

const WRANGLER_ENV = buildWranglerEnv()
const D1_DATABASE = process.env.D1_DATABASE ?? 'sayit-database'
const SPEAKER_LIKE = process.env.SPEAKER_LIKE ?? '唐鳳%'
const TABLE = process.env.TABLE ?? 'askit_bigram_index'
const BIGRAM_DF_MAX = Number(process.env.BIGRAM_DF_MAX ?? '200')
const INSERT_CHUNK = Math.max(1, Number(process.env.INSERT_CHUNK ?? '500'))
const D1_FLAG = process.env.LOCAL === '1' ? '--local' : '--remote'
const DRY_RUN = process.env.DRY_RUN === '1'
// 遠端 D1 匯入是「單一伺服器端 session」：單檔過大（本表 ~33MB / ~2M rows）會逾時，
// wrangler 隨後輪詢時伺服器已無進行中的匯入，回報「Not currently importing anything.」。
// 對策：把 INSERT 切成多個小檔（各 <= IMPORT_FILE_MAX_BYTES）依序匯入，每個 session 都短而可靠。
const IMPORT_FILE_MAX_BYTES = Math.max(
  64 * 1024,
  Number(process.env.IMPORT_FILE_MAX_BYTES ?? String(5 * 1024 * 1024)),
)
// 對暫時性匯入失敗的重試次數（指數退避）。失敗的匯入會被 D1 回滾，重試是安全的。
const IMPORT_RETRIES = Math.max(0, Number(process.env.IMPORT_RETRIES ?? '4'))

// 護欄常數（與 vectorize-sync 的 ensureProgressTable 同形）
const REQUIRED_COLUMNS = ['bigram', 'section_id']
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

type BigramSectionRow = {
  section_id: number
  section_content: string
}

type D1Envelope = {
  success?: boolean
  results?: Record<string, unknown>[]
  error?: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// 與 build-ask-index / vectorize-sync 一致的純文字處理（空白摺成單空格）。
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

function d1Query(sql: string): Record<string, unknown>[] {
  const cmd =
    `npx wrangler d1 execute ${shellQuote(D1_DATABASE)} ${D1_FLAG} ` +
    `--json --command ${shellQuote(sql)}`
  const out = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256, env: WRANGLER_ENV })
  return parseD1Json(out).results ?? []
}

function d1ExecFile(filePath: string): void {
  const cmd =
    `npx wrangler d1 execute ${shellQuote(D1_DATABASE)} ${D1_FLAG} ` +
    `--file ${shellQuote(filePath)} --yes`
  execSync(cmd, { stdio: 'inherit', env: WRANGLER_ENV })
}

// 同步等待（本腳本為一次性批次工具，可阻塞主執行緒）。跨平台、不需 sleep 子行程。
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// 匯入單一分檔，失敗時以指數退避重試。失敗的遠端匯入會被 D1 回滾
//（wrangler：「if the execution fails to complete, your DB will return to its original state」），
// 加上 INSERT OR IGNORE，重試同一分檔是冪等且安全的。
function d1ExecFileWithRetry(filePath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      d1ExecFile(filePath)
      return
    } catch (err) {
      if (attempt >= IMPORT_RETRIES) throw err
      const waitMs = 2000 * 2 ** attempt
      const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0]
      console.warn(
        `[build-bigram-index] 匯入 ${path.basename(filePath)} 失敗（第 ${attempt + 1}/${IMPORT_RETRIES} 次重試前），` +
          `${waitMs}ms 後重試：${reason}`,
      )
      sleepSync(waitMs)
    }
  }
}

// ── 安全護欄：絕不蓋過任何已存在的 table ─────────────────────────────────────
// 移植自 vectorize-sync.ts 的 ensureProgressTable：sqlite_master 查 → 若存在則驗
// 必備欄位（否則中止，絕不寫他人表）→ 不存在才 IF NOT EXISTS 建立。永不 DROP。
async function ensureBigramTable(outDir: string, dryRun: boolean): Promise<void> {
  if (!TABLE_NAME_RE.test(TABLE)) {
    throw new Error(`表名不合法：${TABLE}`)
  }
  const existing = d1Query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlString(TABLE)}`,
  )
  if (existing.length > 0) {
    const cols = d1Query(`PRAGMA table_info(${sqlString(TABLE)})`)
    const colNames = new Set(cols.map((c) => String(c.name)))
    const missing = REQUIRED_COLUMNS.filter((c) => !colNames.has(c))
    if (missing.length > 0) {
      throw new Error(
        `偵測到資料庫 ${D1_DATABASE} 已存在名為「${TABLE}」的表，` +
          `但缺少必要欄位 [${missing.join(', ')}]（現有欄位：${[...colNames].join(', ')}]。` +
          `為避免覆寫既有資料，已中止。請設定 TABLE 為其他名稱。`,
      )
    }
    console.log(`[build-bigram-index] 表 ${TABLE} 已存在且結構相符，沿用。`)
    return
  }

  // DRY_RUN 為唯讀：不建表，只報告將會建立。
  if (dryRun) {
    console.log(`[build-bigram-index] DRY_RUN：表 ${TABLE} 不存在，本次略過建立。`)
    return
  }

  // 不存在才建立；IF NOT EXISTS 再加一層保險，永不 DROP / 永不覆寫。
  // WITHOUT ROWID + 複合主鍵 = PK 本身就是 bigram 前綴索引，bigram 等值查為有界 range scan。
  // 註：若 D1 拒絕 WITHOUT ROWID，改為去掉該子句並另建
  //   CREATE INDEX IF NOT EXISTS idx_${TABLE}_bigram ON ${TABLE}(bigram);
  const createPath = path.join(outDir, 'bigram-index-create.sql')
  await writeFile(
    createPath,
    `CREATE TABLE IF NOT EXISTS ${TABLE} (\n` +
      `  bigram TEXT NOT NULL,\n` +
      `  section_id INTEGER NOT NULL,\n` +
      `  PRIMARY KEY (bigram, section_id)\n` +
      `) WITHOUT ROWID;\n`,
  )
  d1ExecFile(createPath)
  console.log(`[build-bigram-index] 已建立表 ${TABLE}`)
}

function runD1SectionsQuery(): BigramSectionRow[] {
  console.log(
    `[build-bigram-index] Querying D1 (${D1_FLAG}) database=${D1_DATABASE} for name LIKE '${SPEAKER_LIKE}'...`,
  )
  // 沿用 build-ask-index 的 `sections` view（已含 name / section_content / section_id）。
  // 無 YEARS_BACK cutoff、無 MAX_SECTION_CHARS 上限——全語料全文是重點。
  const speakerLikeForSql = SPEAKER_LIKE.replace(/'/g, "''")
  const sql =
    `SELECT section_id, section_content FROM sections ` +
    `WHERE name LIKE '${speakerLikeForSql}' ` +
    `AND section_content IS NOT NULL ` +
    `AND TRIM(section_content) != '' ` +
    `AND filename GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`
  const rows = d1Query(sql) as BigramSectionRow[]
  console.log(`[build-bigram-index] Got ${rows.length} sections matching name LIKE '${SPEAKER_LIKE}'`)
  return rows
}

async function main(): Promise<void> {
  const outDir = path.resolve('build')
  await mkdir(outDir, { recursive: true })

  await ensureBigramTable(outDir, DRY_RUN)

  const rows = runD1SectionsQuery()
  if (rows.length === 0) {
    throw new Error(
      "Refusing to build empty index — check SPEAKER_LIKE / D1_DATABASE connectivity",
    )
  }

  // 索引：每段提取 distinct keys；df 每段每 key 只計一次。
  const df = new Map<string, number>()
  const perSection: Array<{ id: number; keys: string[] }> = []
  let emptySections = 0
  for (const row of rows) {
    const plain = htmlToPlainText(row.section_content ?? '')
    const keySet = extractIndexKeys(plain)
    if (keySet.size === 0) {
      emptySections++
      continue
    }
    const keys = [...keySet]
    perSection.push({ id: row.section_id, keys })
    for (const k of keys) df.set(k, (df.get(k) ?? 0) + 1)
  }

  // 閘門：只留 df <= BIGRAM_DF_MAX 的 rare keys（罕用專有名詞 DF 小，必留）。
  const keep = new Set<string>()
  for (const [k, c] of df) if (c <= BIGRAM_DF_MAX) keep.add(k)

  const postings: Array<[string, number]> = []
  for (const { id, keys } of perSection) {
    for (const k of keys) if (keep.has(k)) postings.push([k, id])
  }

  const estBytes = postings.reduce(
    (sum, [k, id]) => sum + Buffer.byteLength(`('${k}',${id}),`, 'utf-8'),
    0,
  )
  const 萌典df = df.get('萌典') ?? 0
  console.log(`[build-bigram-index] sections: ${rows.length} (empty keys: ${emptySections})`)
  console.log(`[build-bigram-index] distinct keys: ${df.size}`)
  console.log(`[build-bigram-index] rare keys (df<=${BIGRAM_DF_MAX}): ${keep.size}`)
  console.log(`[build-bigram-index] postings: ${postings.length}`)
  console.log(`[build-bigram-index] est. SQL bytes: ~${(estBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(
    `[build-bigram-index] 萌典 df=${萌典df} ${萌典df > 0 && keep.has('萌典') ? '(retained)' : 萌典df > 0 ? '(GATED OUT — raise BIGRAM_DF_MAX)' : '(absent in corpus)'}`,
  )

  if (DRY_RUN) {
    console.log('[build-bigram-index] DRY_RUN=1 — 不寫 D1，不產生 SQL 檔。')
    return
  }

  if (postings.length === 0) {
    console.log('[build-bigram-index] No rare keys to index; 仍會 DELETE 清空既有表。')
  }

  // 重建 SQL：整表 DELETE + 分批 multi-row INSERT，冪等全量替換我們自己的表。
  // INSERT OR IGNORE：碰上 (bigram, section_id) 主鍵衝突就略過，讓「重試同一分檔」安全冪等。
  const header = `DELETE FROM ${TABLE};\n`
  const inserts: string[] = []
  for (let i = 0; i < postings.length; i += INSERT_CHUNK) {
    const chunk = postings.slice(i, i + INSERT_CHUNK)
    const values = chunk
      .map(([k, id]) => `(${sqlString(k)},${id})`)
      .join(',')
    inserts.push(`INSERT OR IGNORE INTO ${TABLE} (bigram, section_id) VALUES ${values};\n`)
  }

  // 關鍵修正：不再把整批塞進「單一」遠端匯入（會逾時 → Not currently importing anything），
  // 而是把 DELETE + INSERT 切成多個小檔（各 <= IMPORT_FILE_MAX_BYTES）依序匯入。
  // DELETE 放在第一個分檔開頭：任何一檔失敗整體即失敗、CI 報錯，下次重跑會先 DELETE 清空，仍冪等。
  const fileBodies: string[] = []
  let body = header
  for (const stmt of inserts) {
    const bodyBytes = Buffer.byteLength(body, 'utf-8')
    const stmtBytes = Buffer.byteLength(stmt, 'utf-8')
    // 目前分檔非空、且再加一條會超標，就先收檔、開新檔（新檔不再帶 header）。
    // 守住 body.length > 0：避免單一 INSERT 本身就大於上限時陷入空檔死迴圈。
    if (body.length > 0 && bodyBytes + stmtBytes > IMPORT_FILE_MAX_BYTES) {
      fileBodies.push(body)
      body = ''
    }
    body += stmt
  }
  if (body.length > 0) fileBodies.push(body)

  const totalParts = fileBodies.length
  console.log(
    `[build-bigram-index] ${postings.length} rows → ${inserts.length} INSERT(s) → ` +
      `${totalParts} import 分檔（每檔 <= ${(IMPORT_FILE_MAX_BYTES / 1024 / 1024).toFixed(1)} MB）`,
  )
  for (let i = 0; i < totalParts; i++) {
    const partPath = path.join(outDir, `bigram-index.part${String(i + 1).padStart(3, '0')}.sql`)
    await writeFile(partPath, fileBodies[i])
    const mb = (Buffer.byteLength(fileBodies[i], 'utf-8') / 1024 / 1024).toFixed(2)
    console.log(
      `[build-bigram-index] Importing ${path.basename(partPath)} (${i + 1}/${totalParts}, ${mb} MB)...`,
    )
    d1ExecFileWithRetry(partPath)
  }
  console.log(
    `[build-bigram-index] Applied ${totalParts} 分檔到 ${D1_DATABASE} (${D1_FLAG}).`,
  )
  console.log('[build-bigram-index] Done.')
}

main().catch((err) => {
  console.error('[build-bigram-index] Fatal:', err)
  process.exitCode = 1
})
