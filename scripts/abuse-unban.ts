/**
 * Issue #27 — 把指定 key 從黑名單移除。
 *
 * 會「同時」刪除該 key 在 abuse_log 的舊紀錄：因為黑名單門檻是以 log 計數判斷，
 * 若只刪黑名單、留著 log，該 key 下次再觸發一次異常就會立刻回到黑名單。
 *
 * 用法（從 repo 根目錄）：
 *   npm run abuse:unban -- ip:1.2.3.4
 *   npm run abuse:unban -- line:U1234567890abcdef
 *   LOCAL=1 npm run abuse:unban -- ip:1.2.3.4    # 本機 wrangler dev 的 D1
 *
 * 選填環境變數：
 *   ABUSE_D1_DATABASE   D1 資料庫名（預設 askit-abuse-log）
 *   WRANGLER_USE_API_TOKEN=1  wrangler 子行程強制使用 CLOUDFLARE_API_TOKEN（CI 自動啟用）
 */
import { execSync } from 'node:child_process'
import { buildWranglerEnv } from './wranglerEnv'

const WRANGLER_ENV = buildWranglerEnv()
const D1_DATABASE = process.env.ABUSE_D1_DATABASE ?? 'askit-abuse-log'
const D1_FLAG = process.env.LOCAL === '1' ? '--local' : '--remote'

// 合法 key 形態：ip:1.2.3.4、ip6:1a2b:3c4d:5e6f:7a8b::/64、line:U…、line:group:C…。
// 白名單字元（含 : . / -），其餘一律拒絕（防 SQL 注入；wrangler CLI 無 bind 參數可用）。
const KEY_RE = /^[A-Za-z0-9:./_-]+$/

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function d1Command(sql: string): void {
  const cmd =
    `npx wrangler d1 execute ${shellQuote(D1_DATABASE)} ${D1_FLAG} ` +
    `--command ${shellQuote(sql)} --yes`
  execSync(cmd, { stdio: 'inherit', env: WRANGLER_ENV })
}

const key = process.argv[2]
if (!key) {
  console.error('用法：npm run abuse:unban -- <key>（例如 ip:1.2.3.4、line:U…）')
  process.exit(1)
}
if (!KEY_RE.test(key)) {
  console.error(`key 含有不允許的字元：${key}`)
  process.exit(1)
}

console.log(`[abuse-unban] 從 D1 (${D1_FLAG}) ${D1_DATABASE} 移除 ${key} …`)
d1Command(
  `DELETE FROM blacklist WHERE key = ${sqlString(key)}; ` +
    `DELETE FROM abuse_log WHERE key = ${sqlString(key)};`,
)
console.log(`[abuse-unban] 完成。${key} 已自黑名單與 abuse_log 移除。`)
