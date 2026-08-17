# Autoresearch audit (prototype lock)

Local-only. Goal: **preregister** a comparison, **audit** the result bundle against mechanically detectable failure classes, then emit a verdict of `finding` / `conditional` / `no-finding`. The harness exists because one session on this repo produced eight confident wrong or unsupported conclusions, each caught only by manual suspicion.

Product source: the 2026-08-16/17 local claim-index vs section-retrieval investigation (`design/cag-memories.md` §7). A transcript of that work is a **receipt**, not a licence to generalise. Missing numbers → demote to no-finding. Do not invent a winner.

---

## 1. Why

An automated research loop's dominant failure mode is not bad execution. It is **confident conclusions from unvalidated instruments**. Every class below happened in one session comparing a local claim index (`src/utils/cagMemories.ts`) against production-style ≤175-char section retrieval over Audrey Tang's public transcripts, and every one is mechanically detectable.

1. **Stale artifact** — `scripts/compare-memories-vs-local-sections.ts` was left with duplicate `cell` and `printArmMeans` declarations, so the file would not parse. Its log predated the breakage (existed, 386KB), so reported numbers looked clean while the code could not run. Gate `staleness`.
2. **Degenerate score cluster** — exactly 3 of 21 questions sat at memory precision **0.000** (`au-digital-democracy-reframe-zh`, `au-join-zh`, `au-open-government-zh`) while the rest were healthy. Two scorer bugs: `CIVIC_GENERIC_BIGRAMS` made both topic bigrams of 數位民主 generic, so the phrase was unscoreable; `Join.gov.tw` decomposed to `join`/`gov`/`tw` and `tw` matches `archive.tw` corpus-wide. After the fix those three went 0.000 → 0.875 / 1.000 / 1.000 (control 開放原始碼 stayed 1.000) and the arm mean moved 0.750 → 0.940, reversing the reported winner. A zero cluster beside healthy scores is scorer failure, not absent material. Gate `degeneracy`.
3. **Invalid instrument** — a held-out set drew ground-truth terms as fixed-width 4–5 character slices of Han runs (`而且我們的`, `是在現有`, `因為我看`, `我分享一下`, `這個題目`, `常重要的價`). **45 of 147 terms (30.6%) are ≥50% function characters**, mean length **4.76**. Both arms scored ≈0; a worker reported `collapse`. On `heldout-03` section retrieval returned the exact question turn as hit #1 and still scored precision 0.000 because the target token was `常重要的價`. Gate `instrument`.
4. **Universal claim from n=1** — "transcript basename == archive.tw section-API filename" was verified on **one** fixture room and generalised. It holds for **49 of 105**. The real rule is lowercase-Latin-only (+34) then *delete* CJK punctuation (+15); 7 rooms remain unresolvable. Citability moved **43.4% → 89.5%** (11,666 of 13,032 memories). Gate `sample`.
5. **Metric/objective circularity** — retrieval precision was "returned item contains a ground-truth topic term" (lexical) while memory ranks by keyword+IDF+phrase (lexical) and sections by embedding cosine (vector). The metric was made of one arm's objective and orthogonal to the other. Under it, memory led **0.940 vs 0.810**. Blind answer-level judging reversed it: sections beat memory **24–6** with 12 ties; better on **12 of 21** questions versus memory's 3. Order consistency 83/83 = 1.000; inter-judge 19/20 = 0.950. Gate `circularity`.
6. **Blindness leak** — pairwise judges shared a Python kernel with the orchestrator; one judge read another agent's variables mid-run. Audit: `eval-contexts.json` contains only opaque `armToken` values; literal counts of `"arm"`, `sections-only`, `memory-keyword`, `union-rrf` are all **0** there, because every label lives in `eval-contexts.json.key.json`. The result survived by luck, not design. Gate `blinding`.
7. **Unsupported verdict** — a worker returned the single word `collapse` with no scores and no log path. Re-running produced the numbers, which showed the verdict was class 3, not a result. Gate `verdict-support`.
8. **Non-distinct arms** — `memory-keyword` (`recall`) and `memory-hybrid` (`recallHybrid`) were treated as separate configurations. On the 21 judged questions they returned identical item ids in identical order on **21 of 21** — mean top-8 Jaccard **1.000**, identical budget-packed set 21/21, mean items 3.86 both. Hybrid only diverges when keyword is empty, and keyword was empty on **0/21** of that set. Every "hybrid" conclusion from that set was about keyword. Hybrid's real difference is on natural interviewer questions: empty-return **26/40 = 65.0%** (keyword) vs **9/40 = 22.5%** (hybrid). Gate `arm-distinctness`.

---

## 2. Model

```
Prereg → run → ResultBundle → audit → verdictOf
```

`Prereg` locks the question, arms (`rankingFeatures`), metric (`features`, `higherIsBetter`), unit ids, acceptance rule, and named confounds *before* scores exist. Optional: a `cheapProbe` (description + `costRatio` vs the expensive path) and a `blinding` vocabulary with judge-visible paths.

`ResultBundle` is the receipt: `preregId`, per-unit `scores`, `logPaths`, `inputScriptPaths`, `producedBy` / optional `reproducedBy`, optional free-text `verdict`.

`audit` runs every applicable gate and concatenates any extra findings (filesystem, instrument, sample claim, refuted-hypothesis check). `verdictOf`:

| report | verdict |
|---|---|
| any blocker | `no-finding` |
| else any warning | `conditional` |
| else | `finding` |

**A result is not a finding until its audit is clean or every warning is explicitly acknowledged with a reason.**

This is deliberate symmetry with the CAG work. The property the claim index was actually credited for — after the density thesis was refuted and the lexical-precision headline inverted — is **abstention**: keyword returns nothing on 15/15 out-of-archive questions while section-cosine returns a mean of 6 passages (Higgs-boson mass → six Audrey Tang chunks). The harness does the same thing at the meta level: it abstains rather than emitting a weak finding. `scripts/autoresearch-audit.ts` exits **1** when any blocker is present so that rule is enforceable, not advisory.

---

## 3. Gates

| gate | severity | trigger | defends against |
|---|---|---|---|
| `circularity` | blocker / warning | metric families ⊆ arm A and ∩ arm B = ∅ (blocker); metric overlaps some but not all arms (warning). `rank-fusion` inherits every other arm's families, so union can never be the orthogonal B. | Class 5: lexical precision vs keyword+IDF memory vs cosine sections; 0.940 vs 0.810 flipped to 24–6 under `llm-judgement`. |
| `degeneracy` | warning | share of exact-0 scores ≥ 0.10 and mean of the rest > 0.5; or ≥0.80 of values equal a supplied saturation value. | Class 2: 3/21 at 0.000, mean 0.750 → 0.940 after the two scorer bugs. |
| `sample` | blocker | `observed < 5` or `observed/population < 0.05`. | Class 4: equality claim at observed=1, population=105 (49/105 would pass). |
| `reproduction` | warning | `reproducedBy` missing, empty, or equal to `producedBy`. | Single-writer "collapse"; the 6-room vs 105-room embedding isolate (0.690 vs 0.810 both times) is what a second producer looks like. |
| `verdict-support` | blocker | non-empty `verdict` with empty `scores`, or non-empty `verdict` with empty `logPaths`. | Class 7: `collapse` with neither. |
| `cheap-probe` | warning / note | no `cheapProbe` → note; `costRatio > 0.1` → warning. | §6: 30s quote-overlap vs 16 min / 126 judgements. |
| `arm-distinctness` | blocker / warning / note | set-identical share ≥ 0.90 (blocker), ≥ 0.60 (warning); <3 shared units → note. Order-identical share is reported separately. | Class 8: keyword vs hybrid 21/21 identical, Jaccard 1.000. |
| `refuted` | warning | hypothesis substring-matches a `KNOWN_REFUTED` statement. | Re-deriving a killed claim (see §5). |
| `instrument` | blocker / warning | function-char share of terms ≥0.5 exceeds 0.15, or length histogram is a fixed-width spike; short terms (<3) warn. | Class 3: 45/147, mean 4.76, `常重要的價`. |
| `provenance` | blocker | a declared log path is missing. | Class 1's cousin: a verdict that names a log that is not there. |
| `staleness` | blocker | any log `mtime` strictly older than any input script. Missing files are skipped (provenance owns them). | Class 1: 386KB log older than a now-unparseable harness. |
| `blinding` | blocker / warning | a judge-visible file contains a vocabulary term (blocker); missing file (warning). | Class 6: `eval-contexts.json` is clean; `.key.json` blocks on `"arm"`. |

`audit()` on `(Prereg, ResultBundle)` runs circularity, degeneracy, reproduction, verdict-support, cheap-probe, and — when retrievals are supplied — arm-distinctness. Filesystem, instrument, sample, and refuted checks are extra findings the CLI concatenates.

---

## 4. Instrument validation

Ground truth is an instrument. If it is broken, every arm scores ~0 and the comparison is void — which is exactly what happened, and exactly what a worker then labelled `collapse`.

Chinese has no space delimiters. A word segmenter (or noun-phrase extractor) produces a **varied** length distribution. Fixed-width n-gram windowing produces a **spike at one or two lengths**. `looksFixedWidthSliced` is that spike: if the ≤2 most common lengths cover ≥0.80 of terms and the shortest observed length is ≥3, the ground-truth builder is a slicer, not a segmenter.

Independently, function-character share catches the semantic failure of the same builder. On `local/cag-compare/heldout-questions.json`: **147** terms, **45** with `functionCharShare ≥ 0.5` (30.6%), mean length **4.76**. Examples are not topics: `而且我們的`, `因為我看`, `我分享一下`. A hand-written control (`開放原始碼`, `vTaiwan`, `口罩地圖`, `數位簽章`, `仁工智慧`, `審議`, `地神`, `多元宇宙`) must produce no blocker — if it does, the thresholds are wrong, not the artifact.

Do not trust a verdict whose ground truth has not passed this gate. The held-out *empty-return* rates (26/40 keyword, 9/40 hybrid, 0/40 sections) remain valid because they need no terms; the precision numbers do not.

---

## 5. Negative-result registry

`KNOWN_REFUTED` is seeded with four hypotheses this session killed. A warning fires on a case-insensitive substring match against a new `Prereg.question` (or an explicit hypothesis string).

| id | statement | evidence | date |
|---|---|---|---|
| `cosine-cannot-gate` | a scalar cosine threshold can separate should-match from should-not-match in the claim-embedding space | 21×96 pair sample: should-match median 0.466 / p90 0.634 / max 0.683 vs should-NOT-match median 0.335 / p90 0.429 / max 0.618; overlap 0.264–0.618. Floor 0.62 clears the false-positive ceiling and disables the fallback. | 2026-08-16 |
| `punct-to-hyphen-fold` | archive.tw slugs fold CJK punctuation to hyphens | recovered **0 of 56** rooms; *deleting* the punctuation recovered 15 | 2026-08-17 |
| `absent-ngram-implies-absent-topic` | absence of a query n-gram from the corpus indicates the topic is absent | held-out in-corpus questions had **longer** absent n-grams (mean **5.33**) than genuinely out-of-archive ones (**4.11**); the rule would abstain on **85%** of answerable questions | 2026-08-17 |
| `claim-embeddings-beat-chunks` | embedding a distilled claim retrieves better than embedding a raw chunk | memory-cosine **0.690** vs section-cosine **0.810**, reproduced at 6 rooms and at 105 rooms | 2026-08-17 |

A registry matters because two of these were **re-derived from scratch in the same session that refuted them**. `punct-to-hyphen-fold` was the first guessed join rule after the n=1 generalisation failed; it recovered zero rooms, and only then was deletion measured. `absent-ngram-implies-absent-topic` was written down as a cheap abstention rule and falsified the same afternoon. Without a registry the next loop would invent both again, spend the same measurements, and report them as new insight.

---

## 6. Cheap falsification first

Order work by **cost against decisiveness**. `Prereg.cheapProbe.costRatio` is the cheap path's cost divided by the expensive path's; >0.1 warns that the expensive path ran without a cheap one in front of it.

Worked example, same session. A ~30-second measurement over the 13,032-memory store showed **99.2%** of evidence quotes (12,927 of 13,032) are a literal substring of their own memory content, and that quotes are **46.3%** of assembled retrieval characters. Mean item **269.9** chars against **143.0** for content alone, so items per 1500-char budget go **5.56 → 10.49** versus sections' **15.34**. That is the density deficit, measured, before any judge is hired.

The answer-level eval that later inverted the lexical headline took **16 minutes** and **126** blind pairwise judgements (3 pairings × 21 questions × 2 orders). It was the right instrument for circularity. It was the wrong *first* instrument for density. The quote-overlap probe should have been run first; it is more decisive about why a distilled claim loses at a fixed character budget, and it costs a thirtieth of the judge pass.

---

## 6b. Calibration, and the gates' own false positives

A gate that cries wolf gets ignored, which returns you to unverified claims by a longer road. Both defects below were found by pointing the harness at *known-good* input, and both were fixed the same day it was written.

**`fixed-width-sliced` rejected correctly segmented ground truth.** The original rule flagged any spike at ≤2 lengths. But genuine Traditional-Chinese words concentrate short: measured over `Intl.Segmenter` zh-TW output on the same passages, **81.2%** of content words are length 2 and 9.5% length 3 — a sharper spike than the broken artifact's. The discriminator is not "spike versus no spike", it is **where the spike sits**. `FIXED_WIDTH_MIN_SUSPICIOUS_LENGTH = 4` now gates it: the broken artifact spikes at lengths 4+5 covering 90.8%, a segmenter spikes at 2 covering 91.3%. Both directions are verified.

**`function-char-share` was calibrated too tight.** Two real lexicons over identical passages: the fixed-width artifact measures **40.8%** function-heavy terms, a DF-curated `Intl.Segmenter` lexicon measures **16.0%**. The original 0.15 threshold rejected the good one. Now **0.25**, which separates both with margin. This is a **two-point calibration** and should be widened rather than satisfied by curating a lexicon down to meet it.

**`degeneracy` reports a real outcome as a broken scorer** whenever 0 is a legitimate value. On a blind pairwise win-rate metric, an arm that loses every pairing on a question genuinely scores 0.0 — and the harness flagged three such questions as suspicious. This one is not fixed by a threshold; it is fixed by making the prereg declare the metric's semantics. `MetricSpec.zeroIsMeaningful` suppresses the gate, and the burden sits with the author to declare it rather than with the gate to guess.

**Known remaining limitation.** `staleness` compares mtimes, so it cannot distinguish an edit that changed behaviour from one that added an unrelated flag. It blocked a valid earlier result because a script later gained a `--quote-mode` flag. That is the correct default — the artifact genuinely is no longer verifiable against current code — but the resolution is to re-run or to carry a replication control, not to relax the gate.

**Second known limitation, found the same way.** `staleness` checks every entry in `ResultBundle.logPaths`, but that field conflates two different things: **outputs produced by the run** and **input data consumed by it**. An input question set legitimately predates the code that reads it, so listing `natural-questions.json` under `logPaths` produced a blocker that was pure noise. The rule is now explicit: `logPaths` holds only artifacts the run *produced*; inputs belong elsewhere (`inputDataPaths` by convention). A staleness check on an input is meaningless, because nothing about an input becomes invalid when the reader changes.

---

## 7. Non-goals

- Not a statistics package. No p-values, no confidence intervals, no multiple-comparison correction. Gates are mechanical predicates on shapes that already fooled us.
- No Cloudflare. No D1 / Vectorize / R2 / KV, no `wrangler`, no public `/cag`. Same hard boundary as the CAG-memory prototype.
- Not wired into CI in this pass. `scripts/autoresearch-audit.ts` is a local CLI; exit 1 on a blocker is the enforcement, not a workflow file.
- Does not replace human judgement on **what question to ask**. It refuses to certify an answer from a dirty instrument. It will not invent the next comparison.
- Does not promote memories, change `cagMemories.ts`, or rerun the 105-room extract. Those are product moves gated on a clean finding, which this harness has not issued for "much better CAG".
