# 鳳問 · Ask Audrey Anything

[![CI](https://github.com/bestian/askit-hono/actions/workflows/ci.yml/badge.svg)](https://github.com/bestian/askit-hono/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**[English](README.md) | 華語**

向唐鳳問任何問題——AI 從她三十年的公開逐字稿（[archive.tw](https://archive.tw)）檢索作答，每句都附出處。

**立即試用 → <https://ask.archive.tw>**（English: <https://ask.archive.tw/en>）·
也提供 LINE bot。

| English (`/en`) | 華語 (`/`) |
| --- | --- |
| ![Ask Audrey Anything English UI](docs/img/home-en.png) | ![鳳問華語介面](docs/img/home-zh.png) |

## 運作方式

![CAG 系統設計](design/CAG-system-design.svg)

- **檢索** — 問題先以 `@cf/google/embeddinggemma-300m`（768 維）轉成向量，到
  Vectorize 索引 `askit-audrey-tang`（cosine）找最相近的段落，再透過
  archive.tw 的 section API 取回前後文。Vectorize 未綁定時自動回退
  archive.tw 全文搜尋；已綁定但查無結果時，僅拉丁文字（如英文）問題會回退
  全文搜尋——華語問題則誠實回覆「超出資料庫範圍」。
- **生成** — 由 Cloudflare Workers AI 執行 `@cf/google/gemma-4-26b-a4b-it`
  （寫死在 `src/utils/cagEval.ts`，沒有環境變數可切換）；模型輸出的 `[1]`
  之類標記會改寫成 `[^1]` footnote，連到對應的
  `archive.tw/<speech>#s<section_id>`。
- **LINE bot** — webhook 必須在 2 秒內回 2xx，因此採三段式非同步回覆：
  先立即回 `200 OK`（慢工作交給 `waitUntil`）、再呼叫 `chat/loading/start`
  顯示「輸入中…」動畫、最後用 reply token 呼叫一次 Reply API，送出 Flex
  Message（答案＋最多四張來源卡片）。CAG 失敗時，退回模糊搜尋前兩則
  最相近段落。另以快速字元判別：提問若只含英文與符號（無漢字）就以英文
  作答，連同 Flex 出處標籤（`Source N`／`Visit`）與找不到／限流／字數過長
  等固定提示也一併英文。新好友（follow event）依其 LINE profile 語言收到
  雙語歡迎 Flex（非中文→英文，其餘→繁中）；取不到 `userId` 的 follow 只
  ack 不回覆。
- **快取** — 相同問題直接從 **7 天** R2 答案快取回應（HTTP 標頭
  `X-Cache: HIT`）；檢索來源另以 KV 快取 **1 小時**。
- **防濫用** — 雙層限流（edge limiter 每把 key 10 秒 15 次，之後還有
  per-key Durable Object 冷卻）、全域生成預算（每分鐘 30 次、每日 1000
  次）、30 秒 CPU 上限、嚴格 CSP 與安全標頭。觸發限流或問題過長會寫入
  D1 異常請求 log，累犯自動進黑名單（預設 24 小時內 3 次 → `403`）；
  未綁 `ABUSE_DB` 時優雅降級（不寫 log、黑名單視為空）。LINE 事件若無可
  識別的個別身分（1:1 個人未提供 `userId`，無從限流、也無從加黑名單）一律
  ack 後丟棄；群組／房間有 `groupId`／`roomId` 可識別，正常回應。
- **品質** — 離線 eval harness（`npm run eval:cag`、
  `npm run eval:cag:depth`）在模型或檢索改動上線前，先評估回答深度與
  引據是否退步。

## 功能與路由

| 路由 | 用途 |
| --- | --- |
| `GET /` | 鳳問網頁版（華語）；曾選擇 English 的訪客再次造訪時，會由前端自動導向 `/en` |
| `GET /en` | Ask Audrey Anything 網頁版（英文）；曾選擇華語的訪客會由前端自動導回 `/` |
| `GET /privacy` · `GET /terms` | 法律頁面，華語優先（英文優先版為 `/en/privacy` · `/en/terms`） |
| `GET /cag/status` | 顯示目前的 retriever、archive base URL、模型與 top-k 上限 |
| `GET /cag/:question` | 串流 Markdown 回答，附 footnote 引註 |
| `POST /cag` | JSON 版本：`{ "question": "...", "topK": 6 }`，同樣串流輸出 |
| `GET /ask/:question` | 除錯用：以 R2 Fuse 索引找出最相近的單一段落 |
| `POST /webhook` | LINE Messaging API webhook（三段式非同步回覆） |

## 自行部署

需要 Node.js 22 或更新版本（Wrangler 4.87+ 需要 Node 22）。本 repo 提供
`.nvmrc` 與 `.node-version`，可讓常見版本管理器自動切換。

```bash
npm install
npx wrangler login   # 首次執行會開瀏覽器要求授權
```

### 1. 建立 R2 bucket

Fuse 索引放在 `askit-fuse-index-cache`（preview 對應加 `-preview`）；答案
快取使用獨立的 `askit-answer-cache` bucket（未建立時程式會優雅降級、當作
未命中）：

```bash
npx wrangler r2 bucket create askit-fuse-index-cache
npx wrangler r2 bucket create askit-fuse-index-cache-preview
npx wrangler r2 bucket create askit-answer-cache
npx wrangler r2 bucket create askit-answer-cache-preview
npm run r2:lifecycle   # 對答案快取 bucket 套用 7 天 lifecycle 規則
```

### 2. 建立 Vectorize 索引

```bash
npm run vectorize:create   # askit-audrey-tang，768 維，cosine
npm run vectorize:sync     # 從逐字稿回填 embedding
```

### 3. 建立 KV namespace

檢索來源快取（1 小時 TTL）放在 KV：

```bash
npx wrangler kv namespace create CAG_CACHE
npx wrangler kv namespace create CAG_CACHE --preview
```

把輸出的 id 填回 `wrangler.jsonc` 的 `kv_namespaces` 區塊。

### 4. 建 Fuse 索引並上傳到 R2

```bash
npm run build:index
```

可用環境變數覆蓋：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `D1_DATABASE` | `sayit-database` | D1 資料庫名稱（要與 sayit-hono 相同） |
| `SPEAKER_LIKE` | `唐鳳%` | `speakers.name LIKE` 條件 |
| `R2_BUCKET` | `askit-fuse-index-cache` | 上傳到的 R2 bucket |
| `R2_KEY` | `ask-index/audrey-tang.json` | R2 物件 key |
| `R2_MANIFEST_KEY` | `ask-index/audrey-tang.manifest.json` | 小型 sidecar manifest key，會在索引 JSON 上傳成功後才上傳 |
| `MAX_SECTION_CHARS` | `175` | 只保留純文字長度不超過此值的段落 |
| `YEARS_BACK` | `2` | 只保留最近幾年的逐字稿 |
| `LOCAL=1` | — | 對 D1 下 `--local`（預設 `--remote` 用線上資料庫） |
| `SKIP_UPLOAD=1` | — | 只在 `build/` 產出 JSON 不上傳 |

上傳順序是「大索引 JSON 先、manifest 後」。Worker 只把 manifest 當作版本
訊號，所以不會在 R2 還沒拿到新索引時切換。

### 5. LINE webhook 設定（選用）

只有要跑 LINE bot 才需要；網頁版不用設定就能運作。

<details>
<summary>LINE webhook 設定</summary>

需要兩個 Secret：

| 名稱 | 用途 |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | 呼叫 LINE Reply API 時的 Bearer token |
| `LINE_CHANNEL_SECRET` | 驗證 webhook 請求簽章（HMAC-SHA256 金鑰） |

兩者皆屬於機敏資訊，**不可**寫入 `wrangler.jsonc` 或提交至版本控制。請
上傳到 Cloudflare 帳號（生產環境不會讀 `.dev.vars`）：

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
```

每個指令會提示貼上值，按 Enter 完成。Cloudflare 會將其加密儲存，並在
Worker 執行時以 `c.env.LINE_CHANNEL_ACCESS_TOKEN` /
`c.env.LINE_CHANNEL_SECRET` 注入。可用 `npx wrangler secret list` 確認；
再執行一次 `secret put` 即可覆寫。（Secret 是綁在「已部署的 Worker」上，
實際上要先 `npm run deploy` 一次；secret 還沒設好之前，webhook 會回
`401`。）

取得方式：

1. 至 [LINE Developers Console](https://developers.line.biz/) 建立
   Provider 與 Messaging API Channel
2. **Channel secret**：於 Channel 的「Basic settings」頁籤可看到（複製
   即可）
3. **Channel access token**：於「Messaging API」頁籤底部，發行（Issue）
   一組 long-lived 的 **Channel access token**

部署完成後，將顯示的 Worker URL 加上 `/webhook` 路徑（例如
`https://askit-hono.YOUR-SUBDOMAIN.workers.dev/webhook`）填入 LINE
Developers Console 的「Webhook URL」欄位，並啟用 webhook。可在該頁面按
**Verify** 測試簽章驗證是否通過。

簽章驗證原理：LINE 平台會用你的 Channel secret 對 raw request body 計算
HMAC-SHA256，再以 Base64 編碼放入 `x-line-signature` header。Worker 收到
請求時會用同一把金鑰重新計算，並以等長時間比較。簽章不符（含缺少
header）時會回 `401 Invalid signature`。

`curl` 測 webhook（簽章驗證）：

```bash
SECRET="your-channel-secret"
BODY='{"events":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -X POST https://YOUR-WORKER-URL/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
```

`events` 為空陣列時 Worker 會回 `200 OK`。`/webhook` 一律在 2 秒內 ack，
慢工作改在 `ctx.waitUntil` 背景執行；即使塞入假的 `replyToken`，也只會在
背景記錄 Reply 失敗。要驗證實際回覆，請從 LINE App 傳訊息。

</details>

### 6. 部署

```bash
npm run deploy
```

### 隨 transcript / sayit-hono 更新

本 repo 的 `.github/workflows/refresh-cag-index.yml` 會刷新 `/ask` 與
LINE 退回路徑用的 R2 Fuse 索引；`/cag` 直接讀 archive.tw API，所以在
`sayit-hono` 部署成功後自然讀到新內容。workflow 提供三種入口：

- `repository_dispatch` 的 `sayit-updated` event：給 `transcript` repo 在
  成功上傳 Markdown 並部署 `sayit-hono` 後觸發。
- `workflow_dispatch`：手動重建索引；可勾選 `deploy` 讓 Worker 也一起
  部署，作為立即 cache reset。
- 每日 schedule：漏掉 dispatch 時的保底。

建議在 `transcript` repo 的 `Sync markdown on push` workflow、
`rebuild-search-index` job 成功部署 `sayit-hono` 後加上：

```yaml
- name: Refresh AskIt index
  env:
    GH_TOKEN: ${{ secrets.ASKIT_REBUILD_TOKEN }}
  run: |
    gh api repos/bestian/askit-hono/dispatches \
      -f event_type=sayit-updated \
      -F client_payload[transcript_sha]="${GITHUB_SHA}"
```

`ASKIT_REBUILD_TOKEN` 需要能對 `bestian/askit-hono` 發送 repository
dispatch；細粒度 PAT 可給該 repo `Contents: read/write` 權限。dispatch
進來後，askit-hono workflow 會 `npm run build:index` 上傳新的 R2 索引與
manifest，然後 dry-run 驗證 Worker bundle。線上 Worker 最多在約一分鐘內
看到 manifest 變更並重載 `/ask` 索引；部署只保留為手動 cache reset。

## 本機開發

```bash
cp .dev.vars.example .dev.vars   # 只有測 /webhook（LINE secret）才需要
# 編輯 .dev.vars，填入實際值

npm run dev        # 本機 Worker + 遠端 R2 / Workers AI binding
npm run preview    # wrangler dev --remote，整個 Worker 也跑在 Cloudflare
```

> 注意：`ASK_INDEX` R2 binding 與 `AI` binding 在 `wrangler.jsonc` 裡設為
> `remote: true`。本機測 `/ask` 會讀雲端 preview R2 bucket；本機測 `/cag`
> 會呼叫 archive.tw API 與 Workers AI。這會用到 Cloudflare 帳號配額。若
> preview bucket 還沒有 `/ask` 索引，可先執行：

```bash
npx wrangler r2 object put 'askit-fuse-index-cache-preview/ask-index/audrey-tang.json' \
  --file build/audrey-tang.json \
  --content-type 'application/json; charset=utf-8' \
  --remote
npx wrangler r2 object put 'askit-fuse-index-cache-preview/ask-index/audrey-tang.manifest.json' \
  --file build/audrey-tang.manifest.json \
  --content-type 'application/json; charset=utf-8' \
  --remote
```

開發時可用 `/ask/:question` 直接以瀏覽器或 curl 測：

```bash
curl 'http://127.0.0.1:8787/ask/AI%E6%9C%83%E4%B8%8D%E6%9C%83%E6%8E%A7%E5%88%B6%E6%88%91%E5%80%91'
```

CAG 串流可用：

```bash
curl -N 'https://YOUR-WORKER-URL/cag/%E7%94%A8%20%23zh-tw%20%E5%9B%9E%E7%AD%94%EF%BC%9A%E5%9C%B0%E7%A5%9E%E9%A6%99%E7%81%AB%E5%A6%82%E4%BD%95?top_k=6'
```

## 指令一覽

| 指令 | 用途 |
| --- | --- |
| `npm run dev` / `npm run preview` | 本機 Worker（遠端 R2／AI binding）／完全跑在 Cloudflare |
| `npm run deploy` | 部署到 Cloudflare Workers |
| `npm test` / `npm run typecheck` | Node 測試套件／TypeScript 檢查 |
| `npm run build:index` | 從 D1 建 Fuse 索引並上傳 R2 |
| `npm run vectorize:create` / `vectorize:sync` | 建立／回填 Vectorize 索引 |
| `npm run eval:cag` / `eval:cag:depth` | 模型／檢索深度 eval harness |
| `npm run r2:lifecycle` | 對答案快取 bucket 套用 7 天 lifecycle |
| `npm run abuse:db:create` / `abuse:db:init` | 建立／初始化 `askit-abuse-log` D1 資料庫（`:local` 為本機） |
| `npm run abuse:report` | 分析異常請求 log → `build/abuse-report.html`（`LOCAL=1` 讀本機 D1） |
| `npm run abuse:unban -- <key>` | 解除封鎖（同時清掉該 key 的舊 log 紀錄） |
| `npm run tail` | 即時看 Worker log |

## 專案結構

```
.
├── src/
│   ├── index.ts                   # Hono app：路由、webhook、限流
│   ├── pages/                     # Server-rendered 頁面（home/privacy/terms，zh + en）
│   └── utils/
│       ├── cag.ts                 # CAG 檢索 + 生成 + 引註
│       ├── vectorize.ts           # Embedding + Vectorize 查詢
│       ├── cagCache.ts            # KV 來源快取（1 小時）
│       ├── cache.ts               # R2 答案快取（7 天）
│       ├── cagEval.ts             # Eval 評分（含寫死的模型 id）
│       ├── abuse.ts               # D1 異常請求 log + 自動黑名單（issue #27）
│       ├── notFoundReply.ts       # 超範圍回覆（純文字 + HTML，繁中 + 英文）
│       ├── search.ts              # R2 Fuse 索引載入 + 模糊搜尋
│       └── askIndexFormat.ts      # 共用的索引型別與設定
├── public/                        # 靜態資源 + Vue 前端（app.js）
├── db/                            # 異常請求 log + 黑名單的 D1 schema
├── scripts/                       # build-ask-index / vectorize-sync / evals / abuse 維運
├── test/                          # node --test 測試
├── design/                        # 架構筆記 + 系統圖
├── config/                        # R2 lifecycle 規則
└── wrangler.jsonc                 # Workers 設定（R2、KV、Vectorize、AI、DO）
```

## 相關專案

- [sayit-hono](https://github.com/bestian/sayit-hono) — 本 bot 檢索的 archive.tw 後端
- [transcript](https://github.com/audreyt/transcript) — 逐字稿原始來源

## 貢獻與資安

請見 [CONTRIBUTING.md](CONTRIBUTING.md) 與 [SECURITY.md](SECURITY.md)。

## 授權

[MIT](LICENSE) © bestian
