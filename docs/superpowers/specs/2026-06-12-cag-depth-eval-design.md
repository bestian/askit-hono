# CAG depth eval — honest baseline before Vectorize hydrate

> **Goal:** Measure whether Approach 1 (Vectorize rank + archive hydrate) fixes
> shallow-but-relevant homepage answers, using a production-shaped baseline.

## Problem

`npm run eval:cag` uses archive search + full section hydration. Production `/cag`
uses Vectorize metadata (~175 chars/section). The harness can pass 8/8 while users
see shallow answers.

## Two eval arms (same questions, same Gemma, same generation params)

| Arm | Mirrors | Purpose |
|---|---|---|
| `vectorize-thin` | Production today | Baseline depth |
| `vectorize-hydrate` | Approach 1 preview | What hydration buys |

Archive-only remains an optional reference ceiling, not the pass gate.

## Depth metrics (beyond binary pass/fail)

| Metric | Catches |
|---|---|
| `answerChars` / `sentenceCount` | Too-short answers |
| `totalSourceChars` / `avgSourceChars` | Thin context fed to model |
| `groundingScore` | Answer bigram overlap with cited source plain text (0–1) |
| `shallow` | Binary pass but fails depth floor (`answerChars < 80` or `grounding < 0.08` for zh-TW cases) |
| `retrievalMs` / `hydrateMs` / `generateMs` | Latency cost of hydrate |

**Primary criterion for Approach 1:** `shallow` rate drops on `vectorize-hydrate` vs
`vectorize-thin`, without binary pass rate dropping.

## Deliverables

- `scoreCagDepth()` in `src/utils/cagEval.ts` (unit tested)
- `hydrateCagSourcesFromArchive()` in `src/utils/cag.ts` (eval first, production later)
- `scripts/eval-cag-depth.ts` — `--mode=compare|thin|hydrate`
- `npm run eval:cag:depth`

## Out of scope

- LLM-as-judge
- Vectorize re-index with longer metadata (Approach 3)
- Homepage streaming perf (separate)

## Success gate before merging production hydrate

Run `npm run eval:cag:depth` and confirm `shallow` improves materially on
`vectorize-hydrate` with acceptable latency delta.