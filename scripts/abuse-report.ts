/**
 * Issue #27 — 近端分析異常請求 log，產出 HTML 視覺化報告。
 *
 * 從 D1（abuse_log + blacklist）撈資料，於本機聚合後輸出單檔 HTML
 * （純 inline CSS 長條圖與表格，無任何外部依賴），預設寫到
 * build/abuse-report.html。
 *
 * 用法（從 repo 根目錄）：
 *   npm run abuse:report             # 遠端（production）資料
 *   LOCAL=1 npm run abuse:report     # 本機 wrangler dev 的 D1
 *
 * 選填環境變數：
 *   ABUSE_D1_DATABASE        D1 資料庫名（預設 askit-abuse-log）
 *   REPORT_DAYS              每日趨勢圖回看天數（預設 14）
 *   REPORT_MAX_ROWS          最多撈取最近幾筆 log（預設 5000，避免一次撈爆）
 *   REPORT_TZ_OFFSET_HOURS   報表顯示時區位移（預設 8 = 台北時間）
 *   REPORT_OUT               輸出路徑（預設 build/abuse-report.html）
 *   WRANGLER_USE_API_TOKEN=1  wrangler 子行程強制使用 CLOUDFLARE_API_TOKEN（CI 自動啟用）
 */
import { execSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildWranglerEnv } from './wranglerEnv'

const WRANGLER_ENV = buildWranglerEnv()
const D1_DATABASE = process.env.ABUSE_D1_DATABASE ?? 'askit-abuse-log'
const D1_FLAG = process.env.LOCAL === '1' ? '--local' : '--remote'
const REPORT_DAYS = Math.max(1, Number(process.env.REPORT_DAYS ?? '14'))
const REPORT_MAX_ROWS = Math.max(1, Number(process.env.REPORT_MAX_ROWS ?? '5000'))
const TZ_OFFSET_HOURS = Number(process.env.REPORT_TZ_OFFSET_HOURS ?? '8')
const OUT_PATH = process.env.REPORT_OUT ?? path.join('build', 'abuse-report.html')

const RECENT_TABLE_LIMIT = 100
const TOP_OFFENDERS_LIMIT = 20

// ── D1 CLI（沿用 vectorize-sync 的 execSync + --json envelope 解析）────────────
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

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

function d1Query(sql: string): Record<string, unknown>[] {
  const cmd =
    `npx wrangler d1 execute ${shellQuote(D1_DATABASE)} ${D1_FLAG} ` +
    `--json --command ${shellQuote(sql)}`
  const out = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256, env: WRANGLER_ENV })
  return parseD1Json(out).results ?? []
}

// ── 資料模型 ─────────────────────────────────────────────────────────────────
type LogRow = {
  key: string
  kind: string
  path: string
  question: string
  ip: string | null
  line_id: string | null
  created_at: number
}

type BlacklistRow = {
  key: string
  reason: string
  offense_count: number
  created_at: number
}

// ── 時間與輸出小工具 ─────────────────────────────────────────────────────────
const TZ_MS = TZ_OFFSET_HOURS * 3_600_000

function toLocalDate(ms: number): string {
  return new Date(ms + TZ_MS).toISOString().slice(0, 10)
}

function toLocalDateTime(ms: number): string {
  const iso = new Date(ms + TZ_MS).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function clipText(s: string, max: number): string {
  const chars = [...s]
  return chars.length <= max ? s : `${chars.slice(0, max).join('')}…`
}

const KIND_LABELS: Record<string, string> = {
  rate_limit: '超量（限流觸發）',
  question_too_long: '問題字串過長',
}

const KIND_COLORS: Record<string, string> = {
  rate_limit: '#e4572e',
  question_too_long: '#2e86ab',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? '#888'
}

// ── 報告 HTML ────────────────────────────────────────────────────────────────
function renderStackedBar(
  byKind: Map<string, number>,
  total: number,
  maxTotal: number,
): string {
  if (total === 0 || maxTotal === 0) return '<div class="bar"></div>'
  const widthPct = (total / maxTotal) * 100
  const segments = [...byKind.entries()]
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => {
      const pct = (n / total) * 100
      return (
        `<span class="seg" style="width:${pct.toFixed(2)}%;background:${kindColor(kind)}" ` +
        `title="${escapeHtml(kindLabel(kind))}：${n}"></span>`
      )
    })
    .join('')
  return `<div class="bar" style="width:${widthPct.toFixed(2)}%">${segments}</div>`
}

function buildHtml(input: {
  logs: LogRow[]
  blacklist: BlacklistRow[]
  totalLogCount: number
  generatedAt: number
}): string {
  const { logs, blacklist, totalLogCount, generatedAt } = input

  // 聚合（皆以撈取到的最近 REPORT_MAX_ROWS 筆為範圍）。
  const uniqueKeys = new Set(logs.map((r) => r.key))
  const last24h = logs.filter((r) => generatedAt - r.created_at <= 86_400_000).length

  const kindCounts = new Map<string, number>()
  const pathCounts = new Map<string, number>()
  for (const r of logs) {
    kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1)
    pathCounts.set(r.path, (pathCounts.get(r.path) ?? 0) + 1)
  }

  // 每日趨勢（近 REPORT_DAYS 天，含當天；以報表時區切日）。
  const days: string[] = []
  for (let i = REPORT_DAYS - 1; i >= 0; i--) {
    days.push(toLocalDate(generatedAt - i * 86_400_000))
  }
  const daily = new Map<string, Map<string, number>>(days.map((d) => [d, new Map()]))
  for (const r of logs) {
    const day = toLocalDate(r.created_at)
    const bucket = daily.get(day)
    if (bucket) bucket.set(r.kind, (bucket.get(r.kind) ?? 0) + 1)
  }
  const dailyTotals = days.map((d) => {
    const bucket = daily.get(d) ?? new Map<string, number>()
    return { day: d, byKind: bucket, total: [...bucket.values()].reduce((a, b) => a + b, 0) }
  })
  const maxDaily = Math.max(1, ...dailyTotals.map((d) => d.total))

  // Top offenders。
  type Offender = { key: string; total: number; byKind: Map<string, number>; lastAt: number }
  const offenderMap = new Map<string, Offender>()
  for (const r of logs) {
    const o = offenderMap.get(r.key) ?? { key: r.key, total: 0, byKind: new Map(), lastAt: 0 }
    o.total += 1
    o.byKind.set(r.kind, (o.byKind.get(r.kind) ?? 0) + 1)
    o.lastAt = Math.max(o.lastAt, r.created_at)
    offenderMap.set(r.key, o)
  }
  const offenders = [...offenderMap.values()]
    .sort((a, b) => b.total - a.total || b.lastAt - a.lastAt)
    .slice(0, TOP_OFFENDERS_LIMIT)
  const maxOffender = Math.max(1, ...offenders.map((o) => o.total))
  const blacklistedKeys = new Set(blacklist.map((b) => b.key))

  const recent = logs.slice(0, RECENT_TABLE_LIMIT)

  const legend = Object.keys(KIND_LABELS)
    .map(
      (kind) =>
        `<span class="legend-item"><span class="dot" style="background:${kindColor(kind)}"></span>${escapeHtml(kindLabel(kind))}</span>`,
    )
    .join('')

  const truncatedNote =
    totalLogCount > logs.length
      ? `<p class="note">⚠️ log 共 ${totalLogCount} 筆，本報告僅分析最近 ${logs.length} 筆（REPORT_MAX_ROWS=${REPORT_MAX_ROWS}）。</p>`
      : ''

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>異常請求分析報告 — ${escapeHtml(D1_DATABASE)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Noto Sans TC", "PingFang TC", sans-serif;
         margin: 0; background: #f5f6f8; color: #1c2330; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 36px 0 12px; border-left: 4px solid #2e86ab; padding-left: 8px; }
  .meta { color: #5b6575; font-size: .85rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card .num { font-size: 1.7rem; font-weight: 700; }
  .card .label { color: #5b6575; font-size: .85rem; margin-top: 2px; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 10px;
          overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: .88rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { background: #eef3f7; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: #f0f2f5; border-radius: 4px; padding: 1px 5px; font-size: .85em; word-break: break-all; }
  .chart { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .chart-row { display: grid; grid-template-columns: 96px 1fr 48px; gap: 8px; align-items: center; margin: 4px 0; }
  .chart-row .day { font-size: .82rem; color: #5b6575; font-variant-numeric: tabular-nums; }
  .chart-row .count { font-size: .82rem; text-align: right; font-variant-numeric: tabular-nums; }
  .track { background: #f0f2f5; border-radius: 4px; min-height: 16px; }
  .bar { display: flex; height: 16px; border-radius: 4px; overflow: hidden; min-width: 2px; }
  .seg { display: block; height: 100%; }
  .legend { margin: 10px 0 0; font-size: .82rem; color: #5b6575; }
  .legend-item { margin-right: 16px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .badge { display: inline-block; background: #c0392b; color: #fff; border-radius: 4px;
           font-size: .72rem; padding: 1px 6px; margin-left: 6px; vertical-align: 1px; }
  .note { color: #8a6d1a; background: #fff8e1; border-radius: 8px; padding: 10px 12px; font-size: .85rem; }
  .empty { color: #5b6575; background: #fff; border-radius: 10px; padding: 14px 16px;
           box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: .9rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>異常請求分析報告</h1>
  <p class="meta">資料庫：<code>${escapeHtml(D1_DATABASE)}</code>（${D1_FLAG === '--local' ? '本機' : '遠端'}）
    ｜產生時間：${toLocalDateTime(generatedAt)}（UTC${TZ_OFFSET_HOURS >= 0 ? '+' : ''}${TZ_OFFSET_HOURS}）</p>
  ${truncatedNote}

  <div class="cards">
    <div class="card"><div class="num">${totalLogCount}</div><div class="label">異常事件總數</div></div>
    <div class="card"><div class="num">${last24h}</div><div class="label">近 24 小時事件</div></div>
    <div class="card"><div class="num">${uniqueKeys.size}</div><div class="label">不同來源（key）數</div></div>
    <div class="card"><div class="num">${blacklist.length}</div><div class="label">黑名單筆數</div></div>
  </div>

  <h2>每日事件數（近 ${REPORT_DAYS} 天）</h2>
  <div class="chart">
    ${dailyTotals
      .map(
        (d) => `<div class="chart-row">
      <span class="day">${d.day}</span>
      <span class="track">${renderStackedBar(d.byKind, d.total, maxDaily)}</span>
      <span class="count">${d.total}</span>
    </div>`,
      )
      .join('\n    ')}
    <div class="legend">${legend}</div>
  </div>

  <h2>異常類型與路徑分佈</h2>
  <table>
    <tr><th>異常類型</th><th class="num">次數</th><th>路徑</th><th class="num">次數</th></tr>
    ${(() => {
      const kinds = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])
      const paths = [...pathCounts.entries()].sort((a, b) => b[1] - a[1])
      const rows = Math.max(kinds.length, paths.length, 1)
      const cells: string[] = []
      for (let i = 0; i < rows; i++) {
        const k = kinds[i]
        const p = paths[i]
        cells.push(
          `<tr><td>${k ? escapeHtml(kindLabel(k[0])) : ''}</td><td class="num">${k ? k[1] : ''}</td>` +
            `<td>${p ? `<code>/${escapeHtml(p[0])}</code>` : ''}</td><td class="num">${p ? p[1] : ''}</td></tr>`,
        )
      }
      return cells.join('\n    ')
    })()}
  </table>

  <h2>最常觸發的來源（Top ${TOP_OFFENDERS_LIMIT}）</h2>
  ${
    offenders.length === 0
      ? '<div class="empty">（無資料）</div>'
      : `<table>
    <tr><th>來源 key</th><th class="num">次數</th><th style="width:30%">分佈</th><th>最後發生</th></tr>
    ${offenders
      .map(
        (o) => `<tr>
      <td><code>${escapeHtml(o.key)}</code>${blacklistedKeys.has(o.key) ? '<span class="badge">黑名單</span>' : ''}</td>
      <td class="num">${o.total}</td>
      <td><span class="track" style="display:block">${renderStackedBar(o.byKind, o.total, maxOffender)}</span></td>
      <td>${toLocalDateTime(o.lastAt)}</td>
    </tr>`,
      )
      .join('\n    ')}
  </table>`
  }

  <h2>黑名單（${blacklist.length} 筆）</h2>
  ${
    blacklist.length === 0
      ? '<div class="empty">（目前沒有黑名單）</div>'
      : `<table>
    <tr><th>來源 key</th><th>觸發原因</th><th class="num">當下累計</th><th>寫入時間</th></tr>
    ${blacklist
      .map(
        (b) => `<tr>
      <td><code>${escapeHtml(b.key)}</code></td>
      <td>${escapeHtml(kindLabel(b.reason))}</td>
      <td class="num">${b.offense_count}</td>
      <td>${toLocalDateTime(b.created_at)}</td>
    </tr>`,
      )
      .join('\n    ')}
  </table>
  <p class="meta" style="margin-top:8px">解除封鎖：<code>npm run abuse:unban -- &lt;key&gt;</code>（會同時清掉該 key 的 log 舊紀錄）</p>`
  }

  <h2>最近 ${recent.length} 筆事件</h2>
  ${
    recent.length === 0
      ? '<div class="empty">（無資料）</div>'
      : `<table>
    <tr><th>時間</th><th>來源 key</th><th>類型</th><th>路徑</th><th>問題（截斷）</th><th>IP / LINE Id</th></tr>
    ${recent
      .map(
        (r) => `<tr>
      <td style="white-space:nowrap">${toLocalDateTime(r.created_at)}</td>
      <td><code>${escapeHtml(r.key)}</code></td>
      <td style="white-space:nowrap"><span class="dot" style="background:${kindColor(r.kind)}"></span>${escapeHtml(kindLabel(r.kind))}</td>
      <td style="white-space:nowrap"><code>/${escapeHtml(r.path)}</code></td>
      <td>${escapeHtml(clipText(r.question, 80))}</td>
      <td>${escapeHtml(r.ip ?? r.line_id ?? '')}</td>
    </tr>`,
      )
      .join('\n    ')}
  </table>`
  }
</div>
</body>
</html>
`
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[abuse-report] 從 D1 (${D1_FLAG}) ${D1_DATABASE} 撈取資料…`)

  const totalRow = d1Query('SELECT COUNT(*) AS n FROM abuse_log')
  const totalLogCount = Number(totalRow[0]?.n ?? 0)

  const logs = d1Query(
    'SELECT key, kind, path, question, ip, line_id, created_at FROM abuse_log ' +
      `ORDER BY created_at DESC LIMIT ${REPORT_MAX_ROWS}`,
  ) as unknown as LogRow[]

  const blacklist = d1Query(
    'SELECT key, reason, offense_count, created_at FROM blacklist ORDER BY created_at DESC',
  ) as unknown as BlacklistRow[]

  console.log(
    `[abuse-report] log ${totalLogCount} 筆（分析最近 ${logs.length} 筆）、黑名單 ${blacklist.length} 筆`,
  )

  const html = buildHtml({ logs, blacklist, totalLogCount, generatedAt: Date.now() })
  await mkdir(path.dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, html)
  console.log(`[abuse-report] 報告已輸出：${OUT_PATH}`)
}

main().catch((err) => {
  console.error('[abuse-report] Fatal:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
