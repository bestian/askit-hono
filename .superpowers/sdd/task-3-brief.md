### Task 3: Move resolveGateway + tests

1. Add `packages/cf-ai-gateway/src/modelIds.ts` per plan (GATEWAY_MODEL_FUGU, GATEWAY_MODEL_NEMOTRON_ULTRA, normalizeGatewayModel)
2. Move `resolveAudreyAiGateway` from `src/utils/audreyGatewayBindings.ts` to `packages/cf-ai-gateway/src/resolveGateway.ts` — use modelIds; do NOT import askit `audreySkill.ts`
3. Export `resolveAudreyAiGateway`, `AudreyGatewayEnv` type from package index
4. Move `test/audreyGatewayBindings.test.ts` → `packages/cf-ai-gateway/test/resolveGateway.test.ts` (fix imports)
5. askit `audreyGatewayBindings.ts` → re-export from package
6. `npm test` root + `npm test -w @audreyt/cf-ai-gateway` both PASS
7. Commit: `refactor: move resolveAudreyAiGateway to shared package`

Report `.superpowers/sdd/task-3-report.md`