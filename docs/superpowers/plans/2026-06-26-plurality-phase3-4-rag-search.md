# Phases 3–4 (delivered in plurality.net)

## Phase 3 — RAG worker

- `worker/src/vectorize.ts` — bge-m3 embed + lang-filtered Vectorize query
- `worker/src/rag.ts` — Nemotron via `@au/cf-ai-gateway`; stub without secrets/index
- `worker/wrangler.toml` — `AI`, `BOOK_VECTORIZE` bindings
- `scripts/vectorize-sync-book.mjs` — build search index → embed → upsert

**Ops:** `wrangler vectorize create plurality-book --dimensions=1024 --metric=cosine`  
`CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun run vectorize:sync-book`  
`wrangler secret put BASETEN_API_KEY` / `CF_AIG_TOKEN`  
`cd worker && wrangler deploy` + route `ask.plurality.net/*`

## Phase 4 — Static site

- `src/_includes/js/book-ask.js` — `/capacity`, Enter → stream `/au?lang=`
- `search.js` — `plurality-search-after-ask` → Fuse results
- Dev: `?ask_base=http://127.0.0.1:8788`, worker port 8788