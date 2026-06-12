-- Issue #27 — 超量／異常請求追蹤 log 與黑名單（兩張表）。
--
-- 套用方式（資料庫已由 npm run abuse:db:create 建立）：
--   npm run abuse:db:init          # 遠端（production）
--   npm run abuse:db:init:local    # 本機 wrangler dev 用
--
-- 冪等：全部使用 IF NOT EXISTS，重跑安全、絕不 DROP。

-- 表 1：每次「單一 IP/Id 超量」（rate_limit）或「問題字串過長」（question_too_long）
-- 自動寫入一筆。全域配額用罄不算異常、不會寫入。
CREATE TABLE IF NOT EXISTS abuse_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,           -- 正規化身分 key（與限流 key 同一套）：
                               --   ip:<IPv4>、ip6:<IPv6 /64>、line:<userId>、
                               --   line:group:<groupId>、line:room:<roomId>
  kind TEXT NOT NULL,          -- 'rate_limit' | 'question_too_long'
  path TEXT NOT NULL,          -- 'ask' | 'cag' | 'webhook'
  question TEXT NOT NULL,      -- 問題內容（截斷至 200 碼點，避免超長字串塞爆 D1）
  ip TEXT,                     -- 來源 IP（網頁/API 若有；LINE 事件拿不到使用者 IP）
  line_id TEXT,                -- LINE userId 或 groupId/roomId（若有）
  created_at INTEGER NOT NULL  -- 時間戳記（epoch 毫秒，UTC）
);
-- 供「同一 key 於視窗內出現幾次」的門檻計數查詢。
CREATE INDEX IF NOT EXISTS idx_abuse_log_key_created_at ON abuse_log (key, created_at);
-- 供報表依時間掃描。
CREATE INDEX IF NOT EXISTS idx_abuse_log_created_at ON abuse_log (created_at);

-- 表 2：黑名單。同一 key 在計數視窗（預設 24 小時）內累積達門檻（預設 3）次
-- 異常時自動寫入。在黑名單內的請求會在「任何 DO/KV 限流記帳之前」直接擋下，
-- 不消耗全域生成額度，以保障善意使用者。
-- 解除封鎖：npm run abuse:unban -- <key>（會同時清掉 abuse_log 的舊紀錄，
-- 否則計數仍達門檻，下次再犯立即回到黑名單）。
CREATE TABLE IF NOT EXISTS blacklist (
  key TEXT PRIMARY KEY,            -- 同 abuse_log.key
  reason TEXT NOT NULL,            -- 觸發封鎖的最後一種異常 kind
  offense_count INTEGER NOT NULL,  -- 寫入當下視窗內的累計異常次數
  created_at INTEGER NOT NULL      -- 寫入時間（epoch 毫秒，UTC）
);
