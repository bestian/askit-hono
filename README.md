# askit-hono — LINE Bot for SayIt fuzzy search (Cloudflare Workers + Hono)

[華語](#華語) ｜ [English](#english)

---

## 華語

讓使用者向 LINE Bot 提問（例如「AI 會不會控制我們」），Bot 從 [SayIt](https://archive.tw)（亦即 sayit-hono 專案）的逐字稿中找出指定講者（預設「唐鳳」）說過、最相近的一段話回覆，並附上原文連結。

實作上以 [Hono](https://hono.dev/) 跑在 Cloudflare Workers，不在 runtime 查 D1，而是靠 build-time script 從 D1 預先撈段落、用 [Fuse.js](https://www.fusejs.io/) 建好索引、上傳到 R2；Worker 啟動時從 R2 讀回索引做 fuzzy 搜尋。

### 功能與路由

| 路由 | 用途 |
| --- | --- |
| `GET /` | Healthcheck，回 `Hello World!` |
| `GET /ask/:question` | **暫時測試用**：把 question URL-decode 後跑搜尋，回傳 HTML 顯示最相近段落 + 原文連結。方便用瀏覽器或 curl 驗證索引與搜尋結果。 |
| `POST /webhook` | LINE Messaging API webhook。**目前還只回 `Hello World!`**，尚未串上搜尋邏輯。 |

### 接下來要做的事

把 `/ask/:question` 的搜尋與 HTML 組裝邏輯搬進 `/webhook` 的事件處理器中：當使用者在 LINE 傳訊息，就用同一條 pipeline 找段落，再以 LINE Reply API 把結果（純文字或 Flex Message）回給使用者，正式讓 LINE Bot 可用。預期改動只在 `src/index.ts` 內 `/webhook` 對 `event.message.text` 的處理區塊；`src/utils/search.ts` 與索引格式不需變動。

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

Worker 端 `src/utils/search.ts` 第一次請求時從 R2 抓索引、用 `Fuse.parseIndex` 還原，之後同個 isolate 都共用。索引更新只要重跑 `npm run build:index`，不需要 redeploy worker（但已存在的 isolate 還會用 cache，最多等到自然回收）。

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
| `R2_BUCKET` | `askit-fuse-index-cache-preview` | 上傳到的 R2 bucket |
| `R2_KEY` | `ask-index/audrey-tang.json` | R2 物件 key |
| `LOCAL=1` | — | 對 D1 下 `--local`（預設 `--remote` 用線上資料庫） |
| `SKIP_UPLOAD=1` | — | 只在 `build/` 產出 JSON 不上傳 |

#### 本機開發

前置作業：建立 `.dev.vars` 並填入 LINE 的 Channel access token 與 Channel secret（[詳細說明](#兩個必要的-secret)）。

```bash
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入實際值

npm run dev        # 本地 R2 模擬（你需要事先把索引匯入本地）
npm run preview    # wrangler dev --remote，連到雲端 R2 實際索引（推薦）
```

> 注意：`npm run dev` 走 miniflare 本地 R2 模擬，剛上傳的雲端索引在這裡讀不到，會回 `404 找不到 R2 物件`。要真的測搜尋請用 `npm run preview`。

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

### 已知議題 / TODO

- **`/webhook` 還沒接搜尋邏輯**：目前固定回 `Hello World!`，待搬入 `findClosestMatchingSection` + `formatAskAnswerHtml` / 純文字版本。
- **索引大小**：當前 `唐鳳%` 範圍下索引約 75 MB（105k 段落）。Workers isolate 記憶體上限 128MB，第一次 `JSON.parse` + `Fuse.parseIndex` 會吃不少；後續可能需要瘦身（拿掉 runtime 用不到的欄位、縮短 key 名、或分片）。
- **isolate cache 不會自動失效**：`npm run build:index` 上傳後，已存在的 Worker isolate 還是用舊 cache，要等到自然回收。需要強制刷新可以加一條 admin 路由清掉 module-level cache，或部署時順便刷新。

### 授權

本專案以 [MIT License](LICENSE) 釋出，可自由用於個人或商業用途。

---

## English

A LINE bot that, when a user asks a question (e.g. "Will AI control us?"), finds the closest matching paragraph from a chosen speaker's transcripts on [SayIt](https://archive.tw) (the sayit-hono project) — defaulting to **Audrey Tang** — and replies with the excerpt plus a link to the source.

Built with [Hono](https://hono.dev/) on Cloudflare Workers. The Worker does **not** query D1 at runtime; instead, a build-time script pulls sections from D1, builds a [Fuse.js](https://www.fusejs.io/) index, and uploads it to R2. The Worker loads the prebuilt index from R2 on first request and runs fuzzy search against it.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Healthcheck — returns `Hello World!` |
| `GET /ask/:question` | **Temporary debug endpoint** — URL-decodes the question, runs the search, returns HTML with the closest section and a link to the source. Handy for testing from a browser or `curl`. |
| `POST /webhook` | LINE Messaging API webhook. **Currently just replies `Hello World!`** — the search pipeline is not wired in yet. |

### Next step

Move the search + HTML formatting logic from `/ask/:question` into the `/webhook` handler so that LINE messages trigger the same pipeline and the bot replies via the LINE Reply API (plain text or Flex Message). The change is local to the `event.message.text` block in `src/index.ts`; `src/utils/search.ts` and the index format stay as-is.

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

On first request, the Worker reads the index from R2 and rehydrates it via `Fuse.parseIndex`. The parsed index is cached at module scope so subsequent requests in the same isolate skip the load. To refresh, just rerun `npm run build:index` — no redeploy needed (existing isolates keep the old cache until they recycle).

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
| `R2_BUCKET` | `askit-fuse-index-cache-preview` | Target R2 bucket |
| `R2_KEY` | `ask-index/audrey-tang.json` | R2 object key |
| `LOCAL=1` | — | Use `--local` against D1 (defaults to `--remote`) |
| `SKIP_UPLOAD=1` | — | Write the JSON to `build/` only, skip the R2 upload |

#### Run locally

Prerequisite: create `.dev.vars` with your LINE channel access token and channel secret (see [Two required secrets](#two-required-secrets)).

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars and paste real values

npm run dev        # local R2 mock (you would need to seed it locally)
npm run preview    # wrangler dev --remote — talks to the real R2 (recommended)
```

> Note: `npm run dev` uses miniflare's local R2 emulator; the index you uploaded to the cloud bucket is not visible there and you'll see `404 R2 object not found`. Use `npm run preview` to actually exercise the search.

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

### Known issues / TODO

- **`/webhook` is not yet wired to the search pipeline.** It currently always replies `Hello World!`. The plan is to call `findClosestMatchingSection` + `formatAskAnswerHtml` (or a plain-text variant) from inside the message handler.
- **Index size.** The default `唐鳳%` range produces ~75 MB (~105k sections). Workers isolates have a 128 MB memory limit, so the first `JSON.parse` + `Fuse.parseIndex` is a meaningful cost. We may need to slim the payload (drop unused fields, shorter keys, or shard) once it actually starts hitting the ceiling.
- **Module-level cache doesn't auto-invalidate.** After `npm run build:index` re-uploads, existing isolates keep serving from the in-memory cache until they recycle. If you need an immediate flush, expose an admin route that clears the module cache, or refresh on deploy.

### License

Released under the [MIT License](LICENSE) — free to use for personal or commercial projects.
