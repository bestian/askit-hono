(function () {
  const { createApp, ref, computed, h } = Vue

  const COOLDOWN_SECONDS = 3
  const DOC_LANG = (typeof document !== 'undefined' && document.documentElement)
    ? document.documentElement.lang
    : ''
  const LANG = DOC_LANG === 'en' ? 'en' : 'zh-Hant'
  const STRINGS = {
    'zh-Hant': {
      logoAlt: '鳳問 logo',
      heading: '鳳問',
      tagline: '透過問答機器人，認識唐鳳的思想',
      consentPrefix: '我已閱讀並同意 ',
      consentJoin: ' 和 ',
      privacyHref: '/privacy',
      privacyLabel: '隱私權政策',
      termsHref: '/terms',
      termsLabel: '使用條款',
      placeholderReady: '輸入你的問題，例如：什麼是仁工智慧？',
      placeholderConsent: '請先同意隱私權政策和使用條款，才能發問',
      questionAria: '問題',
      submit: '送出',
      thinking: '思考中…',
      cooldownSuffix: ' 秒…',
      searching: '檢索逐字稿中…',
      fetchError: '查詢發生錯誤，請稍後再試。',
      networkError: '連線發生錯誤，請稍後再試。',
      sourcesHeading: '出處',
      samples: [
        '什麼是仁工智慧？',
        '什麼是數位民主？',
        '如何看待開放政府？',
        '唐鳳對 AI 的看法？',
      ],
    },
    en: {
      logoAlt: 'Ask Audrey logo',
      heading: 'Ask Audrey',
      tagline: 'Get to know Audrey Tang’s thinking, one question at a time',
      consentPrefix: 'I have read and agree to the ',
      consentJoin: ' and the ',
      privacyHref: '/en/privacy',
      privacyLabel: 'Privacy Policy',
      termsHref: '/en/terms',
      termsLabel: 'Terms of Use',
      placeholderReady: 'Type your question, e.g. “What is Plurality?”',
      placeholderConsent: 'Please agree to the Privacy Policy and Terms of Use first',
      questionAria: 'Question',
      submit: 'Ask',
      thinking: 'Thinking…',
      cooldownSuffix: ' s…',
      searching: 'Searching the transcripts…',
      fetchError: 'Something went wrong. Please try again later.',
      networkError: 'Connection error. Please try again later.',
      sourcesHeading: 'Sources',
      samples: [
        'What is Plurality?',
        'How do you see open government?',
        'Will AI control us?',
        'What is digital democracy?',
      ],
    },
  }
  const T = STRINGS[LANG]
  const BLOCKED_ELEMENT_SELECTOR = 'script, iframe, object, embed, base, meta, link'
  const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:'])
  const URL_ATTRIBUTE_NAMES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster'])

  function isSafeHttpUrl(value) {
    if (/[\s"'<>]/.test(value) || /&(quot|#39|lt|gt);/i.test(value)) return false
    try {
      const url = new URL(value)
      return ALLOWED_LINK_PROTOCOLS.has(url.protocol)
    } catch {
      return false
    }
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function escapeAttribute(value) {
    return escapeHtml(value)
  }

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.body.querySelectorAll(BLOCKED_ELEMENT_SELECTOR).forEach((element) => {
      element.remove()
    })

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT)
    let element = walker.nextNode()
    while (element) {
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
          element.removeAttribute(attr.name)
          continue
        }
        if (URL_ATTRIBUTE_NAMES.has(name) && !isSafeHttpUrl(attr.value)) {
          element.removeAttribute(attr.name)
        }
      }

      if (element.tagName.toLowerCase() === 'a') {
        element.setAttribute('target', '_blank')
        element.setAttribute('rel', 'nofollow noopener noreferrer')
      }

      element = walker.nextNode()
    }

    return doc.body.innerHTML
  }

  // 將串流回來的 Markdown（含 [^n] 引註與末尾 [^n]: [標題](網址) 註腳）
  // 拆成「正文 + 出處清單」，並把行內引註轉成可點擊、開新分頁的上標連結。
  function parseAnswer(raw) {
    const sources = []
    const seen = new Map()
    const body = raw.replace(
      /^\[\^(\d+)\]:\s*\[([^\]]*)\]\(([^)\s]+)\)\s*$/gm,
      (_m, num, label, href) => {
        if (!isSafeHttpUrl(href)) return ''
        const index = Number(num)
        if (!seen.has(index)) {
          seen.set(index, { index, label: label.trim() || href, href })
        }
        return ''
      },
    ).trim()

    sources.push(...[...seen.values()].sort((a, b) => a.index - b.index))
    const hrefByIndex = new Map(sources.map((s) => [s.index, s.href]))

    let html = escapeHtml(body)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    html = html.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      (_m, label, href) => {
        if (!isSafeHttpUrl(href)) return label
        return (
        '<a href="' + escapeAttribute(href) +
        '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
        )
      },
    )
    html = html.replace(/\[\^(\d+)\]/g, (m, num) => {
      const href = hrefByIndex.get(Number(num))
      if (!href) return ''
      return '<sup class="cite"><a href="' + escapeAttribute(href) +
        '" target="_blank" rel="noopener noreferrer">[' + num + ']</a></sup>'
    })

    return { html: sanitizeHtml(html), sources }
  }

  function formatErrorHtml(message) {
    return message ? sanitizeHtml(message) : ''
  }

  if (globalThis.__ASKIT_ENABLE_TEST_HOOKS__) {
    globalThis.__ASKIT_TESTS__ = { parseAnswer, isSafeHttpUrl, sanitizeHtml, formatErrorHtml, STRINGS }
  }

  createApp({
    setup() {
      const question = ref('')
      const raw = ref('')
      const loading = ref(false)
      const answered = ref(false)
      const error = ref('')
      const consentAccepted = ref(false)
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

      const samples = T.samples

      const parsed = computed(() => parseAnswer(raw.value))
      const bodyHtml = computed(() => parsed.value.html)
      const errorHtml = computed(() => formatErrorHtml(error.value))
      const sources = computed(() => parsed.value.sources)
      const canSubmit = computed(() =>
        consentAccepted.value && !loading.value && cooldown.value <= 0 && Boolean(question.value.trim()),
      )
      const canAskSample = computed(() =>
        consentAccepted.value && !loading.value && cooldown.value <= 0,
      )

      async function run(q) {
        const query = q.trim()
        if (!query || !consentAccepted.value || loading.value || cooldown.value > 0) return
        question.value = query
        loading.value = true
        answered.value = true
        error.value = ''
        raw.value = ''

        try {
          const res = await fetch('/cag/' + encodeURIComponent(query) + (LANG === 'en' ? '?lang=en' : ''))
          if (!res.ok) {
            error.value = (await res.text()) || T.fetchError
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
          error.value = T.networkError
        } finally {
          loading.value = false
          startCooldown()
        }
      }

      return () => h('div', [
        h('div', { class: 'hero' }, [
          h('img', { class: 'logo', src: '/logo.png', alt: T.logoAlt }),
          h('h1', T.heading),
          h('p', { class: 'tagline' }, T.tagline),
        ]),
        h('label', { class: 'consent' }, [
          h('input', {
            type: 'checkbox',
            checked: consentAccepted.value,
            disabled: loading.value,
            onChange: (event) => {
              consentAccepted.value = event.target.checked
            },
          }),
          h('span', [
            T.consentPrefix,
            h('a', { href: T.privacyHref, target: '_blank', rel: 'noopener noreferrer' }, T.privacyLabel),
            T.consentJoin,
            h('a', { href: T.termsHref, target: '_blank', rel: 'noopener noreferrer' }, T.termsLabel),
          ]),
        ]),
        h('section', { class: 'demo' }, [
          h('form', {
            class: 'ask-form',
            onSubmit: (event) => {
              event.preventDefault()
              run(question.value)
            },
          }, [
            h('input', {
              value: question.value,
              type: 'text',
              placeholder: consentAccepted.value
                ? T.placeholderReady
                : T.placeholderConsent,
              disabled: loading.value,
              'aria-label': T.questionAria,
              onInput: (event) => {
                question.value = event.target.value
              },
            }),
            h('button', {
              type: 'submit',
              disabled: !canSubmit.value,
              class: { loading: loading.value },
            }, loading.value ? T.thinking : (cooldown.value > 0 ? cooldown.value + T.cooldownSuffix : T.submit)),
          ]),
          !answered.value
            ? h('div', { class: 'samples' }, samples.map((sample) =>
              h('button', {
                type: 'button',
                key: sample,
                disabled: !canAskSample.value,
                onClick: () => run(sample),
              }, sample),
            ))
            : null,
          answered.value
            ? h('div', { class: 'answer' }, [
              !bodyHtml.value && !error.value && loading.value
                ? h('p', { class: 'placeholder' }, T.searching)
                : null,
              error.value ? h('p', { class: 'error', innerHTML: errorHtml.value }) : null,
              h('div', { class: 'body', innerHTML: bodyHtml.value }),
              loading.value ? h('span', { class: 'cursor' }, '▌') : null,
              sources.value.length
                ? h('div', { class: 'sources' }, [
                  h('h2', T.sourcesHeading),
                  h('ol', sources.value.map((src) =>
                    h('li', { key: src.index, value: src.index }, [
                      h('a', { href: src.href, target: '_blank', rel: 'noopener noreferrer' }, src.label),
                    ]),
                  )),
                ])
                : null,
            ])
            : null,
        ]),
      ])
    },
  }).mount('#app')
})()
