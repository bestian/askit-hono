(function () {
  const { createApp, ref, computed, h, watch } = Vue

  const COOLDOWN_SECONDS = 3
  const LINE_FRIEND_URL = 'https://lin.ee/rCehs3j'
  const CLICK_HINT_MIN_QUESTIONS = 3
  const QUESTIONS_ASKED_KEY = 'askit-questions-asked'
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
      logoQrAlt: '加入鳳問 LINE 好友的 QR code',
      logoToggleAlt: '鳳問 logo（點我顯示 LINE 加好友 QR code）',
      lineFriendLabel: '加入 LINE 好友 →',
      clickHintArrow: '↑',
      clickHintText: '按我加 LINE 好友',
      placeholderReady: '輸入你的問題，例如：什麼是仁工智慧？',
      placeholderConsent: '請先同意隱私權政策和使用條款，才能發問',
      capacityFull: '目前全域用量已滿，請稍候或隔天再試。',
      questionAria: '問題',
      submit: '送出',
      thinking: '思考中…',
      cooldownSuffix: ' 秒…',
      searching: '檢索逐字稿並整理回答中…',
      fetchError: '查詢發生錯誤，請稍後再試。',
      networkError: '連線發生錯誤，請稍後再試。',
      copyMarkdown: '複製 Markdown',
      copiedMarkdown: '已複製',
      copyFailed: '無法複製，請手動選取文字',
      tooLong: '您的問題字數過長，請縮短問題的長度，謝謝！',
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
      logoQrAlt: 'QR code to add Ask Audrey Anything on LINE',
      logoToggleAlt: 'Ask Audrey Anything logo (click to show the LINE friend QR code)',
      lineFriendLabel: 'Add LINE friend →',
      clickHintArrow: '↑',
      clickHintText: 'Click me to add LINE friend',
      placeholderReady: 'Type your question, e.g. “What is Plurality?”',
      placeholderConsent: 'Please agree to the Privacy Policy and Terms of Use first',
      capacityFull: 'The service is at full capacity right now. Please wait a moment or try again tomorrow.',
      questionAria: 'Question',
      submit: 'Ask',
      thinking: 'Thinking…',
      cooldownSuffix: ' s…',
      searching: 'Searching transcripts and composing an answer…',
      fetchError: 'Something went wrong. Please try again later.',
      networkError: 'Connection error. Please try again later.',
      copyMarkdown: 'Copy Markdown',
      copiedMarkdown: 'Copied',
      copyFailed: 'Could not copy. Select the answer and copy manually.',
      tooLong: 'Your question is too long — please shorten it and try again. Thank you!',
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
    // 將行首的 Markdown 標題（# ~ ######）轉成對應的 <h1>~<h6>，
    // 只影響畫面顯示；下載／複製用的是未轉換的原始 Markdown。
    html = html.replace(
      /^(#{1,6})[ \t]+([^\n]+?)[ \t]*(?:\n|$)/gm,
      (_m, hashes, text) => {
        const level = hashes.length
        return '<h' + level + '>' + text + '</h' + level + '>'
      },
    )
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

  function readQuestionsAsked() {
    try {
      const n = Number(sessionStorage.getItem(QUESTIONS_ASKED_KEY))
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    } catch {
      return 0
    }
  }

  function persistQuestionsAsked(count) {
    try {
      sessionStorage.setItem(QUESTIONS_ASKED_KEY, String(count))
    } catch {
      // ignore
    }
  }

  async function copyMarkdownText(text, navigatorObject, documentObject) {
    if (!text) return false

    const nav = navigatorObject || (typeof navigator !== 'undefined' ? navigator : undefined)
    try {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(text)
        return true
      }
    } catch (e) {
      // Fall through to the DOM fallback below.
    }

    const doc = documentObject || (typeof document !== 'undefined' ? document : undefined)
    if (
      !doc ||
      !doc.body ||
      typeof doc.createElement !== 'function' ||
      typeof doc.execCommand !== 'function'
    ) {
      return false
    }

    const textarea = doc.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.inset = '0 auto auto 0'
    textarea.style.opacity = '0'
    doc.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    try {
      return Boolean(doc.execCommand('copy'))
    } finally {
      textarea.remove()
    }
  }

  if (globalThis.__ASKIT_ENABLE_TEST_HOOKS__) {
    globalThis.__ASKIT_TESTS__ = {
      parseAnswer, isSafeHttpUrl, sanitizeHtml, formatErrorHtml, STRINGS,
      copyMarkdownText,
    }
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
      const showQr = ref(false)
      const questionsAsked = ref(readQuestionsAsked())
      const capacityFull = ref(false)
      const copyState = ref('idle')
      let cooldownTimer = null
      let copyResetTimer = null

      watch(question, (newVal, oldVal) => {
        const codePoints = [...newVal]
        if (codePoints.length > 100) {
          question.value = codePoints.slice(0, 100).join('')
          error.value = T.tooLong
        } else if (error.value === T.tooLong && [...oldVal].length > 100) {
          // Truncation trigger, do not clear error
        } else if (error.value === T.tooLong) {
          error.value = ''
        }
      })

      const logoInteractive = computed(() =>
        consentAccepted.value && questionsAsked.value >= CLICK_HINT_MIN_QUESTIONS,
      )

      function toggleQr() {
        if (!logoInteractive.value) return
        showQr.value = !showQr.value
      }

      watch(logoInteractive, (interactive) => {
        if (!interactive) showQr.value = false
      })

      // 提問前先打自己的 /capacity（issue #43）：額度滿時擋下發問並提示。
      // 查詢失敗就維持可發問，別讓狀態查詢本身擋住使用者。
      async function refreshCapacity() {
        try {
          const res = await fetch('/capacity')
          if (!res.ok) return
          const data = await res.json()
          // capacityFull.value = true
          capacityFull.value = Boolean(data) && data.status === 'full'
        } catch (e) {
          // 查不到容量就當作可發問。
        }
      }

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
        consentAccepted.value && !loading.value && cooldown.value <= 0 &&
        !capacityFull.value && Boolean(question.value.trim()),
      )
      const canAskSample = computed(() =>
        consentAccepted.value && !loading.value && cooldown.value <= 0 && !capacityFull.value,
      )
      async function run(q) {
        const query = q.trim()
        if (!query || !consentAccepted.value || loading.value || cooldown.value > 0 || capacityFull.value) return
        question.value = query
        questionsAsked.value += 1
        persistQuestionsAsked(questionsAsked.value)
        loading.value = true
        answered.value = true
        error.value = ''
        raw.value = ''
        copyState.value = 'idle'
        if (copyResetTimer) {
          clearTimeout(copyResetTimer)
          copyResetTimer = null
        }

        try {
          const res = await fetch('/au/' + encodeURIComponent(query) + (LANG === 'en' ? '?lang=en' : ''))
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
          // 一次發問可能讓全域額度見底，重查一次好即時擋下下一題。
          refreshCapacity()
        }
      }

      const canCopy = computed(() =>
        Boolean(raw.value) && !loading.value && !error.value,
      )
      const copyLabel = computed(() =>
        copyState.value === 'copied' ? T.copiedMarkdown : T.copyMarkdown,
      )
      const copyStatus = computed(() =>
        copyState.value === 'failed' ? T.copyFailed : '',
      )

      function scheduleCopyStateReset() {
        if (copyResetTimer) clearTimeout(copyResetTimer)
        copyResetTimer = setTimeout(() => {
          copyState.value = 'idle'
          copyResetTimer = null
        }, 2000)
      }

      async function copyMarkdown() {
        if (!canCopy.value) return
        copyState.value = await copyMarkdownText(raw.value) ? 'copied' : 'failed'
        scheduleCopyStateReset()
      }

      const copyIcon = () => h('svg', {
        class: 'copy-icon',
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      }, [
        h('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }),
        h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
      ])

      refreshCapacity()

      return () => h('div', [
        h('div', { class: 'hero' }, [
          h('h1', T.heading),
          h('p', { class: 'tagline' }, T.tagline),
          h('div', { class: 'logo-wrap' }, [
            h('img', {
              class: ['logo', { qr: showQr.value, interactive: logoInteractive.value }],
              src: showQr.value ? '/Askit_M_gainfriends_2dbarcodes_GW.png' : '/logo.png',
              alt: showQr.value
                ? T.logoQrAlt
                : (logoInteractive.value ? T.logoToggleAlt : T.logoAlt),
              ...(logoInteractive.value ? {
                role: 'button',
                tabindex: '0',
                'aria-pressed': String(showQr.value),
                onClick: toggleQr,
                onKeydown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggleQr()
                  }
                },
              } : {}),
            }),
            showQr.value
              ? h('a', {
                class: 'line-link',
                href: LINE_FRIEND_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, T.lineFriendLabel)
              : logoInteractive.value
                ? h('div', { class: 'click-hint' }, [
                  h('div', { class: 'arrow' }, T.clickHintArrow),
                  h('div', { class: 'click-me' }, [
                    h('a', {
                      href: LINE_FRIEND_URL,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                    }, T.clickHintText),
                  ]),
                ])
                : null,
          ]),
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
          capacityFull.value
            ? h('p', { class: 'capacity-notice', role: 'status' }, T.capacityFull)
            : null,
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
          (answered.value || error.value)
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
              canCopy.value
                ? h('div', { class: 'answer-actions' }, [
                  h('button', {
                    type: 'button',
                    class: 'copy-md',
                    onClick: copyMarkdown,
                    'aria-label': copyLabel.value,
                    title: copyLabel.value,
                  }, [copyIcon(), h('span', copyLabel.value)]),
                  copyStatus.value
                    ? h('span', { class: 'copy-status', role: 'status', 'aria-live': 'polite' }, copyStatus.value)
                    : null,
                ])
                : null,
            ])
            : null,
        ]),
      ])
    },
  }).mount('#app')
})()
