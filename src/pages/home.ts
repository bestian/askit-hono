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
      cursor: progress;
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
    <div id="app">
      <div class="hero">
        <img class="logo" src="/logo.png" alt="鳳問 logo">
        <h1>鳳問</h1>
        <p class="tagline">透過問答機器人，認識唐鳳的思想</p>
      </div>

      <section class="demo">
        <form class="ask-form" @submit.prevent="ask">
          <input
            v-model="question"
            type="text"
            placeholder="輸入你的問題，例如：什麼是仁工智慧？"
            :disabled="loading"
            aria-label="問題">
          <button type="submit" :disabled="loading || cooldown > 0 || !question.trim()">
            {{ loading ? '思考中…' : (cooldown > 0 ? cooldown + ' 秒…' : '送出') }}
          </button>
        </form>

        <div class="samples" v-if="!answered">
          <button
            type="button"
            v-for="s in samples"
            :key="s"
            @click="askSample(s)"
            :disabled="loading || cooldown > 0">{{ s }}</button>
        </div>

        <div class="answer" v-if="answered">
          <p class="placeholder" v-if="!bodyHtml && !error && loading">檢索逐字稿中…</p>
          <p class="error" v-if="error">{{ error }}</p>
          <div class="body" v-html="bodyHtml"></div>
          <span class="cursor" v-if="loading">▌</span>
          <div class="sources" v-if="sources.length">
            <h2>出處</h2>
            <ol>
              <li v-for="src in sources" :key="src.index" :value="src.index">
                <a :href="src.href" target="_blank" rel="noopener noreferrer">{{ src.label }}</a>
              </li>
            </ol>
          </div>
        </div>
      </section>
    </div>
  </main>
  <footer>
    <a href="/privacy">隱私權政策</a>
    <a href="/terms">使用條款</a>
  </footer>

  <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
  <script>
    const { createApp, ref, computed } = Vue

    // 將串流回來的 Markdown（含 [^n] 引註與末尾 [^n]: [標題](網址) 註腳）
    // 拆成「正文 + 出處清單」，並把行內引註轉成可點擊、開新分頁的上標連結。
    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    }

    function parseAnswer(raw) {
      const sources = []
      const seen = new Map()
      // 抽出末尾註腳定義：[^1]: [label](href)
      const body = raw.replace(
        /^\\[\\^(\\d+)\\]:\\s*\\[([^\\]]*)\\]\\(([^)\\s]+)\\)\\s*$/gm,
        (_m, num, label, href) => {
          const index = Number(num)
          if (!seen.has(index)) {
            seen.set(index, { index, label: label.trim() || href, href })
          }
          return ''
        },
      ).trim()

      sources.push(...[...seen.values()].sort((a, b) => a.index - b.index))
      const hrefByIndex = new Map(sources.map((s) => [s.index, s.href]))

      // 正文：先逃脫 HTML，再還原我們要的少量 Markdown。
      let html = escapeHtml(body)
      // 粗體 / 斜體
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      html = html.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>')
      // 行內 Markdown 連結 [text](url) → 開新分頁
      html = html.replace(
        /\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      )
      // 行內引註 [^n] → 上標連結（連到對應出處，開新分頁）
      html = html.replace(/\\[\\^(\\d+)\\]/g, (m, num) => {
        const href = hrefByIndex.get(Number(num))
        if (!href) return ''
        return '<sup class="cite"><a href="' + href +
          '" target="_blank" rel="noopener noreferrer">[' + num + ']</a></sup>'
      })

      return { html, sources }
    }

    createApp({
      setup() {
        const question = ref('')
        const raw = ref('')
        const loading = ref(false)
        const answered = ref(false)
        const error = ref('')
        // 防連續濫用：每次發問後送出鈕冷卻 10 秒（對齊後端 10 秒限流視窗）。
        const COOLDOWN_SECONDS = 10
        const cooldown = ref(0)
        let cooldownTimer = null
        function startCooldown() {
          cooldown.value = COOLDOWN_SECONDS
          if (cooldownTimer) clearInterval(cooldownTimer)
          cooldownTimer = setInterval(() => {
            cooldown.value -= 1
            if (cooldown.value <= 0) {
              cooldown.value = 0
              clearInterval(cooldownTimer)
              cooldownTimer = null
            }
          }, 1000)
        }
        const samples = [
          '什麼是仁工智慧？',
          '什麼是數位民主？',
          '如何看待開放政府？',
          '唐鳳對 AI 的看法？',
        ]

        const parsed = computed(() => parseAnswer(raw.value))
        const bodyHtml = computed(() => parsed.value.html)
        const sources = computed(() => parsed.value.sources)

        async function run(q) {
          const query = q.trim()
          if (!query || loading.value || cooldown.value > 0) return
          question.value = query
          loading.value = true
          answered.value = true
          error.value = ''
          raw.value = ''

          try {
            const res = await fetch('/cag/' + encodeURIComponent(query))
            if (!res.ok) {
              error.value = (await res.text()) || '查詢發生錯誤，請稍後再試。'
              return
            }
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              raw.value += decoder.decode(value, { stream: true })
            }
            raw.value += decoder.decode()
          } catch (e) {
            error.value = '連線發生錯誤，請稍後再試。'
          } finally {
            loading.value = false
            startCooldown()
          }
        }

        return {
          question,
          loading,
          cooldown,
          answered,
          error,
          samples,
          bodyHtml,
          sources,
          ask: () => run(question.value),
          askSample: (s) => run(s),
        }
      },
    }).mount('#app')
  </script>
</body>
</html>`
}
