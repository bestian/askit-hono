import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  DEFAULT_ABUSE_BLACKLIST_THRESHOLD,
  isBlacklisted,
  MAX_LOGGED_QUESTION_CHARS,
  recordAbuse,
  truncateQuestionForLog,
} from '../src/utils/abuse'

// 以 node:sqlite 跑「真的」schema 與 SQL：用最小 D1 介面（prepare/bind/first/batch）
// 包住 DatabaseSync，讓 recordAbuse / isBlacklisted 的 SQL 在真 SQLite 上驗證，
// 而不是只驗證有呼叫過假物件。D1 的 ?N 參數與 node:sqlite 的位置綁定相容。
function createSqliteBackedD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(path.resolve('db/abuse-log-schema.sql'), 'utf-8'))
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...params: (string | number | null)[]) {
          return {
            async first() {
              return db.prepare(sql).get(...params) ?? null
            },
            run() {
              db.prepare(sql).run(...params)
            },
          }
        },
      }
    },
    async batch(stmts: { run: () => void }[]) {
      for (const s of stmts) s.run()
    },
  }
  return { db, d1: d1 as never as D1Database }
}

const OPTIONS = { threshold: DEFAULT_ABUSE_BLACKLIST_THRESHOLD, windowMs: 24 * 3_600_000 }

function entry(overrides: Record<string, unknown> = {}) {
  return {
    key: 'ip:1.2.3.4',
    kind: 'rate_limit' as const,
    path: 'ask' as const,
    question: '測試問題',
    ip: '1.2.3.4',
    ...overrides,
  }
}

test('truncateQuestionForLog 短問題原樣保留、超長截斷加省略號', () => {
  assert.equal(truncateQuestionForLog('  hello  '), 'hello')
  const long = 'あ'.repeat(MAX_LOGGED_QUESTION_CHARS + 50)
  const truncated = truncateQuestionForLog(long)
  assert.equal([...truncated].length, MAX_LOGGED_QUESTION_CHARS + 1)
  assert.ok(truncated.endsWith('…'))
})

test('未綁 ABUSE_DB 時優雅降級：不在黑名單、寫 log 靜默略過', async () => {
  assert.equal(await isBlacklisted(undefined, 'ip:1.2.3.4'), false)
  await recordAbuse(undefined, entry(), OPTIONS) // 不應拋出
})

test('查詢/寫入錯誤時 fail-open，不阻斷請求', async () => {
  const broken = {
    prepare() {
      throw new Error('boom')
    },
    async batch() {
      throw new Error('boom')
    },
  } as never as D1Database
  assert.equal(await isBlacklisted(broken, 'ip:1.2.3.4'), false)
  await recordAbuse(broken, entry(), OPTIONS) // 不應拋出
})

test('每筆異常都寫入 abuse_log，欄位完整', async () => {
  const { db, d1 } = createSqliteBackedD1()
  await recordAbuse(d1, entry({ question: ' 問題A ' }), OPTIONS)
  const rows = db.prepare('SELECT * FROM abuse_log').all() as Record<string, unknown>[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'ip:1.2.3.4')
  assert.equal(rows[0].kind, 'rate_limit')
  assert.equal(rows[0].path, 'ask')
  assert.equal(rows[0].question, '問題A')
  assert.equal(rows[0].ip, '1.2.3.4')
  assert.equal(rows[0].line_id, null)
  assert.ok(typeof rows[0].created_at === 'number' && rows[0].created_at > 0)
})

test('同一 key 達 3 次自動進黑名單，第 3 次之前不進', async () => {
  const { db, d1 } = createSqliteBackedD1()
  await recordAbuse(d1, entry(), OPTIONS)
  assert.equal(await isBlacklisted(d1, 'ip:1.2.3.4'), false)
  await recordAbuse(d1, entry({ kind: 'question_too_long', path: 'cag' }), OPTIONS)
  assert.equal(await isBlacklisted(d1, 'ip:1.2.3.4'), false)
  await recordAbuse(d1, entry(), OPTIONS)
  assert.equal(await isBlacklisted(d1, 'ip:1.2.3.4'), true)

  const bl = db.prepare('SELECT * FROM blacklist').all() as Record<string, unknown>[]
  assert.equal(bl.length, 1)
  assert.equal(bl[0].key, 'ip:1.2.3.4')
  assert.equal(bl[0].reason, 'rate_limit') // 第 3 次（觸發封鎖）的 kind
  assert.equal(bl[0].offense_count, 3)
})

test('不同 key 各自計數，互不影響', async () => {
  const { d1 } = createSqliteBackedD1()
  await recordAbuse(d1, entry(), OPTIONS)
  await recordAbuse(d1, entry(), OPTIONS)
  await recordAbuse(d1, entry({ key: 'line:U123', ip: undefined, lineId: 'U123', path: 'webhook' }), OPTIONS)
  assert.equal(await isBlacklisted(d1, 'ip:1.2.3.4'), false)
  assert.equal(await isBlacklisted(d1, 'line:U123'), false)
})

test('已在黑名單的 key 再寫入不報錯、黑名單維持一筆（ON CONFLICT DO NOTHING）', async () => {
  const { db, d1 } = createSqliteBackedD1()
  for (let i = 0; i < 5; i++) await recordAbuse(d1, entry(), OPTIONS)
  const bl = db.prepare('SELECT * FROM blacklist').all() as Record<string, unknown>[]
  assert.equal(bl.length, 1)
  assert.equal(bl[0].offense_count, 3) // 第 3 次寫入當下的累計，之後不再更新
})

test('視窗外的舊紀錄不列入計數', async () => {
  const { db, d1 } = createSqliteBackedD1()
  // 直接塞兩筆「視窗外」的舊 log（48 小時前）。
  const old = Date.now() - 48 * 3_600_000
  const insert = db.prepare(
    'INSERT INTO abuse_log (key, kind, path, question, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  insert.run('ip:1.2.3.4', 'rate_limit', 'ask', 'q', old)
  insert.run('ip:1.2.3.4', 'rate_limit', 'ask', 'q', old)
  // 視窗內第 1 筆（總計第 3 筆）：24 小時視窗內僅 1 筆 → 不封鎖。
  await recordAbuse(d1, entry(), OPTIONS)
  assert.equal(await isBlacklisted(d1, 'ip:1.2.3.4'), false)
  // windowMs=0（全期間累計）時，同樣的第 4 筆就會達門檻。
  await recordAbuse(d1, entry(), { ...OPTIONS, windowMs: 0 })
  assert.equal(await isBlacklisted(d1, 'ip:1.2.3.4'), true)
})

test('超長問題寫入 log 前會截斷', async () => {
  const { db, d1 } = createSqliteBackedD1()
  await recordAbuse(d1, entry({ question: 'x'.repeat(10_000) }), OPTIONS)
  const row = db.prepare('SELECT question FROM abuse_log').get() as { question: string }
  assert.equal([...row.question].length, MAX_LOGGED_QUESTION_CHARS + 1)
})
