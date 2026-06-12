import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

export type PageStrings = Record<string, Record<string, unknown>>

export type AppTestHooks = {
  parseAnswer: (raw: string) => {
    html: string
    sources: { index: number; label: string; href: string }[]
  }
  isSafeHttpUrl: (value: string) => boolean
  sanitizeHtml: (html: string) => string
  STRINGS: PageStrings
}

/**
 * Runs public/app.js in a bare VM context (no document) with the minimal
 * DOMParser/NodeFilter/Vue stubs it needs, and returns its test hooks.
 */
export async function loadAppTestHooks(): Promise<AppTestHooks> {
  const appJs = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8')
  const context = {
    URL,
    NodeFilter: { SHOW_ELEMENT: 1 },
    DOMParser: class {
      parseFromString(html: string) {
        return {
          body: {
            innerHTML: html,
            querySelectorAll: () => [],
          },
          createTreeWalker: () => ({ nextNode: () => null }),
        }
      }
    },
    Vue: {
      createApp: () => ({ mount: () => {} }),
      ref: (value: unknown) => ({ value }),
      computed: (fn: () => unknown) => ({ get value() { return fn() } }),
      h: () => ({}),
    },
    __ASKIT_ENABLE_TEST_HOOKS__: true,
  }

  runInNewContext(appJs, context)
  return (context as typeof context & { __ASKIT_TESTS__: AppTestHooks }).__ASKIT_TESTS__
}
