# Contributing | 貢獻指南

**English** — Thanks for helping improve 鳳問 Ask Audrey!

- **Setup:** Node 22+, `npm ci`. Run the worker locally with `npm run dev`
  (uses remote R2/AI bindings — needs `npx wrangler login`).
- **Before opening a PR:** `npm run typecheck` and `npm test` must pass.
  CI also dry-run-validates the Worker bundle.
- **Discussions & bugs:** please use
  [GitHub issues](https://github.com/bestian/askit-hono/issues).
  Issues and PRs are welcome in English or 華語.
- **Scope note:** retrieval/generation changes should come with eval results
  (`npm run eval:cag:depth`) showing answer quality does not regress.

**華語** — 歡迎協助改進鳳問！

- **環境**：Node 22+、`npm ci`。本機開發用 `npm run dev`（使用遠端
  R2／AI binding，需先 `npx wrangler login`）。
- **送 PR 前**：`npm run typecheck` 與 `npm test` 必須通過；CI 也會
  dry-run 驗證 Worker bundle。
- **討論與回報**：請用
  [GitHub issues](https://github.com/bestian/askit-hono/issues)，
  華語或英文皆可。
- **範圍提醒**：涉及檢索／生成的修改，請附上
  `npm run eval:cag:depth` 的結果，確認回答品質沒有退步。
