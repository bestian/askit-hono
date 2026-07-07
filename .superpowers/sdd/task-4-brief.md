### Task 4: Extract askCors factory

1. Read `src/index.ts` `appendVary`, `applyAskCors` (lines ~229-261) — implement `packages/cf-ai-gateway/src/askCors.ts` with `createAskCors` API from plan
2. Add `packages/cf-ai-gateway/test/askCors.test.ts` — allowed vs denied origin
3. Wire askit `src/index.ts` to use `createAskCors` with same origins: archive.tw, ask.archive.tw, localhost:8787
4. `npm test` — `test/auCors.test.ts` must PASS
5. Commit: `refactor: extract ask CORS factory to shared package`

Report `.superpowers/sdd/task-4-report.md`