### Task 5: Move loadDevVars + verify CLI

1. Move `scripts/loadDevVars.ts` → `packages/cf-ai-gateway/src/loadDevVars.ts`
2. Move `scripts/verify-baseten-nemotron-gateway.ts` → `packages/cf-ai-gateway/scripts/verify-baseten.ts` — import from package
3. askit `scripts/loadDevVars.ts` re-export or thin wrapper importing from package (update all script imports)
4. Root package.json: `"cf:baseten-verify": "tsx --tsconfig packages/cf-ai-gateway/tsconfig.json packages/cf-ai-gateway/scripts/verify-baseten.ts"`
5. Run `npm test`; run `npm run cf:baseten-verify` if BASETEN in .dev.vars else note skipped in report
6. Commit: `refactor: move baseten verify CLI into gateway package`

Report `.superpowers/sdd/task-5-report.md`