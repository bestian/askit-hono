### Task 2: Move gateway transport modules

**Files:**
- Create: `packages/cf-ai-gateway/src/defaults.ts`, `baseten.ts`, `fugu.ts`, `types.ts`, update `index.ts`
- Modify: `src/utils/basetenGateway.ts`, `fuguGateway.ts`, `audreyAiGateway.ts`, `aiGatewayDefaults.ts` → thin re-exports from `@audreyt/cf-ai-gateway`

**Steps:**
1. Copy `src/utils/aiGatewayDefaults.ts` → `packages/cf-ai-gateway/src/defaults.ts`
2. Copy `src/utils/basetenGateway.ts` → `packages/cf-ai-gateway/src/baseten.ts` (import from `./defaults.ts`)
3. Copy `src/utils/fuguGateway.ts` → `packages/cf-ai-gateway/src/fugu.ts`
4. Copy `src/utils/audreyAiGateway.ts` → `packages/cf-ai-gateway/src/types.ts`; export `CfAiGatewayConfig` and alias `AudreyAiGatewayConfig`
5. `packages/cf-ai-gateway/src/index.ts` — re-export all public symbols from defaults, baseten, fugu, types (everything askit imported from those four files)
6. Replace askit `src/utils/basetenGateway.ts`, `fuguGateway.ts`, `audreyAiGateway.ts`, `aiGatewayDefaults.ts` with:
   `export * from '@audreyt/cf-ai-gateway'` OR split re-exports matching prior export surface so all askit imports still resolve.
7. Run `npm test` at repo root — must PASS
8. Commit: `refactor: move baseten/fugu gateway into shared package`

Report: `.superpowers/sdd/task-2-report.md`