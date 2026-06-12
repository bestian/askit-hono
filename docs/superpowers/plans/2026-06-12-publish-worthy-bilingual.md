# Publish-Worthy Bilingual Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue [#30](https://github.com/bestian/askit-hono/issues/30) — accurate English-first docs (`README.md` + `README.zh-TW.md`), an English `/en` page set for ask.archive.tw, and open-source trust signals (CONTRIBUTING, SECURITY, screenshots, metadata).

**Architecture:** Server-rendered language twins — each page renderer takes `lang: 'zh-Hant' | 'en'` and reads from a per-page strings table; `public/app.js` picks its strings from `document.documentElement.lang`. No retrieval/prompting changes; CSP and zh-Hant routes stay as they are.

**Tech Stack:** Hono on Cloudflare Workers, plain TS string templates, `node --test` (`npm test`), wrangler dev for manual verification.

**Spec:** `docs/superpowers/specs/2026-06-12-publish-worthy-bilingual-design.md`
**Spec deviation (verified in code):** there is no `ASK_MODEL` env var — the model is pinned to `@cf/google/gemma-4-26b-a4b-it` via `CAG_MODEL_GEMMA` in `src/utils/cagEval.ts:1`. Docs must state "pinned in code", not "via ASK_MODEL".

**Execution notes:**
- Work on branch `feat/publish-worthy-bilingual` in an isolated worktree (superpowers:using-git-worktrees). Run `npm ci` there first.
- `.dev.vars` is NOT needed for any task here (LINE secrets only matter for `/webhook`, untouched).
- Delegation: Tasks 1–6 are delegable to `grok -p '<task text>' --cwd <worktree> --always-approve` (one task per invocation, never `--best-of-n`); the dispatcher reviews the diff and runs the tests before committing. Tasks 7–9 are main-session only (browser tools, gh permissions, PR).
- Facts that must appear EXACTLY as written: generation model `@cf/google/gemma-4-26b-a4b-it`; embedding model `@cf/google/embeddinggemma-300m` (768-dim cosine, Vectorize index `askit-audrey-tang`); answer cache R2 7 days; source cache KV 1 hour; rate limits = edge limiter 15 req/10 s per key + per-key Durable Object cooldown; global generation budget 30/min and 1000/day; CPU cap 30 s.

---

## File structure

| File | Responsibility |
|---|---|
| `src/pages/lang.ts` (new) | `PageLang` type + `hreflangLinks()` helper shared by all three pages |
| `src/pages/home.ts` | `renderHomePage(lang)` — head/footer chrome per language; CSS/body untouched |
| `src/pages/privacy.ts` | `renderPrivacyPolicyPage(lang)` — section order + chrome per language |
| `src/pages/terms.ts` | `renderTermsOfUsePage(lang)` — same pattern as privacy |
| `public/app.js` | `STRINGS` table keyed by `document.documentElement.lang` (VM-safe) |
| `src/index.ts` | Three new routes: `/en`, `/en/privacy`, `/en/terms` |
| `test/pages.test.ts` (new) | Route/lang/hreflang tests + app.js STRINGS parity test |
| `README.md` | English showcase (full rewrite) |
| `README.zh-TW.md` (new) | 華語 twin |
| `CONTRIBUTING.md`, `SECURITY.md` (new) | Community files |
| `docs/img/` (new) | Web UI screenshots |

---

### Task 1: Language plumbing + English home page `/en`

**Delegate:** grok ✅

**Files:**
- Create: `src/pages/lang.ts`
- Modify: `src/pages/home.ts`
- Modify: `src/index.ts:677-679` (the `app.get('/')` block; add `/en` right after)
- Create: `test/pages.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/pages.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'

import app from '../src/index'

test('GET /en serves the English home page', async () => {
  const response = await app.request('/en')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="en">/)
  assert.match(html, /Ask Audrey/)
  assert.match(html, /property="og:locale" content="en_US"/)
  assert.match(html, /rel="canonical" href="https:\/\/ask\.archive\.tw\/en"/)
  assert.match(html, /hreflang="zh-Hant" href="https:\/\/ask\.archive\.tw\/"/)
  assert.match(html, /hreflang="en" href="https:\/\/ask\.archive\.tw\/en"/)
  assert.match(html, /href="\/en\/privacy"/)
  assert.match(html, /href="\/en\/terms"/)
  assert.match(html, /href="\/">華語<\/a>/)
})

test('GET / stays zh-Hant and gains only the toggle and hreflang links', async () => {
  const response = await app.request('/')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="zh-Hant">/)
  assert.match(html, /<title>鳳問 \| 認識唐鳳的思想<\/title>/)
  assert.match(html, /property="og:locale" content="zh_TW"/)
  assert.match(html, /hreflang="en" href="https:\/\/ask\.archive\.tw\/en"/)
  assert.match(html, /href="\/en">English<\/a>/)
  assert.match(html, /href="\/privacy">隱私權政策<\/a>/)
  assert.match(html, /<script src="\/app\.js" defer><\/script>/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the two new tests FAIL (`/en` → 404; `/` missing hreflang/toggle). All pre-existing tests still pass.

- [ ] **Step 3: Create `src/pages/lang.ts`**

```ts
export type PageLang = 'zh-Hant' | 'en'

const BASE_URL = 'https://ask.archive.tw'

/** Reciprocal hreflang links for a zh/en page pair. x-default points at the zh page. */
export function hreflangLinks(zhPath: string, enPath: string): string {
  return [
    `<link rel="alternate" hreflang="zh-Hant" href="${BASE_URL}${zhPath}">`,
    `<link rel="alternate" hreflang="en" href="${BASE_URL}${enPath}">`,
    `<link rel="alternate" hreflang="x-default" href="${BASE_URL}${zhPath}">`,
  ].join('\n  ')
}

export const PAGE_BASE_URL = BASE_URL
```

- [ ] **Step 4: Parameterise `src/pages/home.ts`**

Change the signature to `renderHomePage(lang: PageLang = 'zh-Hant')` and add a strings table at the top of the file. Keep the entire `<style>` block and `<main>`/script tags byte-identical — only head metadata and footer change.

```ts
import { hreflangLinks, PAGE_BASE_URL, type PageLang } from './lang'

const HOME_STRINGS = {
  'zh-Hant': {
    title: '鳳問 | 認識唐鳳的思想',
    description:
      '鳳問是一個問答機器人：提出問題，AI 會檢索唐鳳的逐字稿並附上出處作答，帶你認識唐鳳的思想。',
    ogSiteName: '鳳問',
    ogLocale: 'zh_TW',
    canonicalPath: '/',
    privacyHref: '/privacy',
    privacyLabel: '隱私權政策',
    termsHref: '/terms',
    termsLabel: '使用條款',
    langSwitchHref: '/en',
    langSwitchLabel: 'English',
  },
  en: {
    title: '鳳問 Ask Audrey — Audrey Tang’s thinking, with sources',
    description:
      'Ask a question and AI answers from Audrey Tang’s public transcript archive — every answer cited back to its original source.',
    ogSiteName: '鳳問 Ask Audrey',
    ogLocale: 'en_US',
    canonicalPath: '/en',
    privacyHref: '/en/privacy',
    privacyLabel: 'Privacy Policy',
    termsHref: '/en/terms',
    termsLabel: 'Terms of Use',
    langSwitchHref: '/',
    langSwitchLabel: '華語',
  },
} as const
```

In the template body use `const s = HOME_STRINGS[lang]` and replace:
- `<html lang="zh-Hant">` → `<html lang="${lang}">`
- `<title>`, `meta description`, all `og:*`/`twitter:*` title/description/site_name/locale → `${s.…}`
- canonical → `<link rel="canonical" href="${PAGE_BASE_URL}${s.canonicalPath}">` followed on the next line by `${hreflangLinks('/', '/en')}`
- footer →

```html
  <footer>
    <a href="${s.privacyHref}">${s.privacyLabel}</a>
    <a href="${s.termsHref}">${s.termsLabel}</a>
    <a href="${s.langSwitchHref}">${s.langSwitchLabel}</a>
  </footer>
```

`og:url` should also use `${PAGE_BASE_URL}${s.canonicalPath}`.

- [ ] **Step 5: Add the `/en` route in `src/index.ts`**

Directly below the existing `app.get('/')` handler (line ~677):

```ts
app.get('/en', (c) => {
  return c.html(renderHomePage('en'))
})
```

(The existing `/` handler needs no change — the parameter defaults to `'zh-Hant'`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test` and `npm run typecheck`
Expected: all tests PASS, including the pre-existing `/` CSP test in `test/cag.test.ts` (the page must keep `<script src="/app.js" defer>` and no inline scripts).

- [ ] **Step 7: Commit (dispatcher, after review)**

```bash
git add src/pages/lang.ts src/pages/home.ts src/index.ts test/pages.test.ts
git commit -m "Add English /en home page with per-language chrome and hreflang"
```

---

### Task 2: English twins for privacy & terms

**Delegate:** grok ✅

**Files:**
- Modify: `src/pages/privacy.ts`
- Modify: `src/pages/terms.ts`
- Modify: `src/index.ts:681-687` (add `/en/privacy`, `/en/terms` after the zh routes)
- Modify: `test/pages.test.ts` (append tests)

Both pages are ALREADY bilingual in content (zh section + en section in one page). The change is: parameterise chrome, reorder sections per language, and add a governing-language note to the English section.

- [ ] **Step 1: Write the failing tests** (append to `test/pages.test.ts`)

```ts
test('GET /en/privacy serves English-first privacy page', async () => {
  const response = await app.request('/en/privacy')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="en">/)
  assert.match(html, /rel="canonical" href="https:\/\/ask\.archive\.tw\/en\/privacy"/)
  assert.match(html, /hreflang="zh-Hant" href="https:\/\/ask\.archive\.tw\/privacy"/)
  assert.match(html, /the Chinese version governs/)
  // English section appears before the zh section
  assert.ok(html.indexOf('id="privacy-en"') < html.indexOf('id="privacy-zh"'))
})

test('GET /privacy stays zh-first with hreflang added', async () => {
  const response = await app.request('/privacy')
  const html = await response.text()
  assert.match(html, /<html lang="zh-Hant">/)
  assert.match(html, /hreflang="en" href="https:\/\/ask\.archive\.tw\/en\/privacy"/)
  assert.ok(html.indexOf('id="privacy-zh"') < html.indexOf('id="privacy-en"'))
})

test('GET /en/terms serves English-first terms page', async () => {
  const response = await app.request('/en/terms')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="en">/)
  assert.match(html, /the Chinese version governs/)
  assert.match(html, /CC BY-SA/)
  assert.ok(html.indexOf('id="terms-en"') < html.indexOf('id="terms-zh"'))
})

test('GET /terms stays zh-first', async () => {
  const response = await app.request('/terms')
  const html = await response.text()
  assert.match(html, /<html lang="zh-Hant">/)
  assert.ok(html.indexOf('id="terms-zh"') < html.indexOf('id="terms-en"'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: new tests FAIL (`/en/privacy`, `/en/terms` → 404; governing note missing).

- [ ] **Step 3: Refactor `src/pages/privacy.ts`**

Pattern (apply identically to terms.ts):

```ts
import { hreflangLinks, PAGE_BASE_URL, type PageLang } from './lang'

const PRIVACY_STRINGS = {
  'zh-Hant': {
    title: '隱私權政策 | Privacy Policy | 鳳問',
    description:
      '鳳問的隱私權政策：我們不販售或交換個人資料；正式版會收集提問內容、IP 與 userId 等必要資訊以防止濫用。',
    ogSiteName: '鳳問',
    ogLocale: 'zh_TW',
    canonicalPath: '/privacy',
    navHome: { href: '/', label: '首頁 Home' },
    navOther: { href: '/terms', label: '使用條款 Terms of Use' },
    navLang: { href: '/en/privacy', label: 'English' },
  },
  en: {
    title: 'Privacy Policy | 隱私權政策 | 鳳問 Ask Audrey',
    description:
      'Ask Audrey’s privacy policy: we do not sell or exchange personal data; the production service keeps questions, IPs and user IDs only to prevent abuse.',
    ogSiteName: '鳳問 Ask Audrey',
    ogLocale: 'en_US',
    canonicalPath: '/en/privacy',
    navHome: { href: '/en', label: 'Home' },
    navOther: { href: '/en/terms', label: 'Terms of Use' },
    navLang: { href: '/privacy', label: '華語' },
  },
} as const
```

Extract the two existing `<section>` blocks into constants — move the inner HTML **verbatim** (zh: current lines 90-98; en: current lines 100-108), with two adjustments to the EN section: keep `aria-labelledby="privacy-en"`/`id="privacy-en"` as-is, and append before `</section>`:

```html
      <p><em>This English version is provided for convenience; if it and the Chinese version differ, the Chinese version governs.</em></p>
```

In the EN section, also change the internal link `href="/privacy"` (in terms.ts EN section: the Privacy Policy link) to its `/en/...` twin when rendering `lang === 'en'` — simplest: keep two section constants per language pair and parameterise that one href, e.g. `EN_SECTION(privacyHref: string)` as a small function.

Render:

```ts
export function renderPrivacyPolicyPage(lang: PageLang = 'zh-Hant'): string {
  const s = PRIVACY_STRINGS[lang]
  const first = lang === 'en' ? EN_SECTION : ZH_SECTION
  const second = lang === 'en' ? ZH_SECTION : EN_SECTION
  // the second section carries class="lang" (its top border separates the two)
  ...
}
```

Head chrome: same replacements as Task 1 (html lang, title, description, og/twitter, canonical + `${hreflangLinks('/privacy', '/en/privacy')}`). Nav:

```html
    <nav aria-label="Legal pages">
      <a href="${s.navHome.href}">${s.navHome.label}</a>
      <a href="${s.navOther.href}">${s.navOther.label}</a>
      <a href="${s.navLang.href}">${s.navLang.label}</a>
    </nav>
```

- [ ] **Step 4: Refactor `src/pages/terms.ts` the same way**

TERMS_STRINGS en title: `Terms of Use | 使用條款 | 鳳問 Ask Audrey`; en description: `Ask Audrey’s terms: by using the service you agree to these terms and to the collection of questions, IPs and user IDs needed to prevent abuse.`; canonical `/en/terms`; nav twin = Privacy Policy. Sections: zh lines 90-99, en lines 102-111 moved verbatim + governing note. The EN section's `<a href="/privacy">` becomes `/en/privacy` in the en rendering (parameterised as above).

- [ ] **Step 5: Add routes in `src/index.ts`**

```ts
app.get('/en/privacy', (c) => {
  return c.html(renderPrivacyPolicyPage('en'))
})

app.get('/en/terms', (c) => {
  return c.html(renderTermsOfUsePage('en'))
})
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit (dispatcher, after review)**

```bash
git add src/pages/privacy.ts src/pages/terms.ts src/index.ts test/pages.test.ts
git commit -m "Serve English-first /en/privacy and /en/terms twins with governing-language note"
```

---

### Task 3: `app.js` STRINGS table

**Delegate:** grok ✅

**Files:**
- Modify: `public/app.js`
- Modify: `test/pages.test.ts` (append parity test with its own VM harness)

**Constraint:** the existing VM test harness (`test/cag.test.ts:38-65`) runs `app.js` with NO `document` in context — language detection must not throw there.

- [ ] **Step 1: Write the failing test** (append to `test/pages.test.ts`)

```ts
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

type PageStrings = Record<string, Record<string, unknown>>

async function loadAppStrings(): Promise<PageStrings> {
  const appJs = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  const context = {
    URL,
    NodeFilter: { SHOW_ELEMENT: 1 },
    DOMParser: class {
      parseFromString(html: string) {
        return {
          body: { innerHTML: html, querySelectorAll: () => [] },
          createTreeWalker: () => ({ nextNode: () => null }),
        }
      }
    },
    Vue: {
      createApp: () => ({ mount: () => {} }),
      ref: (value: unknown) => ({ value }),
      computed: (fn: () => unknown) => ({ get value() { return fn() } }),
      h: () => ({}),
    },
    __ASKIT_ENABLE_TEST_HOOKS__: true,
  }
  runInNewContext(appJs, context)
  return (context as typeof context & { __ASKIT_TESTS__: { STRINGS: PageStrings } }).__ASKIT_TESTS__.STRINGS
}

test('app.js zh-Hant and en string tables stay in parity', async () => {
  const strings = await loadAppStrings()
  const zh = strings['zh-Hant']
  const en = strings.en
  assert.ok(zh && en, 'STRINGS must expose zh-Hant and en')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.equal((zh.samples as string[]).length, (en.samples as string[]).length)
  assert.match(String(en.submit), /^Ask$/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `STRINGS` is undefined in test hooks.

- [ ] **Step 3: Add STRINGS to `public/app.js`**

Insert right after the `const COOLDOWN_SECONDS = 3` line:

```js
  const DOC_LANG = (typeof document !== 'undefined' && document.documentElement)
    ? document.documentElement.lang
    : ''
  const LANG = DOC_LANG === 'en' ? 'en' : 'zh-Hant'
  const STRINGS = {
    'zh-Hant': {
      logoAlt: '鳳問 logo',
      heading: '鳳問',
      tagline: '透過問答機器人，認識唐鳳的思想',
      consentPrefix: '我已閱讀並同意 ',
      consentJoin: ' 和 ',
      privacyHref: '/privacy',
      privacyLabel: '隱私權政策',
      termsHref: '/terms',
      termsLabel: '使用條款',
      placeholderReady: '輸入你的問題，例如：什麼是仁工智慧？',
      placeholderConsent: '請先同意隱私權政策和使用條款，才能發問',
      questionAria: '問題',
      submit: '送出',
      thinking: '思考中…',
      cooldownSuffix: ' 秒…',
      searching: '檢索逐字稿中…',
      fetchError: '查詢發生錯誤，請稍後再試。',
      networkError: '連線發生錯誤，請稍後再試。',
      sourcesHeading: '出處',
      samples: [
        '什麼是仁工智慧？',
        '什麼是數位民主？',
        '如何看待開放政府？',
        '唐鳳對 AI 的看法？',
      ],
    },
    en: {
      logoAlt: 'Ask Audrey logo',
      heading: '鳳問',
      tagline: 'Get to know Audrey Tang’s thinking, one question at a time',
      consentPrefix: 'I have read and agree to the ',
      consentJoin: ' and the ',
      privacyHref: '/en/privacy',
      privacyLabel: 'Privacy Policy',
      termsHref: '/en/terms',
      termsLabel: 'Terms of Use',
      placeholderReady: 'Type your question, e.g. “What is Plurality?”',
      placeholderConsent: 'Please agree to the Privacy Policy and Terms of Use first',
      questionAria: 'Question',
      submit: 'Ask',
      thinking: 'Thinking…',
      cooldownSuffix: ' s…',
      searching: 'Searching the transcripts…',
      fetchError: 'Something went wrong. Please try again later.',
      networkError: 'Connection error. Please try again later.',
      sourcesHeading: 'Sources',
      samples: [
        'What is Plurality?',
        'How do you see open government?',
        'Will AI control us?',
        'What is digital democracy?',
      ],
    },
  }
  const T = STRINGS[LANG]
```

- [ ] **Step 4: Replace every zh literal in the render/setup code with `T.*`**

Exact replacements (current line numbers in parentheses):
- `samples` array (135-139) → `const samples = T.samples`
- error literals (163, 175) → `T.fetchError` / `T.networkError`
- logo alt (184) → `T.logoAlt`; `h('h1', '鳳問')` (185) → `h('h1', T.heading)`; tagline (186) → `T.tagline`
- consent span (197-202) → `T.consentPrefix`, privacy link `{ href: T.privacyHref, … }, T.privacyLabel`, `T.consentJoin`, terms link `{ href: T.termsHref, … }, T.termsLabel`
- placeholder ternary (215-217) → `T.placeholderReady` / `T.placeholderConsent`
- `'aria-label': '問題'` (219) → `T.questionAria`
- button label (228) → `loading.value ? T.thinking : (cooldown.value > 0 ? cooldown.value + T.cooldownSuffix : T.submit)`
- searching placeholder (243) → `T.searching`
- sources heading (250) → `T.sourcesHeading`

- [ ] **Step 5: Expose STRINGS in the test hooks**

Change line 107:

```js
    globalThis.__ASKIT_TESTS__ = { parseAnswer, isSafeHttpUrl, sanitizeHtml, STRINGS }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, including all pre-existing `app.js` VM tests in `test/cag.test.ts` (no `document` in that harness — `LANG` falls back to `'zh-Hant'`).

- [ ] **Step 7: Commit (dispatcher, after review)**

```bash
git add public/app.js test/pages.test.ts
git commit -m "Localise app.js via STRINGS table keyed off document language"
```

---

### Task 4: Rewrite `README.md` (English showcase)

**Delegate:** grok ✅ (content skeleton below is binding; prose may be polished but every fact must match)

**Files:**
- Replace: `README.md`

- [ ] **Step 1: Write the new `README.md`**

Binding skeleton — headings, tables, and facts must appear as specified; connective prose may be adjusted for flow:

````markdown
# 鳳問 Ask Audrey

[![CI](https://github.com/bestian/askit-hono/actions/workflows/ci.yml/badge.svg)](https://github.com/bestian/askit-hono/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English | [華語](README.zh-TW.md)**

Ask Audrey Tang anything — AI answers grounded in her 30-year public transcript
archive ([archive.tw](https://archive.tw)), with every answer cited back to its
original source.

**Try it → <https://ask.archive.tw/en>** (華語: <https://ask.archive.tw>) ·
Also available as a LINE bot.

<screenshot block — added in Task 7; img refs docs/img/home-en.png / docs/img/home-zh.png>

## How it works

![CAG system design](design/CAG-system-design.svg)

- **Retrieval** — questions are embedded with `@cf/google/embeddinggemma-300m`
  (768-dim) and matched against the Vectorize index `askit-audrey-tang`
  (cosine); hits are hydrated through the archive.tw section API for
  surrounding context. If Vectorize is unavailable or empty, retrieval falls
  back to archive.tw full-text search.
- **Generation** — Cloudflare Workers AI runs `@cf/google/gemma-4-26b-a4b-it`
  (pinned in `src/utils/cagEval.ts`); `[1]`-style markers are rewritten to
  `[^1]` footnotes linking to `archive.tw/<speech>#s<section_id>`.
- **LINE bot** — webhooks must ack within 2 s, so replies are three-stage:
  immediate `200 OK` (work moves to `waitUntil`), a typing indicator via
  `chat/loading/start`, then a single Reply API call with a Flex Message
  (answer + up to two source cards). Falls back to the top-2 fuzzy-search
  sections if CAG fails.
- **Caching** — identical questions are served from a 7-day R2 answer cache
  (`X-Cache: HIT`); retrieval sources are cached in KV for 1 hour.
- **Abuse protection** — two-layer rate limiting (edge limiter 15 req/10 s
  per key, then a per-key Durable Object cooldown), a global generation
  budget (30/min, 1000/day), 30 s CPU cap, strict CSP and security headers.
- **Quality** — an offline eval harness (`npm run eval:cag`,
  `npm run eval:cag:depth`) scores answer depth and grounding before model
  or retrieval changes ship.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | 鳳問 web app (華語) |
| `GET /en` | Ask Audrey web app (English) |
| `GET /privacy` · `GET /terms` | Legal pages, 華語-first (`/en/privacy` · `/en/terms` are English-first twins) |
| `GET /cag/status` | Current retriever, archive base URL, model and top-k caps |
| `GET /cag/:question` | Streaming Markdown answer with footnote citations |
| `POST /cag` | JSON `{ "question": "...", "topK": 6 }`; same streaming output |
| `GET /ask/:question` | Debug: closest single transcript section via the R2 Fuse index |
| `POST /webhook` | LINE Messaging API webhook (three-stage async reply) |

## Deploy your own

<condensed version of the existing English setup docs, in this order:
prerequisites (Node 22+, `npx wrangler login`); create R2 buckets
(`askit-fuse-index-cache(-preview)`, `askit-answer-cache(-preview)` +
`npm run r2:lifecycle`); create Vectorize index (`npm run vectorize:create`,
backfill with `npm run vectorize:sync`); create KV namespace `CAG_CACHE`;
build + upload the Fuse index (`npm run build:index`, env-var table from the
old README verbatim BUT delete the `ASK_MODEL` row); LINE channel secrets in a
<details><summary>LINE webhook setup</summary> block (the two
`wrangler secret put` commands, Developers Console walkthrough, signature
verification explanation, curl test — reuse existing English text);
`npm run deploy`; the refresh-cag-index workflow paragraph + YAML snippet
from the old README.>

## Local development

<reuse existing English text: `cp .dev.vars.example .dev.vars`, `npm run dev`
/ `npm run preview`, the remote-bindings note, the preview-bucket seeding
commands, plus curl examples for `/ask` and `/cag` (keep existing URLs).>

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `npm run preview` | Local Worker (remote R2/AI bindings) / fully remote |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm test` / `npm run typecheck` | Node test suite / TypeScript check |
| `npm run build:index` | Build the Fuse index from D1 and upload to R2 |
| `npm run vectorize:create` / `vectorize:sync` | Create / backfill the Vectorize index |
| `npm run eval:cag` / `eval:cag:depth` | Model / retrieval-depth eval harnesses |
| `npm run r2:lifecycle` | Apply the 7-day lifecycle to the answer-cache buckets |
| `npm run tail` | Live-tail Worker logs |

## Project structure

```
.
├── src/
│   ├── index.ts                   # Hono app: routes, webhook, rate limiting
│   ├── pages/                     # Server-rendered pages (home/privacy/terms, zh + en)
│   └── utils/
│       ├── cag.ts                 # CAG retrieval + generation + citations
│       ├── vectorize.ts           # Embeddings + Vectorize query
│       ├── cagCache.ts            # KV source cache (1 h)
│       ├── cache.ts               # R2 answer cache (7 days)
│       ├── cagEval.ts             # Eval scoring (incl. pinned model id)
│       ├── search.ts              # R2 Fuse index loader + fuzzy search
│       └── askIndexFormat.ts      # Shared index types/options
├── public/                        # Static assets + Vue front-end (app.js)
├── scripts/                       # build-ask-index / vectorize-sync / evals
├── test/                          # node --test suites
├── design/                        # Architecture notes + system diagram
├── config/                        # R2 lifecycle rules
└── wrangler.jsonc                 # Workers config (R2, KV, Vectorize, AI, DO)
```

## Related projects

- [sayit-hono](https://github.com/bestian/sayit-hono) — the archive.tw backend this bot retrieves from
- [transcript](https://github.com/audreyt/transcript) — the source transcripts

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © bestian
````

- [ ] **Step 2: Verify**

Run: `grep -c "Kimi\|Hello World" README.md` → expected `0`; `grep -c "gemma-4-26b-a4b-it" README.md` → expected ≥1. Check every relative link target exists (`design/CAG-system-design.svg`, `LICENSE`; CONTRIBUTING/SECURITY arrive in Task 6, docs/img in Task 7 — acceptable within the branch).

- [ ] **Step 3: Commit (dispatcher, after review)**

```bash
git add README.md
git commit -m "Rewrite README.md as accurate English-first showcase"
```

---

### Task 5: Write `README.zh-TW.md` (華語 twin)

**Delegate:** grok ✅

**Files:**
- Create: `README.zh-TW.md`

- [ ] **Step 1: Write the file**

Same heading structure as the new `README.md`, section for section. Open with `**[English](README.md) | 華語**`. Reuse the old README's 華語 prose wherever it is still accurate (it is well written) — but apply every correction from Task 4: 預設模型是 `@cf/google/gemma-4-26b-a4b-it`（寫死在 `src/utils/cagEval.ts`，無 `ASK_MODEL` 環境變數）；`GET /` 是鳳問網頁版（不再是 Hello World）；新增 `/en` 路由列；專案結構含 `pages/`、`vectorize.ts`、`cagCache.ts`、`cagEval.ts`、`public/`、`design/`、`config/`；補 KV 來源快取（1 小時）、Vectorize 檢索、雙層限流、全域生成預算、eval harness；scripts 表格與英文版一致。Hero 文案：「向唐鳳問任何問題——AI 從她三十年的公開逐字稿（archive.tw）檢索作答，每句都附出處。」「**立即試用 → <https://ask.archive.tw>**」.

- [ ] **Step 2: Verify**

Run: `grep -c "Kimi\|Hello World" README.zh-TW.md` → `0`. Headings count matches README.md (`grep -c '^## ' README.md README.zh-TW.md` → equal numbers).

- [ ] **Step 3: Commit (dispatcher, after review)**

```bash
git add README.zh-TW.md
git commit -m "Add 華語 README twin mirroring the English structure"
```

---

### Task 6: CONTRIBUTING.md + SECURITY.md

**Delegate:** grok ✅ (content below is final — copy verbatim)

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`

- [ ] **Step 1: Create `CONTRIBUTING.md`**

```markdown
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
```

- [ ] **Step 2: Create `SECURITY.md`**

```markdown
# Security Policy | 資安政策

**English** — If you find a vulnerability in this service (the Worker, the
LINE webhook, caching, or rate limiting), please report it privately via
[GitHub Security Advisories](https://github.com/bestian/askit-hono/security/advisories/new).
Do **not** open a public issue for security problems. We aim to acknowledge
reports within a week. The service stores user questions and anti-abuse
records (IPs, user IDs), so confidentiality matters.

**華語** — 若您發現本服務（Worker、LINE webhook、快取或限流機制）的安全性
弱點，請透過
[GitHub Security Advisories](https://github.com/bestian/askit-hono/security/advisories/new)
私下回報，**請勿**開公開 issue。我們會盡力在一週內回覆。本服務保存使用者
提問與防濫用紀錄（IP、userId），請協助保密。
```

- [ ] **Step 3: Verify & commit (dispatcher, after review)**

Run: `npm test` (unchanged, must still pass).

```bash
git add CONTRIBUTING.md SECURITY.md
git commit -m "Add CONTRIBUTING and SECURITY community files"
```

---

### Task 7: Screenshots, logo dedupe, embed media

**Delegate:** main session ONLY (browser tools + image processing)

**Files:**
- Create: `docs/img/home-en.png`, `docs/img/home-zh.png`
- Modify: `README.md`, `README.zh-TW.md` (replace the screenshot block)
- Possibly delete: `logo.png` (root)

- [ ] **Step 1: Logo dedupe**

Run: `cmp logo.png public/logo.png && echo IDENTICAL || echo DIFFERENT`
If IDENTICAL: `git rm logo.png` (README hero does not reference it; the web app serves `public/logo.png`). If DIFFERENT: keep both and note in the PR body.

- [ ] **Step 2: Capture screenshots**

Start `npm run dev` (background). Using the Chrome automation tools: open `http://127.0.0.1:8787/en`, tick consent, run the sample "What is Plurality?", wait for the streamed answer + sources, screenshot → `docs/img/home-en.png`. Repeat on `http://127.0.0.1:8787/` with a zh sample → `docs/img/home-zh.png`. Kill the dev server.

- [ ] **Step 3: Compress**

```bash
sips -Z 1280 docs/img/home-en.png docs/img/home-zh.png
```
Target ≤ 300 KB each (`du -h docs/img/*.png`); if still larger, `sips -s formatOptions 80 -s format jpeg` and adjust references.

- [ ] **Step 4: Embed in both READMEs**

Replace the screenshot placeholder block with:

```markdown
| English (`/en`) | 華語 (`/`) |
| --- | --- |
| ![Ask Audrey English UI](docs/img/home-en.png) | ![鳳問華語介面](docs/img/home-zh.png) |
```

- [ ] **Step 5: Commit**

```bash
git add -A docs/img README.md README.zh-TW.md logo.png
git commit -m "Add UI screenshots and dedupe root logo"
```

---

### Task 8: Repo metadata

**Delegate:** main session ONLY (needs gh permissions)

- [ ] **Step 1: Attempt `gh repo edit`**

```bash
gh repo edit bestian/askit-hono \
  --description "鳳問 Ask Audrey — cited AI answers from Audrey Tang's 30-year transcript archive (archive.tw). Cloudflare Workers + Hono; web + LINE bot. 以 AI 檢索唐鳳逐字稿、附出處作答" \
  --add-topic cloudflare-workers --add-topic workers-ai --add-topic rag \
  --add-topic vectorize --add-topic line-bot --add-topic civic-tech \
  --add-topic audrey-tang
```

(`hono` is already set; topics must be lowercase/hyphenated.)

- [ ] **Step 2: If it fails with 403/permission error**

Post the exact command above as a comment on issue #30, addressed to @bestian, asking him to run it (or set the equivalent in repo Settings → About).

---

### Task 9: Final verification + PR

**Delegate:** main session ONLY

- [ ] **Step 1: Full local verification**

Run: `npm run typecheck && npm test`
Expected: all pass, zero skips.

- [ ] **Step 2: Manual `/en` walkthrough** (superpowers:verification-before-completion)

`npm run dev`; in the browser: `/` ⇄ `/en` toggle both directions, consent gate text per language, one streamed ask per language with sources rendering, `/en/privacy` + `/en/terms` EN-first with governing note. Confirm `X-Cache: HIT` on an immediate repeat of the same question (response header).

- [ ] **Step 3: Push branch + PR**

```bash
git push -u origin feat/publish-worthy-bilingual
gh pr create -R bestian/askit-hono \
  --title "Publish-worthy showcase: bilingual docs + English /en web UI" \
  --body "Closes #30. <summary of changes, screenshots inline, note open items: LINE QR optional, repo metadata status>"
```

Expected: CI green on the PR.

---

## Self-review checklist (done at plan time)

- Spec coverage: A (Tasks 4-5), B (Tasks 1-3), C (Tasks 6-8), testing (Tasks 1-3, 9), out-of-scope respected (no retrieval changes anywhere).
- No placeholders: every code step shows code; README skeleton binding with facts pinned; `<...>` blocks in Task 4 reference existing English README text to reuse, by name.
- Type consistency: `PageLang` defined once in `src/pages/lang.ts`, imported everywhere; `renderHomePage(lang?)` default keeps existing call sites valid.
- Spec deviation documented: no `ASK_MODEL` env var exists; docs say "pinned in code".
