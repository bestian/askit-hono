# askit-hono — LINE Bot for SayIt fuzzy search (Cloudflare Workers + Hono)

[華語](#華語) ｜ [English](#english)

---

## 華語

讓使用者向 LINE Bot 提問（例如「AI 會不會控制我們」），Bot 從 [SayIt](https://archive.tw)（亦即 sayit-hono 專案）的逐字稿中找出指定講者（預設「唐鳳」）說過、最相近的一段話回覆，並附上原文連結。

實作上以 [Hono](https://hono.dev/) 跑在 Cloudflare Workers。LINE `/webhook` 與 `/ask/:question` 走 build-time R2 Fuse 索引；`/cag` 則直接使用 `archive.tw` 的搜尋 API 與 section API 做 long-lore retrieval，避免 Worker 冷啟動時載入巨大索引。

### 功能與路由

| 路由 | 用途 |
| --- | --- |
| `GET /` | Healthcheck，回 `Hello World!` |
| `GET /ask/:question` | **暫時測試用**：把 question URL-decode 後跑搜尋，回傳 HTML 顯示最相近段落 + 原文連結。方便用瀏覽器或 curl 驗證索引與搜尋結果。 |
| `GET /cag/status` | 顯示 CAG retriever、archive base URL、模型與 top-k 上限。 |
| `GET /cag/:question` | 從 `archive.tw/api/search.json` 找相關段落，再用 `/api/section/:id` 取回前後文，組成 CAG prompt，呼叫 Cloudflare Workers AI（預設 Kimi K2.6），並串流 Markdown 回答與 `archive.tw#s...` footnote。 |
| `POST /cag` | JSON 版本的 CAG endpoint：`{ "question": "...", "topK": 6 }`，同樣串流 Markdown。 |
| `POST /webhook` | LINE Messaging API webhook。收到 LINE 文字訊息後，使用與 `/ask/:question` 相同的搜尋 pipeline，並以 Flex Message 回覆最相近段落、出處、日期與原文連結。 |

### 回覆格式

`/ask/:question` 會回 HTML，方便瀏覽器測試；`/webhook` 命中搜尋結果時會回 LINE Flex Message。Flex 的主文來自段落內容，出處來自 `display_name`，日期從 `filename` 的 `YYYY-MM-DD` 前綴解析，hero 圖使用 `https://archive.tw/og/{filename}.png`，按鈕連到原文 section URL。查無結果或搜尋錯誤時仍回純文字。

### 索引建置流程（不在 Worker 內執行）

```
D1 sections view  ──┐
                    │  npm run build:index
speakers.name LIKE ─┤  (scripts/build-ask-index.ts)
'唐鳳%'             │
                    ▼
              Fuse.createIndex
                    │
                    ▼
            JSON: { rows, index, meta }
                    │
                    ▼
   R2: askit-fuse-index-cache/ask-index/audrey-tang.json
```

Worker 端 `src/utils/search.ts` 第一次請求時從 R2 抓索引、用 `Fuse.parseIndex` 還原，之後同個 isolate 都共用。build script 也會上傳一個很小的 manifest sidecar（預設 `ask-index/audrey-tang.manifest.json`）；Worker 會定期讀 manifest，發現 `indexSha256` 變更時自動重載大索引，不需要每次 transcript 更新都 redeploy。

### 專案結構

```
.
├── src/
│   ├── index.ts                   # Hono app（/, /ask/:question, /webhook）
│   └── utils/
│       ├── search.ts              # R2 載入索引 + Fuse 搜尋 + HTML 輸出
│       └── askIndexFormat.ts      # build / runtime 共用的型別與 Fuse 設定
├── scripts/
│   ├── build-ask-index.ts         # 從 D1 撈段落 → 建 Fuse 索引 → 上傳 R2
│   └── tsconfig.json
├── wrangler.jsonc                 # Workers 設定（R2 binding ASK_INDEX）
├── tsconfig.json
├── package.json
└── .dev.vars.example              # 本機開發環境變數範例
```

### 開始使用

需要 Node.js 22 或更新版本（Wrangler 4.87+ 需要 Node 22）。本 repo 提供 `.nvmrc` 與 `.node-version`，可讓常見版本管理器自動切換。

```bash
# 1. 安裝依賴
npm install
```

#### 一次性：建立 R2 bucket

build script 把索引上傳到 `askit-fuse-index-cache`（preview 對應 `askit-fuse-index-cache-preview`）。第一次使用先建好：

```bash
npx wrangler r2 bucket create askit-fuse-index-cache
npx wrangler r2 bucket create askit-fuse-index-cache-preview
```

#### 建索引並上傳到 R2

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
| `MAX_SECTION_CHARS` | `100` | 只保留純文字長度不超過此值的段落 |
| `YEARS_BACK` | `2` | 只保留最近幾年的逐字稿 |
| `LOCAL=1` | — | 對 D1 下 `--local`（預設 `--remote` 用線上資料庫） |
| `SKIP_UPLOAD=1` | — | 只在 `build/` 產出 JSON 不上傳 |

上傳順序是「大索引 JSON 先、manifest 後」。Worker 只把 manifest 當作版本訊號，所以不會在 R2 還沒拿到新索引時切換。

#### CAG + Workers AI

`/cag/:question` 是把 DS4 CAG 實驗搬進 Cloudflare runtime 的部分：
retrieve 使用 `ASK_ARCHIVE_BASE_URL`（預設 `https://archive.tw`）的 `/api/search.json`
做第一階段搜尋，再用 `/api/section/:id` 取回命中段落與前後文；生成由 Workers AI
binding `AI` 執行，預設模型由 `ASK_MODEL` 控制。這避免把 30 年 long-lore 索引塞進 Worker isolate。

```bash
curl -N 'https://YOUR-WORKER-URL/cag/%E7%94%A8%20%23zh-tw%20%E5%9B%9E%E7%AD%94%EF%BC%9A%E5%9C%B0%E7%A5%9E%E9%A6%99%E7%81%AB%E5%A6%82%E4%BD%95?top_k=6'
```

輸出是 streaming Markdown。模型若輸出 `[1]` 這類來源標記，Worker 會轉成
`[^1]` 並在結尾補上 footnote，連到對應的 `archive.tw/<speech>#s<section_id>`。

#### 隨 transcript / sayit-hono 更新

本 repo 的 `.github/workflows/refresh-cag-index.yml` 會刷新 `/ask` / LINE webhook 用的 R2 Fuse 索引；`/cag` 直接讀 `archive.tw` API，所以在 `sayit-hono` 部署成功後自然讀到新內容。workflow 提供三種入口：

- `repository_dispatch` 的 `sayit-updated` event：給 `transcript` repo 在成功上傳 Markdown 並部署 `sayit-hono` 後觸發。
- `workflow_dispatch`：手動重建索引；可勾選 `deploy` 讓 Worker 也一起部署，作為立即 cache reset。
- 每日 schedule：漏掉 dispatch 時的保底。

建議在 `transcript` repo 的 `Sync markdown on push` workflow、`rebuild-search-index` job 成功部署 `sayit-hono` 後加上，讓 `/ask` 與 LINE 索引也跟著更新：

```yaml
- name: Refresh AskIt index
  env:
    GH_TOKEN: ${{ secrets.ASKIT_REBUILD_TOKEN }}
  run: |
    gh api repos/bestian/askit-hono/dispatches \
      -f event_type=sayit-updated \
      -F client_payload[transcript_sha]="${GITHUB_SHA}"
```

`ASKIT_REBUILD_TOKEN` 需要能對 `bestian/askit-hono` 發送 repository dispatch；細粒度 PAT 可給該 repo `Contents: read/write` 權限。dispatch 進來後，askit-hono workflow 會 `npm run build:index` 上傳新的 R2 索引與 manifest，然後 dry-run 驗證 Worker bundle。線上 Worker 最多在約一分鐘內看到 manifest 變更並重載 `/ask` index；部署只保留為手動 cache reset。

#### 本機開發

前置作業：建立 `.dev.vars` 並填入 LINE 的 Channel access token 與 Channel secret（[詳細說明](#兩個必要的-secret)）。

```bash
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入實際值

npm run dev        # 本機 Worker + 遠端 R2 / Workers AI binding
npm run preview    # wrangler dev --remote，整個 Worker 也跑在 Cloudflare
```

> 注意：`ASK_INDEX` R2 binding 與 `AI` binding 在 `wrangler.jsonc` 裡設為 `remote: true`。本機測 `/ask` 會讀雲端 preview R2 bucket；本機測 `/cag` 會呼叫 `archive.tw` API 與 Workers AI。這會用到 Cloudflare 帳號配額。若 preview bucket 還沒有 `/ask` 索引，可先執行：

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

#### 部署到 Cloudflare Workers

前置作業：

1. **登入 Cloudflare**（首次執行 wrangler 時會自動開瀏覽器要求授權）：

   ```bash
   npx wrangler login
   ```

2. **設定兩個 Secret 到 Cloudflare 帳號**（生產環境不會讀 `.dev.vars`）：

   ```bash
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put LINE_CHANNEL_SECRET
   ```

   每個指令會提示貼上值，按 Enter 完成。詳見 [兩個必要的 Secret](#兩個必要的-secret) 一節。

   > 注意：Secret 是綁在「已部署的 Worker」上，所以實際上要先 `npm run deploy` 一次才能設定。第一次部署時 secret 還沒設，webhook 會回 `401`；設好後再部署或重新觸發即可。或者可先用 Dashboard 的 Variables and Secrets 頁面預先建立。

3. 部署：

   ```bash
   npm run deploy
   ```

部署完成後，將顯示的 Worker URL 加上 `/webhook` 路徑（例如 `https://askit-hono.YOUR-SUBDOMAIN.workers.dev/webhook`）填入 LINE Developers Console 的「Webhook URL」欄位，並啟用 webhook。可在該頁面按 **Verify** 測試簽章驗證是否通過。

### 兩個必要的 Secret

| 名稱 | 用途 |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | 呼叫 LINE Reply API 時的 Bearer token |
| `LINE_CHANNEL_SECRET` | 驗證 webhook 請求簽章（HMAC-SHA256 金鑰） |

兩者皆屬於機敏資訊，**不可** 寫入 `wrangler.jsonc` 或提交至版本控制。請使用 Cloudflare Workers 的 Secret 機制：

#### 方法 1：使用 `wrangler secret put`（推薦）

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
```

每次執行都會提示輸入值，按 Enter 即可。Cloudflare 會將其加密儲存，並在 Worker 執行時以 `env.LINE_CHANNEL_ACCESS_TOKEN` / `env.LINE_CHANNEL_SECRET`（在 Hono 中為 `c.env.LINE_CHANNEL_ACCESS_TOKEN` / `c.env.LINE_CHANNEL_SECRET`）注入。

確認已設定：

```bash
npx wrangler secret list
```

更新 secret：再執行一次 `wrangler secret put` 即可覆寫。

刪除：

```bash
npx wrangler secret delete LINE_CHANNEL_ACCESS_TOKEN
```

#### 方法 2：使用 Cloudflare Dashboard

1. 前往 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages
2. 選擇對應的 Worker → Settings → **Variables and Secrets**
3. 點擊 **Add variable**，Type 選 **Secret**
4. 分別新增 `LINE_CHANNEL_ACCESS_TOKEN` 與 `LINE_CHANNEL_SECRET`
5. 儲存

#### 本機開發（`.dev.vars`）

`wrangler dev` 會讀取專案根目錄的 `.dev.vars` 檔案作為本機 secret：

```bash
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入實際 token 與 secret
```

`.dev.vars` 已被 `.gitignore` 排除，不會被提交。

### 取得 LINE Channel Access Token 與 Channel Secret

1. 至 [LINE Developers Console](https://developers.line.biz/) 建立 Provider 與 Messaging API Channel
2. **Channel secret**：於 Channel 的「Basic settings」頁籤可看到（複製即可）
3. **Channel access token**：於「Messaging API」頁籤底部，發行（Issue）一組 **Channel access token (long-lived)**

### 簽章驗證原理

LINE 平台會用你的 Channel secret 對 raw request body 計算 HMAC-SHA256，再以 Base64 編碼放入 `x-line-signature` header。Worker 收到請求時會用同一把金鑰重新計算，並以等長時間比較。簽章不符（含缺少 header）時會回 `401 Invalid signature`。

> 在 LINE Developers Console 的「Webhook settings」可按 **Verify** 測試你的端點是否能通過簽章驗證。

### 測試

從 LINE App 直接傳訊息給 bot 是最可靠的方式（前提：把 `/webhook` 邏輯換成搜尋回覆之後）。`curl` 測 webhook：

```bash
SECRET="your-channel-secret"
BODY='{"events":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -X POST https://YOUR-WORKER-URL/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
```

> 上述 `events` 為空陣列時 Worker 會回 `200 OK`。若塞入假的 `replyToken` 真的呼叫 Reply API，LINE 會回 400，Worker 端則回 `502 LINE API error`。

搜尋本身可獨立測：

```bash
curl 'https://YOUR-WORKER-URL/ask/AI%E6%9C%83%E4%B8%8D%E6%9C%83%E6%8E%A7%E5%88%B6%E6%88%91%E5%80%91'
```

CAG 串流可用：

```bash
curl -N 'https://YOUR-WORKER-URL/cag/%E7%94%A8%20%23zh-tw%20%E5%9B%9E%E7%AD%94%EF%BC%9A%E5%9C%B0%E7%A5%9E%E9%A6%99%E7%81%AB%E5%A6%82%E4%BD%95?top_k=6'
```

### 已知議題 / TODO

- **索引大小**：當前 `唐鳳%` 範圍下索引約 75 MB（105k 段落）。Workers isolate 記憶體上限 128MB，第一次 `JSON.parse` + `Fuse.parseIndex` 會吃不少；後續可能需要瘦身（拿掉 runtime 用不到的欄位、縮短 key 名、或分片）。
- **manifest 輪詢不是瞬間同步**：`npm run build:index` 上傳後，已存在的 Worker isolate 最多等約一分鐘才會看到 manifest 變更並重載 index。需要立刻刷新時，可手動跑 workflow 並勾選 `deploy`。

### 授權

本專案以 [MIT License](LICENSE) 釋出，可自由用於個人或商業用途。

---

## English

A LINE bot that, when a user asks a question (e.g. "Will AI control us?"), finds the closest matching paragraph from a chosen speaker's transcripts on [SayIt](https://archive.tw) (the sayit-hono project) — defaulting to **Audrey Tang** — and replies with the excerpt plus a link to the source.

Built with [Hono](https://hono.dev/) on Cloudflare Workers. LINE `/webhook` and `/ask/:question` use a build-time R2 Fuse index. `/cag` uses `archive.tw` search and section APIs for long-lore retrieval, so the Worker does not cold-load a giant transcript index.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Healthcheck — returns `Hello World!` |
| `GET /ask/:question` | **Temporary debug endpoint** — URL-decodes the question, runs the search, returns HTML with the closest section and a link to the source. Handy for testing from a browser or `curl`. |
| `GET /cag/status` | Shows the CAG retriever, archive base URL, model, and top-k limit. |
| `GET /cag/:question` | Searches `archive.tw/api/search.json`, hydrates hits through `/api/section/:id`, builds a CAG prompt, calls Cloudflare Workers AI (Kimi K2.6 by default), and streams Markdown with `archive.tw#s...` footnotes. |
| `POST /cag` | JSON CAG endpoint: `{ "question": "...", "topK": 6 }`, also streaming Markdown. |
| `POST /webhook` | LINE Messaging API webhook. For text messages, it uses the same search pipeline as `/ask/:question` and replies with the closest section, source, date, and source link as a Flex Message. |

### Reply Format

`/ask/:question` returns HTML for browser testing; `/webhook` returns a LINE Flex Message when search finds a result. The Flex body uses the section content, source uses `display_name`, date is parsed from the `YYYY-MM-DD` prefix in `filename`, the hero image uses `https://archive.tw/og/{filename}.png`, and the button links to the source section URL. Missing results and search errors still return plain text.

### Index pipeline (runs offline, not in the Worker)

```
D1 sections view  ──┐
                    │  npm run build:index
speakers.name LIKE ─┤  (scripts/build-ask-index.ts)
'唐鳳%'             │
                    ▼
              Fuse.createIndex
                    │
                    ▼
            JSON: { rows, index, meta }
                    │
                    ▼
   R2: askit-fuse-index-cache/ask-index/audrey-tang.json
```

On first request, the Worker reads the index from R2 and rehydrates it via `Fuse.parseIndex`. The parsed index is cached at module scope so subsequent requests in the same isolate skip the load. The build script also uploads a tiny manifest sidecar, defaulting to `ask-index/audrey-tang.manifest.json`; the Worker periodically reads that manifest and reloads the large index when `indexSha256` changes, so transcript refreshes do not require a Worker redeploy.

### Project structure

```
.
├── src/
│   ├── index.ts                   # Hono app (/, /ask/:question, /webhook)
│   └── utils/
│       ├── search.ts              # R2 loader + Fuse search + HTML output
│       └── askIndexFormat.ts      # Types and Fuse options shared by build + runtime
├── scripts/
│   ├── build-ask-index.ts         # D1 → Fuse index → R2 uploader
│   └── tsconfig.json
├── wrangler.jsonc                 # Workers config (R2 binding ASK_INDEX)
├── tsconfig.json
├── package.json
└── .dev.vars.example              # Example local dev environment variables
```

### Getting started

Requires Node.js 22 or newer (Wrangler 4.87+ requires Node 22). This repo includes `.nvmrc` and `.node-version` for common version managers.

```bash
# 1. Install dependencies
npm install
```

#### One-time: create the R2 buckets

The build script uploads to `askit-fuse-index-cache` (with `askit-fuse-index-cache-preview` for `wrangler dev`). Create them once:

```bash
npx wrangler r2 bucket create askit-fuse-index-cache
npx wrangler r2 bucket create askit-fuse-index-cache-preview
```

#### Build the index and upload to R2

```bash
npm run build:index
```

Optional environment variables:

| Var | Default | Notes |
| --- | --- | --- |
| `D1_DATABASE` | `sayit-database` | D1 database name (must match sayit-hono) |
| `SPEAKER_LIKE` | `唐鳳%` | `speakers.name LIKE` condition |
| `R2_BUCKET` | `askit-fuse-index-cache` | Target R2 bucket |
| `R2_KEY` | `ask-index/audrey-tang.json` | R2 object key |
| `R2_MANIFEST_KEY` | `ask-index/audrey-tang.manifest.json` | Tiny sidecar manifest key, uploaded only after the index JSON succeeds |
| `MAX_SECTION_CHARS` | `100` | Keep sections whose plain-text length is at most this value |
| `YEARS_BACK` | `2` | Keep transcripts from the last N years |
| `LOCAL=1` | — | Use `--local` against D1 (defaults to `--remote`) |
| `SKIP_UPLOAD=1` | — | Write the JSON to `build/` only, skip the R2 upload |

Upload order is "large index JSON first, manifest second." The Worker treats the manifest as the version signal, so it does not switch before R2 has the new index object.

#### CAG + Workers AI

`/cag/:question` is the Cloudflare-native slice of the DS4 CAG experiment:
retrieval uses `ASK_ARCHIVE_BASE_URL` (`https://archive.tw` by default) for
`/api/search.json`, then hydrates each section through `/api/section/:id` to get
neighbor context. Generation runs through the Workers AI `AI` binding. The
default model is controlled by `ASK_MODEL`. This avoids loading a 30-year
long-lore index into the Worker isolate.

```bash
curl -N 'https://YOUR-WORKER-URL/cag/%E7%94%A8%20%23zh-tw%20%E5%9B%9E%E7%AD%94%EF%BC%9A%E5%9C%B0%E7%A5%9E%E9%A6%99%E7%81%AB%E5%A6%82%E4%BD%95?top_k=6'
```

The response is streaming Markdown. If the model emits source markers like
`[1]`, the Worker rewrites them to `[^1]` and appends footnotes linked to the
matching `archive.tw/<speech>#s<section_id>` source.

#### Keeping Transcript Updates Fresh

This repo includes `.github/workflows/refresh-cag-index.yml` to refresh the R2 Fuse index used by `/ask` and the LINE webhook. `/cag` reads the `archive.tw` APIs directly, so it sees new content once `sayit-hono` deploys. The workflow has three entrypoints:

- `repository_dispatch` event `sayit-updated`: intended for the `transcript` repo after Markdown upload and `sayit-hono` deploy succeed.
- `workflow_dispatch`: manual index refresh; set `deploy=true` to deploy the Worker too as an immediate cache reset.
- Daily schedule: a backstop if a dispatch is missed.

Recommended final step in the `transcript` repo's `Sync markdown on push` workflow, after the `rebuild-search-index` job deploys `sayit-hono`, so `/ask` and LINE stay fresh too:

```yaml
- name: Refresh AskIt index
  env:
    GH_TOKEN: ${{ secrets.ASKIT_REBUILD_TOKEN }}
  run: |
    gh api repos/bestian/askit-hono/dispatches \
      -f event_type=sayit-updated \
      -F client_payload[transcript_sha]="${GITHUB_SHA}"
```

`ASKIT_REBUILD_TOKEN` must be able to send repository dispatches to `bestian/askit-hono`; a fine-grained PAT with `Contents: read/write` for that repo works. Once the dispatch arrives, askit-hono runs `npm run build:index`, uploads the refreshed R2 index and manifest, then dry-run validates the Worker bundle. The live Worker sees the manifest change and reloads the `/ask` index within roughly one minute; deploy is kept only as a manual cache reset.

#### Run locally

Prerequisite: create `.dev.vars` with your LINE channel access token and channel secret (see [Two required secrets](#two-required-secrets)).

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars and paste real values

npm run dev        # local Worker + remote R2 / Workers AI bindings
npm run preview    # wrangler dev --remote — the Worker itself also runs on Cloudflare
```

> Note: `ASK_INDEX` and `AI` are marked `remote: true` in `wrangler.jsonc`. Local `/ask` tests read the cloud preview R2 bucket; local `/cag` tests call `archive.tw` APIs and Workers AI. That uses your Cloudflare account quota. If the preview bucket does not have the `/ask` index yet, seed it first:

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

You can hit `/ask/:question` directly while developing:

```bash
curl 'http://127.0.0.1:8787/ask/AI%E6%9C%83%E4%B8%8D%E6%9C%83%E6%8E%A7%E5%88%B6%E6%88%91%E5%80%91'
```

#### Deploy to Cloudflare Workers

Prerequisites:

1. **Authenticate with Cloudflare** (the first wrangler command opens a browser for OAuth):

   ```bash
   npx wrangler login
   ```

2. **Upload both secrets to your Cloudflare account** (production does *not* read `.dev.vars`):

   ```bash
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put LINE_CHANNEL_SECRET
   ```

   Each prompts for the value — paste and press Enter. See [Two required secrets](#two-required-secrets) for details.

   > Note: secrets are attached to a *deployed* Worker, so in practice you'll `npm run deploy` once first; until the secrets are set, webhook calls will return `401`. After setting them, redeploy or just retrigger. Alternatively you can pre-create them via the Dashboard's Variables and Secrets page.

3. Deploy:

   ```bash
   npm run deploy
   ```

After deploy, take the printed Worker URL, append `/webhook` (e.g. `https://askit-hono.YOUR-SUBDOMAIN.workers.dev/webhook`), and paste it into the **Webhook URL** field of your LINE Developers Console channel. Enable the webhook. Click **Verify** on that page to confirm signature verification works end-to-end.

### Two required secrets

| Name | Purpose |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | Bearer token used when calling the LINE Reply API |
| `LINE_CHANNEL_SECRET` | HMAC-SHA256 key used to verify webhook request signatures |

Both are sensitive — **do not** put them in `wrangler.jsonc` or commit them. Use Cloudflare Workers' Secret mechanism:

#### Option 1: `wrangler secret put` (recommended)

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
```

Each command prompts for the value. Cloudflare stores it encrypted and injects it at runtime as `env.LINE_CHANNEL_ACCESS_TOKEN` / `env.LINE_CHANNEL_SECRET` (in Hono: `c.env.LINE_CHANNEL_ACCESS_TOKEN` / `c.env.LINE_CHANNEL_SECRET`).

Verify:

```bash
npx wrangler secret list
```

To update, re-run `wrangler secret put` — it overwrites.

To delete:

```bash
npx wrangler secret delete LINE_CHANNEL_ACCESS_TOKEN
```

#### Option 2: Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages
2. Select the Worker → Settings → **Variables and Secrets**
3. Click **Add variable**, set Type to **Secret**
4. Add both `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET`
5. Save

#### Local development (`.dev.vars`)

`wrangler dev` reads `.dev.vars` from the project root as local secrets:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars and paste the real token + secret
```

`.dev.vars` is gitignored.

### Getting your LINE Channel access token and Channel secret

1. Open [LINE Developers Console](https://developers.line.biz/) and create a Provider + Messaging API Channel
2. **Channel secret**: shown on the channel's **Basic settings** tab — copy it
3. **Channel access token**: on the **Messaging API** tab, scroll to the bottom and **Issue** a long-lived **Channel access token**

### How signature verification works

LINE computes HMAC-SHA256 over the raw request body using your Channel secret, Base64-encodes it, and sends it in the `x-line-signature` header. The Worker recomputes the MAC with the same key and compares them in constant time. Mismatches (including a missing header) return `401 Invalid signature`.

> In the LINE Developers Console's **Webhook settings**, click **Verify** to test that your endpoint accepts a properly-signed request.

### Testing

Sending a real message from the LINE app is the most reliable test (once `/webhook` is wired up to the search pipeline). To test the webhook with `curl`:

```bash
SECRET="your-channel-secret"
BODY='{"events":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -X POST https://YOUR-WORKER-URL/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
```

> An empty `events` array returns `200 OK`. If you fake a `replyToken` and actually hit the Reply API, LINE will return 400 and the Worker responds with `502 LINE API error`.

You can also exercise the search directly:

```bash
curl 'https://YOUR-WORKER-URL/ask/AI%E6%9C%83%E4%B8%8D%E6%9C%83%E6%8E%A7%E5%88%B6%E6%88%91%E5%80%91'
```

Streaming CAG test:

```bash
curl -N 'https://YOUR-WORKER-URL/cag/%E7%94%A8%20%23zh-tw%20%E5%9B%9E%E7%AD%94%EF%BC%9A%E5%9C%B0%E7%A5%9E%E9%A6%99%E7%81%AB%E5%A6%82%E4%BD%95?top_k=6'
```

### Known issues / TODO

- **Index size.** The default `唐鳳%` range produces ~75 MB (~105k sections). Workers isolates have a 128 MB memory limit, so the first `JSON.parse` + `Fuse.parseIndex` is a meaningful cost. We may need to slim the payload (drop unused fields, shorter keys, or shard) once it actually starts hitting the ceiling.
- **Manifest polling is not instant.** After `npm run build:index` re-uploads, existing isolates can take roughly one minute to see the manifest change and reload the index. For immediate reset, run the manual workflow with `deploy=true`.

### License

Released under the [MIT License](LICENSE) — free to use for personal or commercial projects.
