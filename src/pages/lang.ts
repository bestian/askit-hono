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
