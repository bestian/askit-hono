# Phase 2: plurality-ask worker scaffold

**Repo:** `plurality.net/worker/`  
**Acceptance:** `npm test` in worker; `curl -N 'http://127.0.0.1:8788/au/test?lang=zh'` returns 200 streamed text.

## Delivered

- Hono worker: `GET /au/:question?lang=`, `GET /capacity`, OPTIONS + CORS via `@au/cf-ai-gateway`
- Stub RAG markdown in `stubAnswer.ts` (Phase 3 replaces)
- `resolveQueryLang` for en/zh/ja/de/th/el
- Dependency: `file:vendor/au-cf-ai-gateway-0.1.0.tgz` (or `^0.1.0` from npm `@au/cf-ai-gateway`)
- wrangler dev port **8788** (askit 8787)

## Next (Phase 3)

Vectorize `plurality-book`, bge-m3 sync script, real RAG + Nemotron gateway.