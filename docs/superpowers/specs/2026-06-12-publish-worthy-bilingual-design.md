# Publish-worthy showcase: bilingual docs + English web UI — design

> **Goal:** Make this repo present 鳳問 well to a world audience: accurate
> English-first docs with a 華語 twin, an English version of the
> ask.archive.tw page, and standard open-source trust signals. Showcase only —
> no white-labelling/template work.

## Problem

The repo is already public (bestian/askit-hono) with a live product, CI,
tests, and an MIT licence, but:

- **README is stale** — claims the default model is Kimi K2.6 (now
  Gemma 4 26B A4B), says `GET /` returns "Hello World!" (now the full 鳳問
  Vue app), and the project-structure section predates `cag.ts`,
  `vectorize.ts`, `cagCache.ts`, `cagEval.ts`, `pages/`, KV cache, Vectorize,
  and rate limiting.
- **Web UI is zh-Hant only** — title, consent gate, samples, footer, OG tags.
  A non-Chinese visitor following the demo link is stopped at the door.
- **Single-file bilingual README** is 640 lines and hard to skim.
- **Rough metadata** — awkward one-line English description, topics only
  `hono` + `line-bot`, no screenshots, architecture SVG buried in `design/`.
- No CONTRIBUTING/SECURITY; 1.2 MB `logo.png` at repo root.

## Decisions (brainstormed 2026-06-12)

| Question | Decision |
|---|---|
| Goal | Showcase 鳳問 itself; **no** reusable-template work |
| Bilingual scope | Docs **and** web UI; **no** answer-language steering |
| Polish extras | Screenshots/media, repo metadata, community files, embed architecture diagram — all in scope |
| Delivery shape | Split docs (`README.md` EN + `README.zh-TW.md`) + server-rendered `/en` page set |

## A. Documentation

**Structure.** `README.md` = English showcase (what GitHub renders to the
world). `README.zh-TW.md` = 華語 twin. Both open with a language switcher
line (`English | [華語](README.zh-TW.md)` and the inverse). Identical section
structure in both files so future edits mirror 1:1.

**Section outline (both languages):**

1. **Hero** — logo (small, via HTML `img`), 鳳問, one-liner ("Ask Audrey Tang
   anything — cited AI answers grounded in her 30-year public transcript
   archive"), CI badge, MIT badge, prominent **Try it → https://ask.archive.tw**.
2. **Screenshots** — web UI capture(s); LINE conversation screenshot only if
   provided (see Open items).
3. **How it works** — embed `design/CAG-system-design.svg`; short prose:
   Vectorize semantic retrieval (768-dim, embeddinggemma-300m) with
   archive.tw search fallback; Workers AI generation with `[^n]` footnote
   citations to `archive.tw/<speech>#s<id>`; three-stage async LINE reply;
   R2 7-day answer cache + KV 1-hour source cache; two-layer rate limiting
   (edge rate limiter + per-key Durable Object); eval harness
   (`eval:cag`, `eval:cag:depth`).
4. **Routes table** — corrected: `/` 鳳問 web app, `/en`, `/privacy`,
   `/terms` (+ `/en/...` twins), `/cag/status`, `/cag/:question`,
   `POST /cag`, `/ask/:question` (debug), `POST /webhook`.
5. **Deploy & develop** — tightened version of current content, accurate:
   Node 22+, `.dev.vars`, R2 buckets + lifecycle, Vectorize create/sync, KV
   namespace, secrets, deploy, index build, refresh workflow. The LINE
   secrets walkthrough collapses into a `<details>` block.
6. **Related projects** — sayit-hono (archive.tw), transcript repo.
7. **Contributing / Security** links; **licence**.

**Accuracy fixes baked into both files:** model = Gemma 4 26B A4B via
`ASK_MODEL`; `CAG_RETRIEVER=vectorize` default with archive fallback;
complete project-structure tree; npm script table including `vectorize:*`,
`eval:*`, `r2:lifecycle*`, `tail`.

## B. Web UI `/en`

**Routes.** Add `GET /en`, `GET /en/privacy`, `GET /en/terms` in
`src/index.ts`. Existing zh-Hant routes unchanged.

**Renderers.** `renderHomePage(lang)`, `renderPrivacyPolicyPage(lang)`,
`renderTermsOfUsePage(lang)` — one HTML template per page + a per-page
strings table (`'zh-Hant' | 'en'`), so structure cannot drift between
languages.

**Client plumbing.** Server sets `<html lang="en">`; `public/app.js` reads
`document.documentElement.lang` and selects from a `STRINGS` table. No
inline script ⇒ existing `secureHeaders` CSP untouched. Strings: tagline,
consent line, placeholder, button states (送出/思考中…/N 秒… → Ask/Thinking…/N s…),
"檢索逐字稿中…" → "Searching the transcripts…", error messages, 出處 → Sources,
logo alt, sample questions. English samples are English-language questions
(e.g. "What is Plurality?", "How do you see open government?") that
naturally retrieve the archive's English transcripts. **No retrieval or
prompting changes.**

**Branding.** `h1` stays 鳳問 on both pages; English tagline beneath
("Get to know Audrey Tang's thinking, one question at a time"). OG title
≈ "鳳問 — Ask Audrey Tang".

**Metadata.** Per page: `canonical`, `og:locale` (`zh_TW`/`en_US`),
translated title/description, reciprocal `hreflang` alternates between each
zh/en pair. Existing `og-image.png` serves both languages.

**Footer.** Language toggle (華語 ⇄ English) next to privacy/terms; on
`/en` the footer links point at `/en/privacy`, `/en/terms`.

**Privacy & terms.** Faithful English translations of the current zh-Hant
text, each with a note that the Chinese version governs in case of
discrepancy.

## C. Repo polish

- **CONTRIBUTING.md** (bilingual, brief): dev setup, run
  `npm run typecheck` + `npm test` before PRs, discussion in issues.
- **SECURITY.md**: report privately via GitHub Security Advisories on
  bestian/askit-hono; no public issues for vulnerabilities.
- **Repo metadata** (prepared as a ready-to-run `gh repo edit` command;
  hand off to bestian if admin is required): description "鳳問 — ask Audrey
  Tang's 30-year transcript archive and get cited AI answers. Cloudflare
  Workers + Hono; web + LINE bot. 以 AI 檢索唐鳳逐字稿、附出處作答"; topics
  `cloudflare-workers`, `workers-ai`, `rag`, `vectorize`, `line-bot`,
  `hono`, `civic-tech`, `audrey-tang`.
- **Media**: capture ask.archive.tw (light + dark), compress, store in
  `docs/img/`. Root `logo.png` (1.2 MB): delete only if byte-identical to
  `public/logo.png`; otherwise flag.

## Testing

- **Unit (node --test, as today):** `/en`, `/en/privacy`, `/en/terms` return
  200 with `lang="en"` and English strings; zh pages change **only** by the
  added footer toggle and `hreflang` head links; each page pair carries
  reciprocal `hreflang` links.
- **Manual (`wrangler dev` + browser):** toggle both directions; one ask per
  language; stream renders; consent gate works in English.
- **CI:** unchanged (typecheck, tests, dry-run deploy) and must pass.
- `public/app.js` remains a static asset without unit tests (as today).

## Error handling

No dynamic language parameter — two fixed route sets, so no unknown-language
path exists. English no-result/error fallbacks are translated strings of the
existing behaviour.

## Out of scope

- Answer-language steering / language toggle on answers
- White-labelling or template work
- Changing LINE bot replies (its audience stays zh)
- New OG artwork
- LINE add-link/QR in README unless the bot basic ID is provided

## Open items (need Audrey or bestian)

1. LINE bot basic ID / QR for the README "add the bot" link — optional.
2. LINE conversation screenshot from a phone — optional.
3. `gh repo edit` for description/topics if push-only rights block it.

## Success criteria

- A non-Chinese developer can understand what 鳳問 is, see it working, and
  follow accurate setup docs entirely in English.
- An English-speaking visitor can complete an ask on `/en` end to end.
- README contains no stale facts (model, routes, structure, scripts).
- `npm run typecheck`, `npm test`, and CI all pass.

## Addendum (2026-06-12, during implementation)

- **No `ASK_MODEL` env var exists** — the generation model is pinned in code
  (`CAG_MODEL_GEMMA = '@cf/google/gemma-4-26b-a4b-it'` in
  `src/utils/cagEval.ts`). Docs say "pinned in code" rather than
  "via ASK_MODEL".
- **Returning-visitor language preference** (user request mid-implementation):
  reuse audreyt.org/index.html's pattern — an explicit toggle persists
  `localStorage('lang')` and a pre-paint script applies the stored choice; no
  `navigator.language` sniffing. Adapted here as `public/lang-init.js`, an
  external blocking head script (the CSP forbids inline scripts): on `/` and
  `/en` only, a stored preference for the other language triggers
  `location.replace` to the twin URL; the footer toggle (`#lang-switch`,
  `data-lang` = target language) writes the preference before navigating,
  which also rules out redirect loops. First-time visitors are never
  redirected; the legal pages never redirect.
- **Root `logo.png` kept** — it is the 1254×1254 source original, while
  `public/logo.png` is the optimised 256×256 web asset; they are not
  duplicates, so the dedupe step does not apply.
