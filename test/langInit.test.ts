import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const scriptPromise = readFile(new URL('../public/lang-init.js', import.meta.url), 'utf8')

type StubEvent = {
  target: {
    closest: (selector: string) => { getAttribute: (name: string) => string | null } | null
  } | null
}

function clickEventOn(targetLang: string): StubEvent {
  const element = {
    getAttribute: (name: string) => (name === 'data-lang' ? targetLang : null),
  }
  return {
    target: {
      closest: (selector: string) => (selector === '#lang-switch' ? element : null),
    },
  }
}

function clickEventElsewhere(): StubEvent {
  return {
    target: {
      closest: () => null,
    },
  }
}

async function runLangInit(options: {
  pageLang: string
  stored?: string | null
  getItemThrows?: boolean
  setItemThrows?: boolean
  pathname?: string
  search?: string
  hash?: string
}) {
  const {
    pageLang,
    stored = null,
    getItemThrows = false,
    setItemThrows = false,
    pathname = pageLang === 'en' ? '/en' : '/',
    search = '',
    hash = '',
  } = options
  const replaceCalls: string[] = []
  const setItemCalls: Array<[string, string]> = []
  const clickHandlers: Array<(event: StubEvent) => void> = []
  const auxclickHandlers: Array<(event: StubEvent) => void> = []
  const sandbox = {
    document: {
      documentElement: { lang: pageLang },
      addEventListener: (name: string, handler: (event: StubEvent) => void) => {
        if (name === 'click') clickHandlers.push(handler)
        if (name === 'auxclick') auxclickHandlers.push(handler)
      },
    },
    localStorage: {
      getItem: (_key: string) => {
        if (getItemThrows) throw new Error('storage disabled')
        return stored
      },
      setItem: (key: string, value: string) => {
        if (setItemThrows) throw new Error('storage disabled')
        setItemCalls.push([key, value])
      },
    },
    location: {
      pathname,
      search,
      hash,
      replace: (url: string) => {
        replaceCalls.push(url)
      },
    },
  }
  runInNewContext(await scriptPromise, sandbox)
  return { replaceCalls, setItemCalls, clickHandlers, auxclickHandlers }
}

test('stored en on zh page redirects to /en once', async () => {
  const { replaceCalls } = await runLangInit({ pageLang: 'zh-Hant', stored: 'en' })
  assert.deepEqual(replaceCalls, ['/en'])
})

test('stored zh-Hant on en page redirects to / once', async () => {
  const { replaceCalls } = await runLangInit({ pageLang: 'en', stored: 'zh-Hant' })
  assert.deepEqual(replaceCalls, ['/'])
})

test('no stored preference never redirects', async () => {
  const zh = await runLangInit({ pageLang: 'zh-Hant', stored: null })
  assert.deepEqual(zh.replaceCalls, [])
  const en = await runLangInit({ pageLang: 'en', stored: null })
  assert.deepEqual(en.replaceCalls, [])
})

test('stored preference matching the page never redirects', async () => {
  const en = await runLangInit({ pageLang: 'en', stored: 'en' })
  assert.deepEqual(en.replaceCalls, [])
  const zh = await runLangInit({ pageLang: 'zh-Hant', stored: 'zh-Hant' })
  assert.deepEqual(zh.replaceCalls, [])
})

test('garbage stored value never redirects', async () => {
  const zh = await runLangInit({ pageLang: 'zh-Hant', stored: 'garbage' })
  assert.deepEqual(zh.replaceCalls, [])
  const en = await runLangInit({ pageLang: 'en', stored: 'garbage' })
  assert.deepEqual(en.replaceCalls, [])
})

test('redirect preserves query string and hash', async () => {
  const zh = await runLangInit({ pageLang: 'zh-Hant', stored: 'en', search: '?q=1', hash: '#s2' })
  assert.deepEqual(zh.replaceCalls, ['/en?q=1#s2'])
  const en = await runLangInit({ pageLang: 'en', stored: 'zh-Hant', search: '?q=1', hash: '#s2' })
  assert.deepEqual(en.replaceCalls, ['/?q=1#s2'])
})

test('non-home pathnames never redirect even with an opposite stored preference', async () => {
  const legalZh = await runLangInit({ pageLang: 'zh-Hant', stored: 'en', pathname: '/privacy' })
  assert.deepEqual(legalZh.replaceCalls, [])
  const legalEn = await runLangInit({ pageLang: 'en', stored: 'zh-Hant', pathname: '/en/terms' })
  assert.deepEqual(legalEn.replaceCalls, [])
})

test('localStorage.getItem throwing neither redirects nor throws', async () => {
  const zh = await runLangInit({ pageLang: 'zh-Hant', getItemThrows: true })
  assert.deepEqual(zh.replaceCalls, [])
  const en = await runLangInit({ pageLang: 'en', getItemThrows: true })
  assert.deepEqual(en.replaceCalls, [])
})

test('click listeners attach immediately without waiting for DOMContentLoaded', async () => {
  const { clickHandlers, auxclickHandlers } = await runLangInit({
    pageLang: 'zh-Hant',
    stored: null,
  })
  assert.equal(clickHandlers.length, 1)
  assert.equal(auxclickHandlers.length, 1)
})

test('clicking the toggle persists the target language', async () => {
  const { setItemCalls, clickHandlers } = await runLangInit({ pageLang: 'zh-Hant', stored: null })
  assert.equal(clickHandlers.length, 1)
  for (const handler of clickHandlers) handler(clickEventOn('en'))
  assert.deepEqual(setItemCalls, [['lang', 'en']])
})

test('middle-clicking the toggle (auxclick) persists the target language', async () => {
  const { setItemCalls, auxclickHandlers } = await runLangInit({ pageLang: 'en', stored: null })
  assert.equal(auxclickHandlers.length, 1)
  for (const handler of auxclickHandlers) handler(clickEventOn('zh-Hant'))
  assert.deepEqual(setItemCalls, [['lang', 'zh-Hant']])
})

test('clicking outside the toggle persists nothing', async () => {
  const { setItemCalls, clickHandlers } = await runLangInit({ pageLang: 'zh-Hant', stored: null })
  for (const handler of clickHandlers) {
    handler(clickEventElsewhere())
    handler({ target: null })
  }
  assert.deepEqual(setItemCalls, [])
})

test('localStorage.setItem throwing on click does not throw', async () => {
  const { clickHandlers } = await runLangInit({
    pageLang: 'zh-Hant',
    stored: null,
    setItemThrows: true,
  })
  assert.doesNotThrow(() => {
    for (const handler of clickHandlers) handler(clickEventOn('en'))
  })
})
