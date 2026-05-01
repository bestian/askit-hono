# Hono LINE Bot Template (Cloudflare Workers)

[華語](#華語) ｜ [English](#english)

---

## 華語

使用 [Hono](https://hono.dev/) 在 Cloudflare Workers 上實作 LINE Messaging API webhook 的最小範本。收到使用者文字訊息後，會透過 LINE Reply API 回覆 `Hello World!`。

### 功能

- 單一範例路由 `POST /webhook`
- 以 HMAC-SHA256 驗證 `x-line-signature`，拒絕偽造請求
- 解析 LINE webhook 事件，僅處理 `message` + `text`
- 50 秒 replyToken 過期保護檢查
- 透過 Cloudflare Secret 安全注入 `LINE_CHANNEL_ACCESS_TOKEN` 與 `LINE_CHANNEL_SECRET`

### 專案結構

```
.
├── src/index.ts        # Hono app 入口（含 /webhook 路由與簽章驗證）
├── wrangler.jsonc      # Cloudflare Workers 設定（JSONC 格式）
├── tsconfig.json
├── package.json
└── .dev.vars.example   # 本機開發環境變數範例
```

### 開始使用

```bash
# 1. 安裝依賴
npm install
```

#### 本機開發

前置作業：建立 `.dev.vars` 並填入 LINE 的 Channel access token 與 Channel secret（[詳細說明](#兩個必要的-secret)）。

```bash
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入實際值

npm run dev
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

部署完成後，將顯示的 Worker URL 加上 `/webhook` 路徑（例如 `https://hono-line-bot-template.YOUR-SUBDOMAIN.workers.dev/webhook`）填入 LINE Developers Console 的「Webhook URL」欄位，並啟用 webhook。可在該頁面按 **Verify** 測試簽章驗證是否通過。

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

從 LINE App 直接傳訊息給 bot 是最可靠的方式。若要用 `curl` 測試，需自行計算正確簽章；以 raw body `{}` 為例：

```bash
SECRET="your-channel-secret"
BODY='{"events":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -X POST https://YOUR-WORKER-URL/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
```

> 注意：上述 `events` 為空陣列時 Worker 會回 `200 OK`。若塞入假的 `replyToken` 真的呼叫 Reply API，LINE 會回 400，Worker 端則回 `502 LINE API error`。

### 進階擴充：Workers AI / D1 / R2

`wrangler.jsonc` 底部已預先放了三組註解掉的 binding，未來想長大時直接取消註解即可。常見搭配場景：

| 服務 | 在 LINE bot 的典型用途 | 文件 |
| --- | --- | --- |
| **Workers AI** | 用 LLM 生成回覆、做意圖分類、翻譯、影像辨識 | <https://developers.cloudflare.com/workers-ai/> |
| **D1**（SQLite） | 儲存對話歷史、使用者偏好、群組設定、配額計數 | <https://developers.cloudflare.com/d1/> |
| **R2**（物件儲存） | 收使用者上傳的圖片 / 音訊，或快取 LINE content API 抓回的多媒體 | <https://developers.cloudflare.com/r2/> |

啟用後在 Hono 中可直接使用：

```ts
type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string
  AI: Ai                     // Workers AI
  DB: D1Database             // D1
  BUCKET: R2Bucket           // R2
}
```

### 授權

本專案以 [MIT License](LICENSE) 釋出，可自由用於個人或商業用途。

---

## English

A minimal template implementing a LINE Messaging API webhook on Cloudflare Workers using [Hono](https://hono.dev/). When a user sends a text message, it replies with `Hello World!` via the LINE Reply API.

### Features

- Single example route `POST /webhook`
- HMAC-SHA256 verification of `x-line-signature` to reject forged requests
- Parses LINE webhook events; handles only `message` + `text`
- 50-second replyToken expiry guard
- `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` injected securely via Cloudflare Secrets

### Project structure

```
.
├── src/index.ts        # Hono app entry (route + signature verification)
├── wrangler.jsonc      # Cloudflare Workers config (JSONC)
├── tsconfig.json
├── package.json
└── .dev.vars.example   # Example local dev environment variables
```

### Getting started

```bash
# 1. Install dependencies
npm install
```

#### Run locally

Prerequisite: create `.dev.vars` with your LINE channel access token and channel secret (see [Two required secrets](#two-required-secrets)).

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars and paste real values

npm run dev
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

After deploy, take the printed Worker URL, append `/webhook` (e.g. `https://hono-line-bot-template.YOUR-SUBDOMAIN.workers.dev/webhook`), and paste it into the **Webhook URL** field of your LINE Developers Console channel. Enable the webhook. Click **Verify** on that page to confirm signature verification works end-to-end.

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

Sending a real message from the LINE app is the most reliable test. To test with `curl`, you need to compute a valid signature. Example with an empty events body:

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

### Growing this template: Workers AI / D1 / R2

The bottom of `wrangler.jsonc` ships with three commented-out bindings — uncomment the one you need. Typical pairings for a LINE bot:

| Service | Typical use in a LINE bot | Docs |
| --- | --- | --- |
| **Workers AI** | LLM-generated replies, intent classification, translation, image recognition | <https://developers.cloudflare.com/workers-ai/> |
| **D1** (SQLite) | Conversation history, user preferences, group settings, quota counters | <https://developers.cloudflare.com/d1/> |
| **R2** (object storage) | User-uploaded images/audio, or caching media fetched from the LINE content API | <https://developers.cloudflare.com/r2/> |

Once enabled, use them from Hono directly:

```ts
type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string
  LINE_CHANNEL_SECRET: string
  AI: Ai                     // Workers AI
  DB: D1Database             // D1
  BUCKET: R2Bucket           // R2
}
```

### License

Released under the [MIT License](LICENSE) — free to use for personal or commercial projects.
