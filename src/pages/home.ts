export function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>鳳問</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
    }
    body {
      min-height: 100vh;
      margin: 0;
      color: #17212b;
      background: #f7f8f5;
      display: grid;
      grid-template-rows: 1fr auto;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 64px 0 40px;
      display: grid;
      place-items: center;
      text-align: center;
    }
    img {
      width: clamp(128px, 32vw, 192px);
      height: auto;
      border-radius: 24px;
      margin-bottom: 28px;
    }
    h1 {
      margin: 0;
      font-size: clamp(3rem, 12vw, 6.5rem);
      line-height: 1;
      letter-spacing: 0;
    }
    p {
      margin: 20px 0 0;
      font-size: clamp(1.125rem, 4vw, 1.6rem);
    }
    footer {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 24px 0 32px;
      display: flex;
      justify-content: center;
      gap: 20px;
      flex-wrap: wrap;
      border-top: 1px solid #d9ded6;
    }
    a {
      color: #2457a6;
      text-decoration-thickness: 0.08em;
      text-underline-offset: 0.18em;
    }
    @media (prefers-color-scheme: dark) {
      body {
        color: #eef2f3;
        background: #121614;
      }
      footer {
        border-color: #343b35;
      }
      a {
        color: #9fc2ff;
      }
    }
  </style>
</head>
<body>
  <main>
    <div>
      <img src="/logo.png" alt="鳳問 logo">
      <h1>鳳問</h1>
      <p>透過 Line Bot，認識唐鳳的思想</p>
    </div>
  </main>
  <footer>
    <a href="/privacy">隱私權政策</a>
    <a href="/terms">使用條款</a>
  </footer>
</body>
</html>`
}
