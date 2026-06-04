export function renderTermsOfUsePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>使用條款 | Terms of Use | 鳳問</title>
  <meta name="description" content="鳳問的使用條款：回應內容採 Creative Commons 姓名標示-相同方式分享（CC BY-SA）授權。">
  <link rel="canonical" href="https://askit-hono.audreyt.workers.dev/terms">

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#5AAD67">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="鳳問">
  <meta property="og:locale" content="zh_TW">
  <meta property="og:title" content="使用條款 | Terms of Use | 鳳問">
  <meta property="og:description" content="鳳問的使用條款：回應內容採 Creative Commons 姓名標示-相同方式分享（CC BY-SA）授權。">
  <meta property="og:url" content="https://askit-hono.audreyt.workers.dev/terms">
  <meta property="og:image" content="https://askit-hono.audreyt.workers.dev/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="使用條款 | Terms of Use | 鳳問">
  <meta name="twitter:description" content="鳳問的使用條款：回應內容採 Creative Commons 姓名標示-相同方式分享（CC BY-SA）授權。">
  <meta name="twitter:image" content="https://askit-hono.audreyt.workers.dev/og-image.png">
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

    <section aria-labelledby="terms-zh">
      <h2 id="terms-zh">華語</h2>
      <p>本 Bot 回應之所有內容採用 Creative Commons Attribution-ShareAlike（CC BY-SA，姓名標示-相同方式分享）授權。</p>
      <p>您可以在合理使用及註明出處後引用、分享、改作或進行衍生創作；衍生內容亦應依 CC BY-SA 的精神，以相同或相容授權方式分享。</p>
      <p>上述授權不包含惡意的斷章取義、變造文句、截圖加工，或其他足以誤導他人、損害原意或侵害權益的使用方式。</p>
      <p>如有惡意使用、誤導性使用或其他不當使用情事，我們保留法律追訴權。</p>
    </section>

    <section class="lang" aria-labelledby="terms-en">
      <h2 id="terms-en">English</h2>
      <p>All content provided in replies by this Bot is licensed under Creative Commons Attribution-ShareAlike (CC BY-SA).</p>
      <p>You may quote, share, adapt, or create derivative works from the content after making reasonable use and providing proper attribution. Derivative works should also be shared under the same or a compatible license in the spirit of CC BY-SA.</p>
      <p>This permission does not include malicious quotation out of context, alteration of wording, edited screenshots, or any other use that may mislead others, distort the original meaning, or infringe rights.</p>
      <p>We reserve the right to pursue legal action in cases of malicious, misleading, or otherwise improper use.</p>
    </section>

    <nav aria-label="Legal pages">
      <a href="/">首頁 Home</a>
      <a href="/privacy">隱私權政策 Privacy Policy</a>
    </nav>
  </main>
</body>
</html>`
}
