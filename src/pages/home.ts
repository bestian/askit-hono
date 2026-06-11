export function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>鳳問 | 認識唐鳳的思想</title>
  <meta name="description" content="鳳問是一個問答機器人：提出問題，AI 會檢索唐鳳的逐字稿並附上出處作答，帶你認識唐鳳的思想。">
  <link rel="canonical" href="https://ask.archive.tw/">

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#5AAD67">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="鳳問">
  <meta property="og:locale" content="zh_TW">
  <meta property="og:title" content="鳳問 | 認識唐鳳的思想">
  <meta property="og:description" content="提出問題，AI 會檢索唐鳳的逐字稿並附上出處作答，帶你認識唐鳳的思想。">
  <meta property="og:url" content="https://ask.archive.tw/">
  <meta property="og:image" content="https://ask.archive.tw/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="鳳問 | 認識唐鳳的思想">
  <meta name="twitter:description" content="提出問題，AI 會檢索唐鳳的逐字稿並附上出處作答，帶你認識唐鳳的思想。">
  <meta name="twitter:image" content="https://ask.archive.tw/og-image.png">
  <style>
    :root {
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
      --bg: #f7f8f5;
      --fg: #17212b;
      --muted: #5b6770;
      --border: #d9ded6;
      --link: #2457a6;
      --card: #ffffff;
      --accent: #2457a6;
      --accent-fg: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      display: grid;
      grid-template-rows: 1fr auto;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 48px 0 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .hero { display: grid; place-items: center; }
    img.logo {
      width: clamp(112px, 28vw, 176px);
      height: auto;
      border-radius: 24px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0;
      font-size: clamp(2.5rem, 11vw, 5.5rem);
      line-height: 1;
      letter-spacing: 0;
    }
    .tagline {
      margin: 16px 0 0;
      font-size: clamp(1rem, 3.6vw, 1.4rem);
      color: var(--muted);
    }
    .demo {
      width: 100%;
      margin-top: 36px;
      text-align: left;
    }
    .ask-form {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ask-form input {
      flex: 1 1 220px;
      min-width: 0;
      padding: 12px 16px;
      font-size: 1.05rem;
      color: var(--fg);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .ask-form input:focus {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .ask-form button {
      flex: 0 0 auto;
      padding: 12px 24px;
      font-size: 1.05rem;
      font-weight: 600;
      color: var(--accent-fg);
      background: var(--accent);
      border: 0;
      border-radius: 12px;
      cursor: pointer;
    }
    .ask-form button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .ask-form button.loading:disabled { cursor: progress; }
    .consent {
      margin: 12px 0 0;
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 0.95rem;
      color: var(--muted);
    }
    .consent input {
      margin-top: 0.35em;
      flex: 0 0 auto;
      accent-color: var(--accent);
    }
    .samples {
      margin: 14px 0 0;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .samples button {
      padding: 6px 12px;
      font-size: 0.9rem;
      color: var(--link);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 999px;
      cursor: pointer;
    }
    .samples button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .answer {
      margin-top: 24px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      min-height: 60px;
      overflow-wrap: anywhere;
    }
    .answer .placeholder { color: var(--muted); }
    .answer .body { white-space: pre-wrap; }
    .answer .error { color: #b3261e; }
    sup.cite a {
      font-size: 0.72em;
      padding: 0 1px;
      text-decoration: none;
    }
    .sources {
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .sources h2 {
      margin: 0 0 10px;
      font-size: 0.95rem;
      color: var(--muted);
      font-weight: 600;
    }
    .sources ol { margin: 0; padding-left: 1.4em; }
    .sources li { margin-bottom: 6px; }
    .cursor {
      display: inline-block;
      width: 0.5em;
      animation: blink 1s steps(2) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    footer {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 24px 0 32px;
      display: flex;
      justify-content: center;
      gap: 20px;
      flex-wrap: wrap;
      border-top: 1px solid var(--border);
    }
    a { color: var(--link); text-underline-offset: 0.18em; }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #121614;
        --fg: #eef2f3;
        --muted: #9aa6ad;
        --border: #343b35;
        --link: #9fc2ff;
        --card: #1b211e;
        --accent: #3a6fc4;
      }
    }
    @media (max-width: 480px) {
      .ask-form button { flex: 1 1 100%; }
    }
  </style>
</head>
<body>
  <main>
    <div id="app"></div>
  </main>
  <footer>
    <a href="/privacy">隱私權政策</a>
    <a href="/terms">使用條款</a>
  </footer>

  <script src="/vendor/vue.global.prod.js" defer></script>
  <script src="/app.js" defer></script>
</body>
</html>`
}
