# CAG 系統設計（PR #12）

> 對應 PR #12「[codex] add Workers AI CAG and refresh workflow」與最新 4 筆 commit。
> 本文說明在既有 `/ask` 搜尋之上新增的 **CAG（Cited / Context-Augmented Generation）** 端點，
> 以及支撐它的 R2 索引建置與自動刷新機制。

---

## 1. 這次變更解決什麼問題

既有的 `/ask/:question` 只能回傳「最相近的單一逐字稿段落」（fuzzy match），
無法把多段落整合成一段帶引註的答覆。PR #12 在不動到原本搜尋的前提下，加入：

1. **`/cag/:question`** — 從 archive.tw 檢索多段逐字稿，交給 Cloudflare Workers AI（Kimi K2.6）
   生成「**只根據引文作答 + 自動補上 `[^n]` 註腳**」的串流 Markdown 回覆。
2. **R2 索引的自動刷新流程** — 讓 `/ask` 用的 Fuse 索引能在上游 SayIt 更新時自動重建，
   並透過 manifest sidecar 讓執行中的 Worker 偵測到變更、熱重載。
3. **生產環境硬化** — 查詢變體、輸入夾限、錯誤降級、CI 與測試。

---

## 2. 四筆 Commit 的演進

| # | Commit | 做了什麼 | 主要檔案 |
|---|--------|----------|----------|
| 1 | `fa8370f` add Workers AI CAG endpoint | 新增 `src/utils/cag.ts` 與 `/cag/:question`、`POST /cag`，接上 `AI` binding；archive.tw 檢索 + Workers AI 串流 | `cag.ts`, `index.ts`, `wrangler.jsonc` |
| 2 | `4891e2d` automate CAG index refresh | 新增 `refresh-cag-index.yml`：`workflow_dispatch` / `repository_dispatch(sayit-updated)` / 每日 cron 觸發 `build:index` | `refresh-cag-index.yml`, `package.json` |
| 3 | `9b4f600` add R2 manifest refresh for CAG index | 為索引加上 **manifest sidecar**（sha256/generatedAt/rowCount），`search.ts` 以 fingerprint 做快取失效與熱重載 | `askIndexFormat.ts`, `search.ts`, `build-ask-index.ts` |
| 4 | `9fef755` make CAG retrieval production safe | 查詢變體、整數夾限、抓取失敗降級、`robots.txt` 擋 `/cag/`、CI workflow、`test/cag.test.ts` | `cag.ts`, `ci.yml`, `index.ts`, `test/` |

> 演進邏輯：**先能跑（1）→ 索引能自動更新（2）→ 執行期能偵測更新（3）→ 上線安全（4）**。

---

## 3. 執行期架構（請求 → 回覆）

### 3.1 路由層 `src/index.ts`（Hono）

| 路由 | 用途 | 後端 |
|------|------|------|
| `GET /ask/:question` | 既有：單段落 fuzzy 命中（支援「隨機 / random」） | R2 Fuse 索引 |
| `POST /webhook` | LINE bot：簽章驗證 → 同 `/ask` 搜尋 → Flex 訊息 | R2 Fuse 索引 |
| `GET /cag/:question` | **新增**：串流 CAG 答覆（`top_k`、`max_tokens`、`model` query） | archive.tw + Workers AI |
| `POST /cag` | **新增**：JSON body 版本的 CAG | archive.tw + Workers AI |
| `GET /cag/status` | **新增**：回報 retriever / model / 上限設定 | — |
| `GET /robots.txt` | 擋爬 `/ask/`、`/cag/`、`/webhook` | — |

### 3.2 CAG 管線 `src/utils/cag.ts` — `streamCagAnswer()`

```
question
  │
  ▼  retrieveCagSources()
  ├─ buildCagQueryVariants()    把問題拆成多個檢索變體
  │     • 去除 #directives、問句詞（如何/什麼…）
  │     • 中文 2-gram 切詞 + 拉丁 token，最多 6 個變體
  │
  ├─ searchArchive() ×N         對 archive.tw /api/search.json 平行查詢，依 url 去重
  │
  ├─ hydrateArchiveSection()    解析 #s<id> → /api/section/:id
  │     • 取 previous_content + section_content + next_content
  │     • htmlToPlainText 清洗，組出 label（標題 — 講者）
  │
  ▼  CagSource[]（截到 topK；空集合 → 404「您的問題超出了資料庫的範圍，逐字稿網站連結如下：https://archive.tw'」）
  │
  ▼  buildCagMessages()         system：只用引文作答、用 [n] 標註、中文用繁中
  │                             user：<lore> 多段引文 </lore> + Question
  │
  ▼  ai.run('@cf/moonshotai/kimi-k2.6', { messages, stream:true,
  │          max_completion_tokens(夾限 1..4096), temperature:0.2,
  │          chat_template_kwargs:{ thinking:false } })   ← 關閉思考，加快可見串流
  │
  ▼  ReadableStream 經三段 TransformStream pipe：
  │   1. workersAiEventStreamToText()  解析 SSE（data: …），抽出文字增量
  │   2. markdownCitationFootnotes()   把 [1] 即時改寫成 [^1]，結尾補 [^n]: <連結>
  │   3. TextEncoderStream             轉回 bytes
  │
  ▼  Response  Content-Type: text/markdown; charset=UTF-8
              Cache-Control: no-store, X-Accel-Buffering: no（不緩衝、邊生成邊送）
```

**關鍵設計點**

- **CAG 不碰 R2 Fuse 索引**：它直接打 archive.tw 公開 API 即時檢索，因此涵蓋面比 `/ask` 用的
  「最近 2 年、≤100 字段落」索引更廣（PR 內稱 long-lore profile）。
- **引註是串流安全的**：`markdownCitationFootnotes` 是字元狀態機，邊收串流邊把 `[n]` 轉 `[^n]`，
  只在 flush 時輸出實際被引用到的註腳定義，避免列出沒用到的來源。
- **輸入全部夾限**：`clampInteger` 把 `topK`（1..12）、`maxCompletionTokens`（1..4096）限制在安全範圍。

---

## 4. R2 索引：建置與自動刷新

`/ask` 與 LINE webhook 使用預先建好的 Fuse.js 索引（執行期 **不碰 D1**）。

### 4.1 建置 `scripts/build-ask-index.ts`（`npm run build:index`）

```
wrangler d1 execute sayit-database --remote
  → SELECT … FROM sections WHERE name LIKE '唐鳳%'
      AND 最近 YEARS_BACK 年、section_content 非空
  → 過濾純文字長度 ≤ MAX_SECTION_CHARS
  → Fuse.createIndex(['section_content'], rows)
  → 產出兩個檔：
      • audrey-tang.json           （payload：rows + Fuse index）
      • audrey-tang.manifest.json  （sidecar：sha256 / generatedAt / rowCount …）
  → wrangler r2 object put …（index + manifest，皆上傳 R2）
```

### 4.2 執行期熱重載 `src/utils/search.ts` — `getIndex()`

- **模組層快取**：同一個 Worker isolate 跨請求共用解析後的 Fuse 物件。
- **小 manifest 輪詢**：每 `INDEX_MANIFEST_CHECK_MS`（60 秒）才去讀很小的 manifest，
  用 `fingerprint = sha256:generatedAt:rowCount` 比對；**只有指紋變了才重新下載大 index**。
- **失敗降級**：manifest 或 index 重載失敗時，沿用既有 cache，不讓搜尋整個掛掉。

### 4.3 自動刷新 `.github/workflows/refresh-cag-index.yml`

三種觸發：

1. `repository_dispatch: sayit-updated` — 上游 SayIt / sayit-hono 內容更新時主動派工。
2. `schedule`（每日 `30 13 * * *` UTC）— 萬一上游 dispatch 漏掉的 backstop。
3. `workflow_dispatch`（手動，可選 `deploy`）— 重建後可選擇性重新 deploy 以重置 runtime cache。

流程：`npm ci → typecheck → build:index（重建並上傳 R2）→ wrangler deploy --dry-run` 驗證。

---

## 5. 部署綁定（`wrangler.jsonc`）

| Binding | 型別 | 用途 |
|---------|------|------|
| `ASK_INDEX` | R2 bucket（`askit-fuse-index-cache`） | `/ask`、webhook 讀取 Fuse 索引 |
| `AI` | Workers AI | `/cag` 呼叫 Kimi K2.6（`@cf/moonshotai/kimi-k2.6`） |
| `ASK_MODEL` / `ASK_ARCHIVE_BASE_URL` | vars | 預設模型與 archive.tw base URL |
| `LINE_CHANNEL_*` | secret | LINE webhook 簽章與回覆 |

---

## 6. 兩條資料流的對照

| | `/ask`（既有） | `/cag`（PR #12 新增） |
|---|---|---|
| 檢索來源 | R2 預建 Fuse 索引（最近 2 年、短段落） | archive.tw 即時 API（全量、含上下文） |
| 命中數 | 單一最佳段落 | top_k 多段（預設 6，上限 12） |
| 生成 | 無，直接回傳原文 | Workers AI 整合多段 + 引註 |
| 回應格式 | HTML / LINE Flex | 串流 Markdown（含 `[^n]` 註腳） |
| 即時性 | 依索引刷新（manifest 60s 偵測） | 完全即時 |

詳見同目錄的 `CAG-system-design.svg` 架構圖。

本地記憶體原型（平行 payload，不進 production `/cag`）：見 [cag-memories.md](cag-memories.md)。
