export function renderPrivacyPolicyPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>隱私權政策 | Privacy Policy | 鳳問</title>
  <meta name="description" content="鳳問的隱私權政策：我們不販售或交換個人資料；正式版會收集提問內容、IP 與 userId 等必要資訊以防止濫用。">
  <link rel="canonical" href="https://ask.archive.tw/privacy">

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#5AAD67">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="鳳問">
  <meta property="og:locale" content="zh_TW">
  <meta property="og:title" content="隱私權政策 | Privacy Policy | 鳳問">
  <meta property="og:description" content="鳳問的隱私權政策：我們不販售或交換個人資料；正式版會收集提問內容、IP 與 userId 等必要資訊以防止濫用。">
  <meta property="og:url" content="https://ask.archive.tw/privacy">
  <meta property="og:image" content="https://ask.archive.tw/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="隱私權政策 | Privacy Policy | 鳳問">
  <meta name="twitter:description" content="鳳問的隱私權政策：我們不販售或交換個人資料；正式版會收集提問內容、IP 與 userId 等必要資訊以防止濫用。">
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
    <h1>隱私權政策<br>Privacy Policy</h1>

    <section aria-labelledby="privacy-zh">
      <h2 id="privacy-zh">華語</h2>
      <p>我們希望鳳問能成為友善、開放、可持續的公共知識入口，讓更多人安心提問、分享與學習。</p>
      <p>本 Bot 不會販售或交換您的個人資料，也不會為廣告目的替您建立個人檔案。</p>
      <p>當您傳送訊息給本 Bot 時，正式版會收集並保留您提出的問題，用於產生回覆、維護服務品質、偵測濫用與處理資安事件。</p>
      <p>為了讓服務穩定、對每位使用者公平，並防止濫用、攻擊、繞過限流或大量自動化請求，正式版也會收集並保留必要的防濫用資訊，包括連線 IP、LINE 使用者識別碼或網站使用者識別碼（userId，如有）、請求時間、限流紀錄與相關技術紀錄。</p>
      <p>上述資訊只會用於提供服務、維護服務安全、偵測異常流量、建立或執行防濫用名單、處理資安事件，以及遵循法律或主管機關要求；不會用於廣告投放，也不會出售給第三方。除非發現濫用、攻擊、規避限流或其他不當使用疑慮，或依法必須提供，否則我們不會將您的提問內容或可識別資訊提供給第三方。</p>
      <p>本 Bot 會依 LINE Platform 與 Cloudflare Workers 的運作機制接收必要的請求資訊。除為提供服務、維護安全、防止濫用或依法所需外，我們不會主動蒐集或留存其他可識別您的個人資料。</p>
    </section>

    <section class="lang" aria-labelledby="privacy-en">
      <h2 id="privacy-en">English</h2>
      <p>We hope Ask Audrey can serve as a friendly, open, and sustainable public knowledge gateway where people can ask, share, and learn with confidence.</p>
      <p>This Bot does not sell or exchange your personal data, and does not build an advertising profile of you.</p>
      <p>When you send a message to this Bot, the production version collects and retains the questions you submit to generate replies, maintain service quality, detect abuse, and handle security incidents.</p>
      <p>To keep the service stable and fair for everyone, and to prevent abuse, attacks, rate-limit bypasses, or large-scale automated requests, the production version also collects and retains necessary anti-abuse information, including connection IP addresses, LINE user IDs or website user IDs (userId, if available), request times, rate-limit records, and related technical logs.</p>
      <p>This information is used only to provide the service, maintain service security, detect abnormal traffic, create or enforce anti-abuse lists, handle security incidents, and comply with legal or regulatory requirements. It is not used for advertising and is not sold to third parties. Unless we identify suspected abuse, attacks, rate-limit circumvention, or other improper use, or are legally required to do so, we do not provide your question content or identifiable information to third parties.</p>
      <p>The Bot may receive request information required by LINE Platform and Cloudflare Workers to operate. Except as needed to provide the service, maintain security, prevent abuse, or comply with law, we do not otherwise actively collect or retain personal data that identifies you.</p>
    </section>

    <nav aria-label="Legal pages">
      <a href="/">首頁 Home</a>
      <a href="/terms">使用條款 Terms of Use</a>
    </nav>
  </main>
</body>
</html>`
}
