import { hreflangLinks, PAGE_BASE_URL, type PageLang } from './lang'

const TERMS_STRINGS = {
  'zh-Hant': {
    title: '使用條款 | Terms of Use | 鳳問',
    description:
      '鳳問的使用條款：使用服務即表示您同意遵守條款，並同意為防止濫用收集提問內容、IP 與 userId 等必要資訊。',
    ogSiteName: '鳳問',
    ogLocale: 'zh_TW',
    canonicalPath: '/terms',
    navHome: { href: '/', label: '首頁 Home' },
    navOther: { href: '/privacy', label: '隱私權政策 Privacy Policy' },
    navLang: { href: '/en/terms', label: 'English' },
  },
  en: {
    title: 'Terms of Use | 使用條款 | 鳳問 Ask Audrey',
    description:
      'Ask Audrey’s terms: by using the service you agree to these terms and to the collection of questions, IPs and user IDs needed to prevent abuse.',
    ogSiteName: '鳳問 Ask Audrey',
    ogLocale: 'en_US',
    canonicalPath: '/en/terms',
    navHome: { href: '/en', label: 'Home' },
    navOther: { href: '/en/privacy', label: 'Privacy Policy' },
    navLang: { href: '/terms', label: '華語' },
  },
} as const

function zhSection(cssClass: string): string {
  return `<section${cssClass} aria-labelledby="terms-zh">
      <h2 id="terms-zh">華語</h2>
      <p>我們歡迎您以好奇、善意與負責任的方式使用本服務，探索唐鳳的公開談話、引用有出處的內容，並與更多人分享公共知識。</p>
      <p>使用本服務前，請先閱讀並同意本使用條款與<a href="/privacy">隱私權政策</a>。若您不同意，請勿使用本服務。</p>
      <p>為維護服務穩定、提供回覆、避免濫用、攻擊、繞過限流或大量自動化請求，您同意我們依隱私權政策收集並使用必要資訊，包括您提出的問題、連線 IP、LINE 使用者識別碼或網站使用者識別碼（userId，如有）、請求時間、限流紀錄與相關技術紀錄。除非發現濫用疑慮或依法必須提供，否則我們不會將您的提問內容或可識別資訊提供給第三方。</p>
      <p>您不得以自動化、偽造身分、變更來源、分散流量或其他方式規避限流、封鎖或安全措施；如有濫用、攻擊或不當使用情事，我們得暫停、限制或封鎖相關請求，並保留法律追訴權。</p>
      <p>本 Bot 回應之所有內容採用 Creative Commons Attribution-ShareAlike（CC BY-SA，姓名標示-相同方式分享）授權。</p>
      <p>您可以在合理使用及註明出處後引用、分享、改作或進行衍生創作；衍生內容亦應依 CC BY-SA 的精神，以相同或相容授權方式分享。</p>
      <p>上述授權不包含惡意的斷章取義、變造文句、截圖加工，或其他足以誤導他人、損害原意或侵害權益的使用方式。</p>
      <p>如有惡意使用、誤導性使用或其他不當使用情事，我們保留法律追訴權。</p>
    </section>`
}

function enSection(cssClass: string, privacyHref: string): string {
  return `<section${cssClass} aria-labelledby="terms-en">
      <h2 id="terms-en">English</h2>
      <p>We welcome you to use this service with curiosity, goodwill, and responsibility: explore Audrey Tang's public talks, cite sourced content, and share public knowledge with others.</p>
      <p>Before using this service, please read and agree to these Terms of Use and the <a href="${privacyHref}">Privacy Policy</a>. If you do not agree, please do not use the service.</p>
      <p>To maintain service stability, provide replies, and prevent abuse, attacks, rate-limit bypasses, or large-scale automated requests, you agree that we may collect and use necessary information as described in the Privacy Policy, including the questions you submit, connection IP addresses, LINE user IDs or website user IDs (userId, if available), request times, rate-limit records, and related technical logs. Unless we identify suspected abuse or are legally required to do so, we do not provide your question content or identifiable information to third parties.</p>
      <p>You may not use automation, forged identities, changed origins, distributed traffic, or other methods to circumvent rate limits, blocks, or security measures. In cases of abuse, attacks, or improper use, we may suspend, restrict, or block related requests and reserve the right to pursue legal action.</p>
      <p>All content provided in replies by this Bot is licensed under Creative Commons Attribution-ShareAlike (CC BY-SA).</p>
      <p>You may quote, share, adapt, or create derivative works from the content after making reasonable use and providing proper attribution. Derivative works should also be shared under the same or a compatible license in the spirit of CC BY-SA.</p>
      <p>This permission does not include malicious quotation out of context, alteration of wording, edited screenshots, or any other use that may mislead others, distort the original meaning, or infringe rights.</p>
      <p>We reserve the right to pursue legal action in cases of malicious, misleading, or otherwise improper use.</p>
      <p><em>This English version is provided for convenience; if it and the Chinese version differ, the Chinese version governs.</em></p>
    </section>`
}

export function renderTermsOfUsePage(lang: PageLang = 'zh-Hant'): string {
  const s = TERMS_STRINGS[lang]
  // the second section carries class="lang" (its top border separates the two)
  const first = lang === 'en' ? enSection('', '/en/privacy') : zhSection('')
  const second = lang === 'en' ? zhSection(' class="lang"') : enSection(' class="lang"', '/privacy')
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${s.title}</title>
  <meta name="description" content="${s.description}">
  <link rel="canonical" href="${PAGE_BASE_URL}${s.canonicalPath}">
  ${hreflangLinks('/terms', '/en/terms')}

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#5AAD67">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${s.ogSiteName}">
  <meta property="og:locale" content="${s.ogLocale}">
  <meta property="og:title" content="${s.title}">
  <meta property="og:description" content="${s.description}">
  <meta property="og:url" content="${PAGE_BASE_URL}${s.canonicalPath}">
  <meta property="og:image" content="https://ask.archive.tw/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${s.title}">
  <meta name="twitter:description" content="${s.description}">
  <meta name="twitter:image" content="https://ask.archive.tw/og-image.png">
  <style>
    :root {
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.7;
    }
    body {
      margin: 0;
      color: #17212b;
      background: #f7f8f5;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 48px 0 64px;
    }
    h1 {
      margin: 0 0 24px;
      font-size: clamp(2rem, 5vw, 3.25rem);
      line-height: 1.15;
    }
    h2 {
      margin: 32px 0 12px;
      font-size: 1.25rem;
    }
    p {
      margin: 0 0 16px;
    }
    a {
      color: #2457a6;
    }
    .lang {
      padding-top: 28px;
      border-top: 1px solid #d9ded6;
    }
    nav {
      margin-top: 32px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    @media (prefers-color-scheme: dark) {
      body {
        color: #eef2f3;
        background: #121614;
      }
      a {
        color: #9fc2ff;
      }
      .lang {
        border-color: #343b35;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>使用條款<br>Terms of Use</h1>

    ${first}

    ${second}

    <nav aria-label="Legal pages">
      <a href="${s.navHome.href}">${s.navHome.label}</a>
      <a href="${s.navOther.href}">${s.navOther.label}</a>
      <a href="${s.navLang.href}">${s.navLang.label}</a>
    </nav>
  </main>
</body>
</html>`
}
