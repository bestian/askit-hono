export function renderPrivacyPolicyPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>隱私權政策 | Privacy Policy</title>
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
      <p>本 Bot 不收集、儲存、販售、交換或分析任何使用者資料。</p>
      <p>當您傳送訊息給本 Bot 時，訊息只會用於即時產生回覆；我們不會建立使用者個人檔案，也不會將您的訊息內容保存於資料庫。</p>
      <p>本 Bot 可能會依 LINE Platform 與 Cloudflare Workers 的運作機制接收必要的請求資訊，但我們不會主動蒐集或留存可識別您的個人資料。</p>
    </section>

    <section class="lang" aria-labelledby="privacy-en">
      <h2 id="privacy-en">English</h2>
      <p>This Bot does not collect, store, sell, exchange, or analyze any user data.</p>
      <p>When you send a message to this Bot, the message is used only to generate an immediate reply. We do not create user profiles or store your message content in a database.</p>
      <p>This Bot may receive request information required by LINE Platform and Cloudflare Workers to operate, but we do not actively collect or retain personal data that identifies you.</p>
    </section>

    <nav aria-label="Legal pages">
      <a href="/">首頁 Home</a>
      <a href="/terms">使用條款 Terms of Use</a>
    </nav>
  </main>
</body>
</html>`
}
