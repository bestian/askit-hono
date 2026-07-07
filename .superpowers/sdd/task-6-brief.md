### Task 6: Package test suite + CI gate

1. Root package.json: `"test:gateway-package": "npm test -w @audreyt/cf-ai-gateway"`
2. Append to spec `docs/superpowers/specs/2026-06-26-plurality-search-gateway-extract-design.md` under Phase 1 or References one line: CI runs `npm test && npm run test:gateway-package`
3. Run `npm run typecheck && npm test && npm run test:gateway-package` — all PASS
4. Commit any remaining doc/script changes: `chore: gateway package CI test script`

Report `.superpowers/sdd/task-6-report.md`