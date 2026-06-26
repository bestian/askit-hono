# CF AI Gateway package extract (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract shared `@audreyt/cf-ai-gateway` npm workspace package from askit-hono and rewire askit imports with zero `/au` behavior change.

**Architecture:** New `packages/cf-ai-gateway` holds Baseten/Fugu gateway clients, SSE parsers, gateway env resolution, optional ask CORS factory, and verify CLI. askit-hono `src/utils/*` become thin re-exports or delete-and-import. Tests for gateway code run in the package; askit integration tests unchanged.

**Tech Stack:** TypeScript 5.7, Node 22+, `node:test`, Cloudflare Workers fetch types, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-26-plurality-search-gateway-extract-design.md`

## Global Constraints

- Node `>=22`; TypeScript `strict`.
- Baseten upstream: `Authorization: Api-Key $BASETEN_API_KEY`.
- Optional gateway: `cf-aig-authorization: Bearer $CF_AIG_TOKEN`.
- Default gateway: account `99984e3c707dd2518f73dfa9da3fc887`, id `kami`.
- Default Nemotron model id: `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B`.
- No Node-only APIs in package runtime modules (verify CLI may use `node:fs`).
- Phase 1 must not change askit wrangler deploy bindings or production secrets layout.

---

## File map (Phase 1)

| Path | Role |
|------|------|
| `packages/cf-ai-gateway/package.json` | Package manifest, `exports` map |
| `packages/cf-ai-gateway/tsconfig.json` | Strict, `moduleResolution: bundler` |
| `packages/cf-ai-gateway/src/defaults.ts` | Gateway account/id constants |
| `packages/cf-ai-gateway/src/baseten.ts` | Moved from `src/utils/basetenGateway.ts` |
| `packages/cf-ai-gateway/src/fugu.ts` | Moved from `src/utils/fuguGateway.ts` |
| `packages/cf-ai-gateway/src/types.ts` | `AudreyAiGatewayConfig` union |
| `packages/cf-ai-gateway/src/resolveGateway.ts` | From `audreyGatewayBindings.ts` + model id constants |
| `packages/cf-ai-gateway/src/askCors.ts` | Extracted from `src/index.ts` CORS helpers |
| `packages/cf-ai-gateway/src/loadDevVars.ts` | From `scripts/loadDevVars.ts` |
| `packages/cf-ai-gateway/src/index.ts` | Public re-exports |
| `packages/cf-ai-gateway/test/*.test.ts` | Moved gateway unit tests |
| `packages/cf-ai-gateway/scripts/verify-baseten.ts` | From `scripts/verify-baseten-nemotron-gateway.ts` |
| `askit-hono/package.json` | Add `workspaces`, depend on `@audreyt/cf-ai-gateway` |
| `askit-hono/src/utils/basetenGateway.ts` | Re-export from package (or delete + update imports) |
| `askit-hono/src/utils/fuguGateway.ts` | Re-export |
| `askit-hono/src/utils/audreyGatewayBindings.ts` | Re-export `resolveAudreyAiGateway` |
| `askit-hono/src/index.ts` | Use `createAskCors` from package |

---

### Task 1: Scaffold workspace package

**Files:**
- Create: `packages/cf-ai-gateway/package.json`
- Create: `packages/cf-ai-gateway/tsconfig.json`
- Modify: `package.json` (root workspaces)

**Interfaces:**
- Produces: npm package name `@audreyt/cf-ai-gateway` version `0.1.0`.

- [ ] **Step 1: Add workspaces to root `package.json`**

```json
"workspaces": ["packages/*"],
"dependencies": {
  "@audreyt/cf-ai-gateway": "workspace:*",
  ...
}
```

- [ ] **Step 2: Create `packages/cf-ai-gateway/package.json`**

```json
{
  "name": "@audreyt/cf-ai-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./loadDevVars": "./src/loadDevVars.ts",
    "./verify-baseten": "./scripts/verify-baseten.ts"
  },
  "scripts": {
    "test": "node --import tsx --test test/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "tsx": "^4.21.0",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 3: `npm install` at repo root**

Run: `npm install`
Expected: lockfile updates; `node_modules/@audreyt/cf-ai-gateway` links to `packages/cf-ai-gateway`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json packages/cf-ai-gateway/package.json packages/cf-ai-gateway/tsconfig.json
git commit -m "chore: scaffold @audreyt/cf-ai-gateway workspace"
```

---

### Task 2: Move gateway transport modules

**Files:**
- Create: `packages/cf-ai-gateway/src/defaults.ts`, `baseten.ts`, `fugu.ts`, `types.ts`
- Modify: delete bodies from askit copies after re-export (same task)

**Interfaces:**
- Produces: `buildBasetenChatCompletionsUrl`, `completeViaGatewayChatCompletions`, `streamViaGatewayChatCompletions`, `openAiChatCompletionsEventStreamToText`, fugu equivalents, `DEFAULT_CF_AI_GATEWAY_*`.

- [ ] **Step 1: Copy `src/utils/aiGatewayDefaults.ts` → `packages/cf-ai-gateway/src/defaults.ts`**

- [ ] **Step 2: Copy `src/utils/basetenGateway.ts` → `packages/cf-ai-gateway/src/baseten.ts`**

Update import: `from './defaults.js'` (or `.ts` per tsconfig).

- [ ] **Step 3: Copy `src/utils/fuguGateway.ts` → `packages/cf-ai-gateway/src/fugu.ts`**

- [ ] **Step 4: Copy `src/utils/audreyAiGateway.ts` → `packages/cf-ai-gateway/src/types.ts`**

Rename export type to `CfAiGatewayConfig` (keep alias `AudreyAiGatewayConfig` for compatibility).

- [ ] **Step 5: Replace askit files with re-exports**

`src/utils/basetenGateway.ts`:

```ts
export * from '@audreyt/cf-ai-gateway/baseten'
```

(Add subpath export in package.json `"./baseten": "./src/baseten.ts"` or export all from index.)

Prefer **index re-exports** so askit keeps `from './basetenGateway'` paths:

```ts
// src/utils/basetenGateway.ts
export * from '@audreyt/cf-ai-gateway'
```

and `packages/cf-ai-gateway/src/index.ts` exports baseten + fugu symbols.

- [ ] **Step 6: Run askit tests**

Run: `npm test`
Expected: PASS (no behavior change yet if exports match).

- [ ] **Step 7: Commit**

```bash
git add packages/cf-ai-gateway/src askit-hono/src/utils/basetenGateway.ts ...
git commit -m "refactor: move baseten/fugu gateway into shared package"
```

---

### Task 3: Move resolveGateway + tests

**Files:**
- Create: `packages/cf-ai-gateway/src/resolveGateway.ts`, `src/modelIds.ts`
- Create: `packages/cf-ai-gateway/test/resolveGateway.test.ts` (from `test/audreyGatewayBindings.test.ts`)
- Modify: `src/utils/audreyGatewayBindings.ts` → re-export

**Interfaces:**
- Produces: `resolveAudreyAiGateway(env: GatewayEnv): CfAiGatewayConfig | undefined`
- Consumes: `resolveGateway` needs model ids `nemotron-ultra`, `fugu` without importing full `audreySkill.ts`.

- [ ] **Step 1: Add `modelIds.ts`**

`resolveGatewayModelId(audreyModel)` returns `fugu` | `nemotron-ultra` | `undefined`.
**Do not** default unset/gemma/glm to nemotron — that would change `/au` when `BASETEN_API_KEY` is set but `AUDREY_MODEL` is not explicit (Workers AI path must stay).

- [ ] **Step 2: Move binding resolver logic to `resolveGateway.ts`**

Copy from `audreyGatewayBindings.ts`; imports from `./baseten`, `./fugu`, `./defaults`.

- [ ] **Step 3: Move test file; fix import paths**

Run: `cd packages/cf-ai-gateway && npm test`
Expected: PASS nemotron + fugu config tests.

- [ ] **Step 4: askit `audreyGatewayBindings.ts` re-export only**

- [ ] **Step 5: Run full askit `npm test`**

- [ ] **Step 6: Commit**

---

### Task 4: Extract askCors factory

**Files:**
- Create: `packages/cf-ai-gateway/src/askCors.ts`
- Create: `packages/cf-ai-gateway/test/askCors.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces:

```ts
export type AskCorsOptions = {
  allowedOrigins: ReadonlySet<string> | readonly string[]
  allowedMethods?: string
  allowedHeaders?: string
  maxAgeSeconds?: string
}

export function createAskCors(options: AskCorsOptions): {
  apply(request: Request, response: Response): Response
  preflight(request: Request): Response
  isAllowedOrigin(origin: string | undefined): boolean
}
```

- [ ] **Step 1: Read `applyAskCors` + `appendVary` from `src/index.ts` and implement in package**

Logic unchanged: if `Origin` in allowlist, set ACAO + credentials false + methods/headers/max-age; append `Vary: Origin`.

- [ ] **Step 2: Unit test allow / deny origins**

- [ ] **Step 3: Wire askit `src/index.ts`**

```ts
import { createAskCors } from '@audreyt/cf-ai-gateway'

const askCors = createAskCors({
  allowedOrigins: new Set([
    'https://archive.tw',
    'https://ask.archive.tw',
    'http://localhost:8787',
  ]),
})

function applyAskCors(c, response) {
  return askCors.apply(c.req.raw, response)
}
```

Keep Hono `Context` wrapper thin.

- [ ] **Step 4: Run `npm test` including `test/auCors.test.ts`**

Expected: PASS (archive.tw still allowed).

- [ ] **Step 5: Commit**

---

### Task 5: Move loadDevVars + verify CLI

**Files:**
- Create: `packages/cf-ai-gateway/src/loadDevVars.ts`
- Create: `packages/cf-ai-gateway/scripts/verify-baseten.ts`
- Modify: root `package.json` script `cf:baseten-verify`

- [ ] **Step 1: Move `scripts/loadDevVars.ts` into package**

- [ ] **Step 2: Move verify script; import `resolveAudreyAiGateway` from package**

- [ ] **Step 3: Update root script**

```json
"cf:baseten-verify": "tsx --tsconfig packages/cf-ai-gateway/tsconfig.json packages/cf-ai-gateway/scripts/verify-baseten.ts"
```

- [ ] **Step 4: Run `npm run cf:baseten-verify`** (requires `.dev.vars` with `BASETEN_API_KEY`)

Expected: direct Baseten ok; CF leg skipped or ok if `CF_AIG_TOKEN` set.

- [ ] **Step 5: Commit**

---

### Task 6: Package test suite + CI gate

**Files:**
- Modify: root `package.json` scripts

- [ ] **Step 1: Add root script**

```json
"test:gateway-package": "npm test -w @audreyt/cf-ai-gateway"
```

- [ ] **Step 2: Document in spec that CI should run `npm test && npm run test:gateway-package`**

- [ ] **Step 3: Final verification**

Run: `npm run typecheck && npm test && npm run test:gateway-package`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: gateway package test script and phase 1 complete"
```

---

## Phase 2–4 outline (separate execution plans)

After Phase 1 merges, implement in `plurality.net` repo:

| Phase | Key files | Acceptance |
|-------|-----------|------------|
| **2** | `plurality.net/worker/src/index.ts`, `wrangler.jsonc`, depend on `@audreyt/cf-ai-gateway` via git submodule or npm `file:../../askit-hono/packages/cf-ai-gateway` | Local `wrangler dev` `/au/hello` streams |
| **3** | `scripts/vectorize-sync-book.ts`, Vectorize `plurality-book` | Retrieved chunk URLs are on `plurality.net` |
| **4** | `src/_includes/js/search.js`, DNS `ask.plurality.net` | Manual browser Enter test on prod |

**Phase 2 CORS allowlist** in plurality-ask worker:

`https://plurality.net`, `http://localhost:8080`, `http://127.0.0.1:8080`.

---

## Plan self-review

| Spec requirement | Task |
|------------------|------|
| Shared baseten/fugu/SSE | Task 2 |
| resolveGateway | Task 3 |
| askCors factory | Task 4 |
| verify + loadDevVars | Task 5 |
| askit zero behavior change | Tasks 2–4 tests |
| plurality worker / search.js | Phase 2–4 outline |

No TBD placeholders in Phase 1 tasks.

---

## Execution handoff

**Plan saved to** `docs/superpowers/plans/2026-06-26-plurality-gateway-phase1-extract.md`.

**Two execution options:**

1. **Subagent-driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline** — implement Phase 1 in this session with executing-plans checkpoints.

**Also:** Review spec at `docs/superpowers/specs/2026-06-26-plurality-search-gateway-extract-design.md` before starting code.

Which approach?