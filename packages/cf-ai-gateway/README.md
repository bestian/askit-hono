# @audreyt/cf-ai-gateway

Cloudflare AI Gateway transport for Baseten (Nemotron) and Sakana Fugu — shared by askit-hono and plurality-ask Workers.

## Install

```bash
npm install @audreyt/cf-ai-gateway
```

## Exports

- Baseten chat completions + SSE parsing
- Fugu `/v1/responses` + SSE parsing
- `resolveAudreyAiGateway(env)` — explicit `fugu` / `nemotron-ultra` only
- `createAskCors({ allowedOrigins })`

Workers-compatible `fetch` only in runtime modules; `loadDevVars` is Node-only (CLI).

## License

MIT