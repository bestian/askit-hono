# Task 4 Report

**Status:** DONE

**Commit:** `refactor: extract ask CORS factory to shared package` (after apply on base `9ca1c2c`)

## Changes

- Added `packages/cf-ai-gateway/src/askCors.ts` with `createAskCors` (`apply`, `preflight`, `isAllowedOrigin`) and internal `appendVary` logic moved from askit.
- Added `packages/cf-ai-gateway/test/askCors.test.ts` (allowed/denied origins, apply/preflight).
- Exported `askCors` from `packages/cf-ai-gateway/src/index.ts`.
- Wired `src/index.ts`: `createAskCors` with origins `https://archive.tw`, `https://ask.archive.tw`, `http://localhost:8787`; thin Hono wrappers `applyAskCors` / `askCorsPreflight` delegate to package.

## Tests

| Suite | Result |
|-------|--------|
| `npm test -w @audreyt/cf-ai-gateway` | 7 pass, 0 fail |
| `npm test` (root, includes `test/auCors.test.ts`) | 223 pass, 0 fail |