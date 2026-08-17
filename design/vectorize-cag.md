# Vectorize 語意檢索 CAG（issue #15）

> 在既有 `/ask`（Fuse 關鍵字）與 `/cag`（archive.tw 即時搜尋）之上，新增
> **Cloudflare Vectorize 語意檢索**，解決「問句較長或關鍵字不明確時命中不相關段落」的問題。
> 分支：`vectorized-cag`。

---

## 1. 為什麼

`/ask` 與目前 webhook 走的 CAG 都依賴關鍵字命中（Fuse fuzzy / archive.tw 搜尋）。
當問句語意清楚但用字與逐字稿不同時，關鍵字會落空。語意向量檢索把「問句」與「段落」
都嵌入到同一向量空間，用 cosine 相似度找最貼近語意的段落，對長問句、改寫問句更穩。

---

## 2. 技術選型（已驗證的硬約束）

| 項目 | 值 | 備註 |
|---|---|---|
| 嵌入模型 | `@cf/google/embeddinggemma-300m` | Workers AI 上即有；多語含中文 |
| 向量維度 | **768**（原生） | 建立索引後**不可更改** |
| 相似度 | **cosine** | 模型輸出 L2-normalized；建立後**不可更改** |
| 索引名 | `askit-audrey-tang` | ≤64 bytes |
| 向量 ID | `String(section_id)` | ≤64 bytes；與 D1 記帳對齊 |
| 任務前綴 | 文件 `title: none \| text:`；查詢 `task: search result \| query:` | **必加**，否則召回率下降 |
| 嵌入批次 | ≤100 段/次（REST）| 走 Workers AI REST（無 wrangler CLI 可跑模型）|
| upsert | 冪等（last-write-wins）| 重跑 / 內容變更重嵌都安全 |
| metadata | ≤10 KiB/向量 | 段落 ≤100 字，含內容綽綽有餘 |

**檢索範圍**：與 Fuse index 完全一致 —— 講者 `唐鳳%`、純文字 ≤100 字、最近 2 年。
刻意做成乾淨對照組，只替換「關鍵字 → 語意」這一個變因。日後要擴大只要改環境變數
（`MAX_SECTION_CHARS` / `YEARS_BACK`）重跑即可。

---

## 3. 架構與資料流

```
            ┌──────────────────────── 近端腳本（本地 / CI，不在 runtime）────────────────────────┐
            │                                                                                      │
  D1 sayit-database ──(同 build:index 的 SQL+過濾)──► 符合條件段落                                  │
            │                                              │                                       │
            │                          ┌───────────────────┴───────────────────┐                  │
            │                          ▼                                        ▼                  │
            │   D1 askit_vectorize_progress              Workers AI REST 嵌入（文件前綴）          │
            │   (section_id, is_vectorized,              @cf/google/embeddinggemma-300m            │
            │    content_sha, updated_at)                         │                                │
            │        ▲  每批標記 is_vectorized=1 ◄────────────────┤                                │
            │        │                                            ▼                                │
            │        └──────────────────────────  wrangler vectorize upsert（NDJSON）             │
            │                                                     │                                │
            └─────────────────────────────────────────────────────┼────────────────────────────────┘
                                                                  ▼
                                                      Cloudflare Vectorize 索引
                                                      askit-audrey-tang（768/cosine）
                                                      每向量 metadata 內含段落原文/出處
                                                                  ▲
            ┌──────────────────────────── runtime Worker（只碰 AI + Vectorize）──────────────────┐
            │  問句 ─(查詢前綴)─► AI 嵌入 ─► VECTORIZE.query(topK, returnMetadata:'all')          │
            │        ─► metadata 還原成 CagSource[] ─► 既有 CAG 生成（Kimi K2.6）+ 引註           │
            │        （查無結果 / 無 binding → 自動回退 archive.tw 檢索）                          │
            └──────────────────────────────────────────────────────────────────────────────────┘
```

**runtime 不碰 D1**（與既有設計一致）：段落內容在回填時就寫進 Vectorize metadata，
查完即可組出 `CagSource`，連 archive.tw 都不必打。

---

## 4. issue #15 五步 → 實作對照

| issue 步驟 | 對應實作 |
|---|---|
| 1. 建立 Vectorize 向量庫 | `npm run vectorize:create`（768 / cosine） |
| 2. 建 D1 記帳表（section_id, is_vectorized…）| `scripts/vectorize-sync.ts` 的 `ensureProgressTable` + `syncMembership` |
| 3. 建置向量索引、逐筆標記、可中斷續跑 | 同腳本 `processPending`：批次嵌入→upsert→標記 |
| 4. 增量補新 session_id | **同一支腳本**（冪等）：再跑一次即偵測新增 / 內容變更並補上 |
| 5. CAG 改用 Vectorize 提取 | `src/utils/vectorize.ts` + `cag.ts` retriever 切換，預設 vectorize、保留 archive 回退 |

第 3、4 步合併成一支冪等腳本：**首跑＝全量建置；再跑＝增量補新**。

---

## 5. 操作手冊（Runbook）

### 5.0 前置：帳號與 token

在 **audreyt@audreyt.org** 的 Cloudflare 帳號下操作。準備一個 API token，權限需含：
- **Workers AI**：Read + Edit（嵌入）
- **Vectorize**：Edit（建立 / upsert）
- **D1**：Edit（記帳表）

```bash
export CLOUDFLARE_ACCOUNT_ID=<該帳號 ID>
export CLOUDFLARE_API_TOKEN=<上述 token>
```

> ⚠️ **建索引前先煙霧測試模型**（維度一旦建立不可改）：
> ```bash
> npx wrangler ai models | grep embeddinggemma     # 確認模型在此帳號可用
> curl https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/google/embeddinggemma-300m \
>   -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
>   -d '{ "text": ["task: search result | query: 唐鳳談數位民主"] }' | jq '.result.shape'
> # 預期 shape = [1, 768]
> ```
> 若中文召回不佳，可改用 `@cf/baai/bge-m3`（**1024 維**）——此時索引維度需改 1024，
> 並同步 `src/utils/vectorize.ts` 的 `EMBEDDING_MODEL` / `EMBEDDING_DIM`。

### 5.1 建立索引（一次）

```bash
npm run vectorize:create
# = wrangler vectorize create askit-audrey-tang --dimensions=768 --metric=cosine
```

### 5.2 回填向量（可中斷續跑）

```bash
# 乾跑：只報告「會新增幾筆 / 待向量化幾筆」，不嵌入、不寫入
DRY_RUN=1 npm run vectorize:sync

# 小量煙霧測試（只處理 50 筆）
LIMIT=50 npm run vectorize:sync

# 正式全量
npm run vectorize:sync
```

中斷後重跑會自動從 `is_vectorized=0` 處續跑（upsert 冪等，重嵌同一批也安全）。

### 5.3 啟用 runtime 檢索

1. 編輯 `wrangler.jsonc`，**解除 `vectorize` binding 的註解**。
2. `npm run deploy`。

之後 `/cag`、LINE webhook 預設走 Vectorize；查無結果會自動回退 archive。

### 5.4 增量維護（之後每次上游更新）

直接再跑一次即可（建議排程，類比 `refresh-cag-index.yml`）：

```bash
npm run vectorize:sync
```

它會：新增缺漏的 section_id、對 `content_sha` 變更者重設 `is_vectorized=0` 重嵌。

---

## 6. A/B 比較與回退

- 逐次切換（不需重部署）：`/cag/<問題>?retriever=archive` vs `?retriever=vectorize`
- 預設切換（webhook 也吃）：環境變數 `CAG_RETRIEVER=archive|vectorize`
- 現況回報：`GET /cag/status`（回傳目前生效的 retriever / model）
- **回退**：把 `CAG_RETRIEVER` 設回 `archive`，或將 `wrangler.jsonc` 的 vectorize binding 重新註解。

---

## 7. 「取 6 引 2」：背景脈絡 vs 顯示出處

LINE Flex 只排 2 欄出處，但只餵 2 筆給模型會浪費召回。因此：

- **檢索 topK=6** 餵給模型；其中前 **2 筆**為「可引用來源」（編號 `[1][2]`、回傳顯示），
  其餘 4 筆放進 `<background>` 區塊，**僅供模型理解脈絡、不編號、不可被引用**。
- 由 `CagOptions.citableTopK` 控制（webhook 設 6/2）。
- `/cag` 可用 `?cite_top_k=2` 試玩；未設時維持「全部可引用」舊行為。

---

## 8. 已知限制（實驗範圍）

- **刪除未同步**：上游刪段或某段不再符合條件時，腳本只記錄數量、不刪 Vectorize 向量
  （`syncMembership` 的 `stale` 計數）。需要時再加 `delete-vectors`。
- **非同步索引**：upsert 後向量需數秒才可查；剛回填完的立即查詢可能短暫落空（會回退 archive）。
- **metadata 過濾未啟用**：目前純 top-K 語意召回，未建 metadata index（日後要依日期/講者過濾再加）。
- **模型中文品質**：embeddinggemma 多語含中文，但繁中召回品質建議以 5.0 煙霧測試與 A/B 實測為準。

---

## 9. 相關檔案

| 檔案 | 角色 |
|---|---|
| `src/utils/vectorize.ts` | 常數、前綴、metadata→CagSource、runtime 語意檢索 |
| `scripts/vectorize-sync.ts` | 建表 + 成員同步 + 回填（冪等可續跑） |
| `src/utils/cag.ts` | `resolveCagSources` 檢索器切換、`citableTopK` 背景/引用切分 |
| `src/index.ts` | `CAG_RETRIEVER` / `?retriever=` / `VECTORIZE` binding 接線 |
| `wrangler.jsonc` | `CAG_RETRIEVER` var、（註解中的）`VECTORIZE` binding |
| `test/vectorize.test.ts` | 前綴、嵌入解析、metadata 映射、檢索去重/回退 |
| `design/cag-memories.md` | 本地記憶體原型（qwen3-embedding:0.6b / JSONL；**不是** askit-audrey-tang） |
