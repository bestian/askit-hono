# Plurality search + shared CF AI Gateway — design spec

> **Decision (2026-06-26):** Approach **C** — dedicated `plurality-ask` Cloudflare Worker
> for book-grounded `/au`, with **extracted shared npm package** for Nemotron/Fugu +
> Cloudflare AI Gateway transport. **Not** extending `ask.archive.tw` for Plurality book RAG.

## Goals

1. **plurality.net** search overlay: Enter triggers streamed AI answer, then keyword
   (Pagefind / Fuse) results — same UX contract as `sayit-hono` `pagefind-search.js`.
2. **Book-grounded** answers with citations to `https://plurality.net/{lang}/read/...`
   (subsection URLs aligned with `search-builder.js` / `search-index.json`).
3. **Same inference path** as askit production: Baseten Nemotron Ultra via CF AI Gateway
   `kami` (`BASETEN_API_KEY` + `CF_AIG_TOKEN`, upstream `Api-Key`).
4. **GH Pages stays static** — no Worker secrets in the Pages artifact; browser calls
   cross-origin Worker (e.g. `https://ask.plurality.net`).

## Non-goals (this program)

- Routing Plurality book questions through default `ask.archive.tw/au` (transcript corpus).
- Moving LINE webhook, Audrey skill mining, or sayit D1 retrieval into the shared package.
- Publishing the package to public npm in v1 (workspace / `file:` dependency is fine).

## Architecture

```text
plurality.net (GH Pages)
  search.js ──CORS──► plurality-ask Worker (CF)
                         ├─ Vectorize: plurality-book
                         ├─ RAG + book prompts
                         └─ @au/cf-ai-gateway → gateway kami / baseten

askit-hono (ask.archive.tw) — unchanged product scope
  /au transcripts ──► same @au/cf-ai-gateway package
```

## Shared package: `@au/cf-ai-gateway`

**Location (v1):** `packages/cf-ai-gateway/` inside `askit-hono` repo.

**Cross-repo consumption (plurality.net):** `npm install @au/cf-ai-gateway` (public npm, scope `@au`).
Pin semver in `plurality-ask` `package.json`. Optional vendored `au-cf-ai-gateway-*.tgz` for pre-release pins.

**Exports:**

| Module | Responsibility |
|--------|----------------|
| `defaults` | `DEFAULT_CF_AI_GATEWAY_ACCOUNT_ID`, `DEFAULT_CF_AI_GATEWAY_ID` (`kami`) |
| `baseten` | URL builder, chat completions + stream, SSE → text transform |
| `fugu` | custom-sakana `/v1/responses`, SSE → text transform |
| `resolveGateway` | Map env (`BASETEN_API_KEY`, `SAKANA_API_KEY`, `CF_AIG_TOKEN`, model id) → chat or responses config |
| `askCors` | `createAskCors({ allowedOrigins })` → `applyCors(request, response)`, preflight helper |
| `dev/loadDevVars` | Parse `.dev.vars` for verify scripts |
| `cli/verify-baseten` | Smoke direct Baseten + optional CF gateway path |

**Tests moved with package:** `baseten`/`fugu`/`resolveGateway` unit tests (from
`test/fuguGateway.test.ts`, `test/audreyGatewayBindings.test.ts`).

**Stays in each Worker:**

- Full `cag.ts`, abuse DO, rate limits, LINE, transcript D1 / archive fallback (askit).
- Book chunking, Vectorize index name, prompts, citation HTML (plurality-ask).

## plurality-ask Worker

**Repo placement (default):** `plurality.net/worker/` in the book site git repo
(deploy via wrangler; not uploaded to Pages artifact).

**Routes (minimum):**

- `GET /au/:question` — stream markdown/plain answer (match askit stream shape sayit expects).
- `OPTIONS /au/:question`
- `GET /capacity` — generation budget fraction for UI gating.
- `OPTIONS /capacity`

**CORS allowlist:**

- `https://plurality.net`
- `http://localhost:8080` (Eleventy `bun run dev` default)
- Optional: `http://127.0.0.1:8080`

**Secrets / vars:** `BASETEN_API_KEY`, `CF_AIG_TOKEN`, `AUDREY_MODEL=nemotron-ultra`
(or dedicated alias), `BASETEN_MODEL` optional.

**Bindings:** Vectorize index `plurality-book` — **separate from askit** (do not reuse
`askit-audrey-tang` or askit’s transcript-tuned embed defaults without evaluation).

## Multilingual RAG (required)

plurality.net is a **multi-translation book site** (`en`, `zh`, `ja`, `de`, `th`, `el`, …).
`search-builder.js` builds **per-language** chapter entries with URLs `/{lang}/read/{id}/`;
some chapters exist only in some languages. AI search must not collapse to English-only.

**Pin these three behaviors in plurality-ask (not optional metadata):**

1. **Multilingual embedding model** — index and query use the **same** Workers AI embedder
   chosen for book RAG. Default: `@cf/baai/bge-m3` (**1024** dimensions, cosine) unless
   account smoke tests show a better CF option for th/el/ja/de/zh. **Do not** default to
   askit’s `@cf/google/embeddinggemma-300m` (768-dim) solely because askit uses it; askit
   corpus is Audrey transcripts (mostly en/zh). Create index:
   `wrangler vectorize create plurality-book --dimensions=1024 --metric=cosine` when using bge-m3.
2. **Language-filtered retrieval** — resolve query language `lang` (see below) → embed query →
   Vectorize query with **metadata filter `lang = <query lang>`** (enable metadata indexing on
   `lang` at sync time). Only same-language chunks are candidates; citations use metadata `url`
   on `plurality.net` for that language.
3. **Answer language** — generation prompt and stream copy match **query language** (e.g. Thai
   question → Thai answer with Thai book citations). Do not answer in English when `lang` is
   not `en`.

**Query language resolution (plurality-ask):**

- Prefer explicit `?lang=` from the static site (`search.js` passes page lang: `zh`, `ja`, `de`, `th`, `el`, or default `en`).
- Optional heuristic fallback only when `lang` omitted (Latin vs Han vs Thai script); explicit param wins.

**Indexing metadata (minimum per vector):** `lang`, `url`, `heading`, `chapterTitle`, `content`
(truncated). Vector id stable: `{lang}:{chapterPath}:{headingSlug}`.

**Shared embed helper:** Extract batch embed + retry from askit `vectorize-sync.ts` as a
**parameterized** helper (`model`, `dimensions`, optional query/doc prefixes). Plurality
and askit pass different model constants; verify CF bge-m3 input format before reuse.

**Gateway routing (askit):** `resolveAudreyAiGateway` only when `AUDREY_MODEL` is explicitly
`fugu` or `nemotron-ultra`; unset/gemma/glm → `undefined` (Workers AI), even if `BASETEN_API_KEY` is set.

## Migration phases

**Phase 1 CI:** `npm test && npm run test:gateway-package` before merge.

| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **1** | Package extract + askit imports package | `npm test`, `npm run test:gateway-package`, `npm run cf:baseten-verify` |
| **2** | `plurality-ask` worker scaffold | curl local `/au` returns 200 stream |
| **3** | Vectorize backfill + real RAG | `?lang=zh` → `/zh/read/…`; `?lang=th` → `/th/read/…`; lang filter on query |
| **4** | `search.js` + DNS `ask.plurality.net` | Browser Enter → AI + Fuse hits |

## Global constraints

- Node `>=22`, TypeScript strict, Workers-compatible fetch (no Node-only APIs in package).
- Baseten upstream header: `Authorization: Api-Key $BASETEN_API_KEY` (not Bearer).
- Gateway run header when set: `cf-aig-authorization: Bearer $CF_AIG_TOKEN`.
- Max question length: 100 Unicode scalars (match askit `/au`).
- plurality-book: default embed `@cf/baai/bge-m3`, 1024-dim cosine (unless spec revision after smoke test).
- plurality-ask `/au`: require `lang` filter on Vectorize query; answer text matches query `lang`.
- CORS: only echo `Access-Control-Allow-Origin` for listed origins; `Vary: Origin`.

## Open decisions (defaults chosen above)

| Question | Default |
|----------|---------|
| Package home | `askit-hono/packages/cf-ai-gateway` |
| Worker repo | `plurality.net/worker/` |
| Book voice | Plurality book assistant, not Audrey skill |

## References

- askit: `src/utils/basetenGateway.ts`, `audreyGatewayBindings.ts`, `test/auCors.test.ts`
- sayit client: `www/static/speeches/js/pagefind-search.js` (`resolveAskBaseUrl`, `runAsk`)
- plurality search: `src/_includes/js/search.js`, `src/_data/lib/search-builder.js`