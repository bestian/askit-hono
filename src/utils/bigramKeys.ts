/**
 * CJK bigram key extraction — single source of truth for both the runtime
 * rescue (`searchSectionsByContent`) and the build (`build-bigram-index`).
 *
 * Han runs → overlapping 2-grams; alphanumeric tokens (>=2 chars) → whole
 * lowercased token. Mirrors how `scripts/build-ask-index.ts` imports
 * `src/utils/askIndexFormat.ts` so runtime and build can never drift.
 *
 * Latin is handled as whole tokens (not bigrams) to avoid noise — Latin terms
 * are already well covered by Vectorize / archive.tw search. Single Han chars
 * produce no key deliberately (far too common to be selective).
 *
 * 註：supplementary-plane Han (Ext B+) 是 surrogate pair；`run.slice(i, i+2)`
 * 以 UTF-16 code unit 為單位，可能切到 surrogate pair 中間。 Audrey 語料為主
 * 的 BMP Han 不受影響，此邊界情況可接受。
 */
export function extractIndexKeys(text: string): Set<string> {
  const keys = new Set<string>()
  if (!text) return keys
  for (const m of text.matchAll(/\p{Script=Han}{2,}/gu)) {
    const run = m[0]
    for (let i = 0; i < run.length - 1; i++) keys.add(run.slice(i, i + 2))
  }
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9]+/g)) {
    keys.add(m[0].toLowerCase())
  }
  return keys
}
