// Issue #27 — 對超量或異常的請求建立 D1 追蹤 log 與黑名單。
//
// 兩張表（schema 見 db/abuse-log-schema.sql）：
//   - abuse_log：每次「單一 IP/Id 超量」（rate_limit）或「問題字串過長」
//     （question_too_long）自動寫入一筆。全域配額用罄不算異常、不寫入。
//   - blacklist：同一 key 在計數視窗（預設 24 小時）內累積達門檻（預設 3）次
//     異常時，於同一個 batch 交易內自動寫入。
//
// 黑名單比對發生在「任何 DO/KV 限流記帳之前」：被封鎖的請求直接擋下，
// 不消耗全域生成額度，以保障善意使用者（呼叫端見 src/index.ts）。
//
// 與專案其他基礎設施一致的優雅降級：ABUSE_DB 未綁（dev／測試）或讀寫發生錯誤時，
// 黑名單視為未命中、寫 log 靜默略過，絕不讓追蹤機制阻斷正常請求。

export type AbuseKind = 'rate_limit' | 'question_too_long'
export type AbusePath = 'ask' | 'cag' | 'webhook'

export type AbuseLogEntry = {
  /** 正規化身分 key（ip:…／ip6:…／line:…），與限流 key 同一套，方便比對。 */
  key: string
  kind: AbuseKind
  path: AbusePath
  question: string
  /** 來源 IP（網頁/API 若有；LINE 事件拿不到使用者 IP）。 */
  ip?: string
  /** LINE userId 或 groupId/roomId（若有）。 */
  lineId?: string
}

export type AbuseThresholdOptions = {
  /** 視窗內累積達此次數即寫入黑名單。 */
  threshold: number
  /** 計數視窗（毫秒）；0 = 不限視窗、全期間計數。 */
  windowMs: number
}

export const DEFAULT_ABUSE_BLACKLIST_THRESHOLD = 3
// issue 原文只說「出現大於等於 3 次」未指定視窗；預設以 24 小時視窗計數，
// 避免偶爾連發兩則訊息的善意使用者因「終生累計」3 次就被永久封鎖。
// 設 ABUSE_COUNT_WINDOW_HOURS=0 可改為全期間累計（嚴格按 issue 字面）。
export const DEFAULT_ABUSE_COUNT_WINDOW_HOURS = 24
/** log 內 question 欄位的長度上限（碼點）：超長攻擊字串只留頭部供分析。 */
export const MAX_LOGGED_QUESTION_CHARS = 200

export function truncateQuestionForLog(question: string): string {
  const chars = [...question.trim()]
  if (chars.length <= MAX_LOGGED_QUESTION_CHARS) return chars.join('')
  return `${chars.slice(0, MAX_LOGGED_QUESTION_CHARS).join('')}…`
}

// 黑名單比對。每個請求一次 point read；查詢失敗時 fail-open（視為未在黑名單），
// 寧可放過也不誤擋。
export async function isBlacklisted(
  db: D1Database | undefined,
  key: string,
): Promise<boolean> {
  if (!db) return false
  try {
    const row = await db
      .prepare('SELECT key FROM blacklist WHERE key = ?1')
      .bind(key)
      .first()
    return row !== null
  } catch (e) {
    console.error('黑名單查詢失敗，視為未在黑名單:', e)
    return false
  }
}

// 寫入一筆異常紀錄，並在同一個 batch 交易內檢查門檻、自動寫入黑名單。
// 第二句 INSERT…SELECT 的計數包含第一句剛插入的那筆；ON CONFLICT DO NOTHING
// 讓已在黑名單的 key 重跑安全（理論上不會發生：黑名單成員在更上游就被擋下）。
export async function recordAbuse(
  db: D1Database | undefined,
  entry: AbuseLogEntry,
  options: AbuseThresholdOptions,
): Promise<void> {
  if (!db) return
  const now = Date.now()
  const windowStart = options.windowMs > 0 ? now - options.windowMs : 0
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO abuse_log (key, kind, path, question, ip, line_id, created_at) ' +
            'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
        )
        .bind(
          entry.key,
          entry.kind,
          entry.path,
          truncateQuestionForLog(entry.question),
          entry.ip ?? null,
          entry.lineId ?? null,
          now,
        ),
      // 子查詢先算出視窗內次數，外層 WHERE 過門檻才插入。
      // （SQLite 的 upsert 文法要求 INSERT…SELECT 帶 WHERE 子句以消除與 join 的歧義。）
      db
        .prepare(
          'INSERT INTO blacklist (key, reason, offense_count, created_at) ' +
            'SELECT ?1, ?2, cnt, ?3 FROM ' +
            '(SELECT COUNT(*) AS cnt FROM abuse_log WHERE key = ?1 AND created_at >= ?4) ' +
            'WHERE cnt >= ?5 ' +
            'ON CONFLICT(key) DO NOTHING',
        )
        .bind(entry.key, entry.kind, now, windowStart, options.threshold),
    ])
  } catch (e) {
    console.error('異常請求 log 寫入失敗，略過:', e)
  }
}
