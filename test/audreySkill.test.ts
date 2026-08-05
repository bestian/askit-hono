import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUDREY_SKILL_DEFAULT_MODEL,
  AUDREY_SKILL_FUGU_MODEL,
  AUDREY_SKILL_NEMOTRON_ULTRA_MODEL,
  AUDREY_SKILL_GLM_52_MODEL,
  audreySkillCitationFootnotes,
  buildAudreySkillAnswerInstruction,
  renderAudreySkillMarkdown,
  resolveAudreySkillModel,
} from '../src/utils/audreySkill'
import type { CagSource } from '../src/utils/cag'

const sources: CagSource[] = [
  {
    content: '仁工智慧提升社群照顧自己與他人的能力。',
    href: 'https://archive.tw/2026-05-28-demo#s63852758',
    label: '2026-05-28 demo — 唐鳳',
    sectionId: 63852758,
  },
  {
    content: 'AI 在對齊大會中像高級西洋棋鐘。',
    href: 'https://archive.tw/2026-05-28-demo#s63852803',
    label: '2026-05-28 demo — 唐鳳',
    sectionId: 63852803,
  },
]

async function streamToString(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out += value
  }
}

async function renderStrictChunks(
  chunks: string[],
  testSources: CagSource[] = sources,
): Promise<string> {
  const input = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return streamToString(input.pipeThrough(audreySkillCitationFootnotes(testSources)))
}

test('Audrey skill instruction has identity boundary, style contract, and citation boundary', () => {
  const zh = buildAudreySkillAnswerInstruction()
  assert.match(zh, /不要聲稱自己是 Audrey Tang|不要聲稱自己是唐鳳/)
  assert.match(zh, /繁體中文/)
  assert.match(zh, /重新框架/)
  assert.match(zh, /只能引用本次提供的編號來源/)
  assert.match(zh, /不要輸出 archive\.tw 原始網址/)

  const en = buildAudreySkillAnswerInstruction('en')
  assert.match(en, /Answer in English/)
  assert.match(en, /Do not claim to be Audrey Tang/)
  assert.match(en, /only cite the numbered runtime sources/)
})

test('resolveAudreySkillModel only allows supported /au models including fugu', () => {
  assert.equal(resolveAudreySkillModel(undefined), AUDREY_SKILL_DEFAULT_MODEL)
  assert.equal(resolveAudreySkillModel(''), AUDREY_SKILL_DEFAULT_MODEL)
  assert.equal(resolveAudreySkillModel(AUDREY_SKILL_DEFAULT_MODEL), AUDREY_SKILL_DEFAULT_MODEL)
  assert.equal(resolveAudreySkillModel(AUDREY_SKILL_GLM_52_MODEL), AUDREY_SKILL_GLM_52_MODEL)
  assert.equal(resolveAudreySkillModel(AUDREY_SKILL_FUGU_MODEL), AUDREY_SKILL_FUGU_MODEL)
  assert.equal(resolveAudreySkillModel('@cf/attacker/expensive-model'), AUDREY_SKILL_DEFAULT_MODEL)
})

test('renderAudreySkillMarkdown rewrites valid runtime citations and strips fabricated citations', () => {
  const rendered = renderAudreySkillMarkdown(
    '有效 [1]，越界 [9]，章節假引 [63852758]，原始網址 https://archive.tw/2026-05-28-demo#s63852758，Markdown 假引 [63852758](https://archive.tw/2026-05-28-demo#s63852758)。第二個有效 [2]',
    sources,
  )

  const answerBody = rendered.split('\n\n[^1]:')[0]!
  assert.match(answerBody, /有效 \[\^1\]/)
  assert.match(answerBody, /第二個有效 \[\^2\]/)
  assert.doesNotMatch(answerBody, /\[9\]/)
  assert.doesNotMatch(answerBody, /\[63852758\]/)
  assert.doesNotMatch(answerBody, /https:\/\/archive\.tw\/2026-05-28-demo#s63852758/)
  assert.match(rendered, /\[\^1\]: \[2026-05-28 demo — 唐鳳\]\(https:\/\/archive\.tw\/2026-05-28-demo#s63852758\)/)
  assert.match(rendered, /\[\^2\]: \[2026-05-28 demo — 唐鳳\]\(https:\/\/archive\.tw\/2026-05-28-demo#s63852803\)/)
})

test('audreySkillCitationFootnotes streams strict citation cleanup across chunks', async () => {
  const input = new ReadableStream<string>({
    start(controller) {
      controller.enqueue('有效 [')
      controller.enqueue('1]，越界 [9]，假章節 [638')
      controller.enqueue('52758](https://archive.tw/2026-05-28-demo#s63852758)，原始網址 https://archive.tw/2026-05-28-demo#s63852758。第二個有效 [2]')
      controller.close()
    },
  })

  const output = await streamToString(input.pipeThrough(audreySkillCitationFootnotes(sources)))
  const answerBody = output.split('\n\n[^1]:')[0]!
  assert.match(answerBody, /有效 \[\^1\]/)
  assert.match(answerBody, /第二個有效 \[\^2\]/)
  assert.doesNotMatch(answerBody, /\[9\]/)
  assert.doesNotMatch(answerBody, /\[63852758\]/)
  assert.doesNotMatch(answerBody, /https:\/\/archive\.tw\/2026-05-28-demo#s63852758/)
  assert.match(output, /\[\^1\]: \[2026-05-28 demo — 唐鳳\]\(https:\/\/archive\.tw\/2026-05-28-demo#s63852758\)/)
  assert.match(output, /\[\^2\]: \[2026-05-28 demo — 唐鳳\]\(https:\/\/archive\.tw\/2026-05-28-demo#s63852803\)/)
})

test('audreySkillCitationFootnotes handles adversarial chunk boundaries like a single chunk', async () => {
  const manySources: CagSource[] = Array.from({ length: 12 }, (_value, index) => ({
    content: `source ${index + 1}`,
    href: `https://archive.tw/source-${index + 1}#s${index + 1}`,
    label: `source ${index + 1}`,
    sectionId: index + 1,
  }))
  const input = '有效 [12]，章節假引 [63852758](https://archive.tw/2026-05-28-demo#s63852758)，原始網址 https://archive.tw/2026-05-28-demo#s63852758。'
  const single = await renderStrictChunks([input], manySources)
  const splits = [
    input.indexOf('[12]') + 2, // '[1' | '2]'
    input.indexOf('](https://') + 1, // '[63852758]' | '(https://...)'
    input.lastIndexOf('https://archi') + 'https://archi'.length, // mid raw URL
  ]

  for (const split of splits) {
    const multi = await renderStrictChunks([input.slice(0, split), input.slice(split)], manySources)
    assert.equal(multi, single)
    assert.doesNotMatch(multi, /\[638/)
    assert.doesNotMatch(multi, /archive\.tw\/2026-05-28-demo/)
    assert.doesNotMatch(multi, /\(\)/)
  }
})

test('audreySkillCitationFootnotes drops unfinished citations and URLs on flush', async () => {
  assert.equal(await renderStrictChunks(['開頭 [638527']), '開頭 ')
  assert.equal(await renderStrictChunks(['原始 https://archi']), '原始 ')
})

// 以下涵蓋 scanAudreySkillCitations 的規格表。舊的字元狀態機在放棄解析時，
// 會把「打破解析的那個字元」連同已累積內容一起當純文字吐出而不重新分派，
// 導致 h / 超長引註 / 網址後緊接引註三處各自吞掉引註。

const SPEC: Array<[input: string, expected: string]> = [
  ['有效 [1] 結束', '有效 [^1] 結束'],
  ['越界 [9] 結束', '越界  結束'],
  ['假章節 [63852758] 結束', '假章節  結束'],
  ['合併 [1,2] 結束', '合併 [^1], [^2] 結束'],
  ['非數字 [備註] 結束', '非數字 [備註] 結束'],
  ['連結 [1](https://archive.tw/2026-05-28-demo#s63852758) 結束', '連結 [^1] 結束'],
  ['連結 [9](https://archive.tw/2026-05-28-demo#s63852758) 結束', '連結  結束'],
  ['連結 [文字](https://archive.tw/2026-05-28-demo#s63852758) 結束', '連結 文字 結束'],
  ['裸網址 https://archive.tw/2026-05-28-demo#s63852758 結束', '裸網址  結束'],
  // 字母 h 之後的引註（tech / research / approach / which / health…）
  ['Taiwan civic tech[1] shows this.', 'Taiwan civic tech[^1] shows this.'],
  ['Recent research[2] shows this.', 'Recent research[^2] shows this.'],
  ['both[1] and such[2] and which[1] and health[2]', 'both[^1] and such[^2] and which[^1] and health[^2]'],
  ['這是 approach[1] 的做法。', '這是 approach[^1] 的做法。'],
  // h 開頭但前綴比對失敗，後續字元必須重新分派，否則整條網址外洩
  ['Xhhttps://archive.tw/a-talk#s1 end', 'Xh end'],
  // 網址後緊接引註：`[` 不該被吃進網址，也不該留下孤兒 `]`
  ['見 https://archive.tw/a-talk#s1[1] 結束', '見 [^1] 結束'],
  // 方括號內夾帶裸網址：先剝網址再判定，剝完是編號就當引註
  ['參見 [https://archive.tw/2026-05-28-demo#s63852758] 這段', '參見 [] 這段'],
  ['參見 [出處 https://archive.tw/2026-05-28-demo#s63852758] 這段', '參見 [出處 ] 這段'],
  ['參見 [1https://archive.tw/2026-05-28-demo#s63852758] 這段', '參見 [^1] 這段'],
  // 未閉合的 `[` 不是引註：內文要重新掃描，裸網址照樣剝除
  ['[參見 https://archive.tw/2026-05-28-demo#s63852758 之後', '[參見  之後'],
  // 未閉合的 `[` 不得吞掉後面真正的引註
  ['[前綴 [1] 後綴', '[前綴 [^1] 後綴'],
  // 尾端剛好停在 `(`：還不算 archive 連結，方括號與括號都要留著
  ['[備註](', '[備註]('],
  // 尾端是被截斷的 archive 連結：引註保留，網址整段丟棄
  ['引用 [1](https://archi', '引用 [^1]'],
  // 刪除縫隙：假引註被刪掉後，前後文字貼在一起會組成新的引註，必須重掃
  ['前 [[63852758]1] 後', '前 [^1] 後'],
  ['前 [[9]1,2] 後', '前 [^1], [^2] 後'],
  // 刪除縫隙（網址）：`https:` 與 `//archive.tw/…` 中間夾著被刪掉的假引註
  ['前 https:[63852758]//archive.tw/abc 後', '前  後'],
  // 刪除縫隙（連結）：網址被丟棄後尾端露出未收完的 `[](https://`
  ['前[](https://https://archive.tw/abc', '前'],
]

test('audreySkillCitationFootnotes follows the citation spec', async () => {
  for (const [input, expected] of SPEC) {
    const output = await renderStrictChunks([input])
    assert.equal(output.split('\n\n[^')[0], expected, `串流：${input}`)
  }
})

test('renderAudreySkillMarkdown follows the same citation spec as the stream', () => {
  for (const [input, expected] of SPEC) {
    const rendered = renderAudreySkillMarkdown(input, sources)
    assert.equal(rendered.split('\n\n[^')[0], expected, `批次：${input}`)
  }
})

test('audreySkillCitationFootnotes output is independent of chunk boundaries', async () => {
  for (const [input] of SPEC) {
    const batch = renderAudreySkillMarkdown(input, sources).trim()
    for (let split = 1; split < input.length; split += 1) {
      const streamed = await renderStrictChunks([input.slice(0, split), input.slice(split)])
      assert.equal(
        streamed.trim(),
        batch,
        `切點 ${split}／${input.length}：${JSON.stringify(input)}`,
      )
    }
  }
})

test('audreySkillCitationFootnotes keeps every construct bounded', async () => {
  // 引註內容超過 64 字元：不是引註，原樣保留，且不得吞掉後面真正的引註
  const overlong = `[${'x'.repeat(70)}] 之後 [1]`
  assert.equal(
    (await renderStrictChunks([overlong])).split('\n\n[^')[0],
    `[${'x'.repeat(70)}] 之後 [^1]`,
  )

  // 網址主體超過 512 字元：比對在上限處停止，不會無限緩衝，網域也不外洩
  const overlongUrl = `前 https://archive.tw/${'a'.repeat(600)} 後`
  const rendered = (await renderStrictChunks([overlongUrl])).split('\n\n[^')[0]!
  assert.doesNotMatch(rendered, /archive\.tw/)
  assert.match(rendered, /^前 /)

  // 病態輸入：刪除後不斷露出新構造。回收重掃有級聯上限，必須能收斂
  for (const pathological of [
    '['.repeat(1000),
    'https://'.repeat(500),
    '[[63852758]1]'.repeat(300),
    '[](https://'.repeat(300),
  ]) {
    const chunks: string[] = []
    for (let i = 0; i < pathological.length; i += 7) chunks.push(pathological.slice(i, i + 7))
    const out = await renderStrictChunks(chunks)
    assert.doesNotMatch(out.split('\n\n[^')[0]!, /archive\.tw/)
  }
})

// ---------------------------------------------------------------------------
// 差分測試：拿一份「刻意用不同策略、獨立寫成」的實作當 oracle。
// 單一交替式 regex + 一次全域 replace，由 regex 引擎負責左至右掃描，
// 沒有游標、沒有狀態、沒有 partial 處理。手寫掃描器必須與它逐字相同。
// ---------------------------------------------------------------------------
const ORACLE_RAW_URL = 'https:\\/\\/archive\\.tw\\/[^\\s)[\\]，。,.；;！？!?]{0,512}'
const ORACLE_ALL = new RegExp(
  [
    `\\[([^\\][]{0,64})\\]\\(https:\\/\\/archive\\.tw\\/[^\\s)]{0,512}\\)`,
    `\\[([^\\][]{0,64})\\]`,
    ORACLE_RAW_URL,
  ].join('|'),
  'g',
)

const ARCHIVE_PREFIX = 'https://archive.tw/'

function oracle(input: string, all: CagSource[]): string {
  const used = new Set<number>()
  const render = (body: string, link: boolean) => {
    const safe = body.replace(new RegExp(ORACLE_RAW_URL, 'g'), '')
    if (!/^\d+(?:\s*,\s*\d+)*$/.test(safe.trim())) return link ? safe : `[${safe}]`
    const kept: string[] = []
    for (const part of safe.trim().split(',')) {
      const index = Number(part.trim())
      if (Number.isInteger(index) && index >= 1 && index <= all.length) {
        kept.push(`[^${index}]`)
        used.add(index)
      }
    }
    return kept.join(', ')
  }
  /** 收尾規則（獨立實作）：最左邊「一路開到結尾」的構造就地結算。 */
  const resolveTail = (source: string): { head: string; tail: string } => {
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i]
      if (char !== '[' && char !== 'h') continue
      const rest = source.slice(i)

      if (char === '[') {
        const unclosed = /^\[([^\][]{0,64})$/.exec(rest)
        if (unclosed) {
          // 編號 → 整段丟棄；非編號 → `[` 當普通文字，內文繼續往後找
          if (/^\d+(?:\s*,\s*\d+)*$/.test(unclosed[1]!.trim())) {
            return { head: source.slice(0, i), tail: '' }
          }
          continue
        }
        const link = /^\[([^\][]{0,64})\]\(([^)]*)$/.exec(rest)
        if (!link) continue
        const url = link[2]!
        const open =
          url.length < ARCHIVE_PREFIX.length
            ? ARCHIVE_PREFIX.startsWith(url)
            : url.startsWith(ARCHIVE_PREFIX) && !/[\s)]/.test(url.slice(ARCHIVE_PREFIX.length))
        if (!open) continue
        const isLink = url.length >= 'https://'.length
        return {
          head: source.slice(0, i),
          tail: render(link[1]!, isLink) + (isLink ? '' : `(${url}`),
        }
      }

      // 尾端是 archive 網址的真前綴：`https://` 以上長度丟棄，較短則保留。
      // 帶完整前綴、一路開到結尾的網址不必在此處理 —— 掃描器視為未完成而丟棄，
      // 改寫階段則是比對後刪除，結果相同。
      if (
        rest.length < ARCHIVE_PREFIX.length &&
        ARCHIVE_PREFIX.startsWith(rest) &&
        rest.length >= 'https://'.length
      ) {
        return { head: source.slice(0, i), tail: '' }
      }
    }
    return { head: source, tail: '' }
  }

  // 規格：輸出是「收尾規則 + 改寫」的不動點。刪除會讓前後文字貼在一起組成新
  // 的構造，重掃到結尾時又可能再觸發一次收尾規則，因此要反覆做到收斂。
  let s = input
  let suffix = ''
  for (let round = 0; round < 256; round += 1) {
    const before = s
    const resolved = resolveTail(s)
    // 收尾規則產生了輸出（未收完的 `(archive 網址`）：掃描器到此結束
    const stop = resolved.tail !== ''
    suffix = resolved.tail + suffix
    s = resolved.head.replace(ORACLE_ALL, (_m, linkBody?: string, citeBody?: string) => {
      if (linkBody !== undefined) return render(linkBody, true)
      if (citeBody !== undefined) return render(citeBody, false)
      return ''
    })
    if (stop || s === before) break
  }
  const text = (s + suffix).trim()
  const indexes = [...used].sort((a, b) => a - b)
  if (indexes.length === 0) return text
  const notes = indexes.map((i) => `[^${i}]: [${all[i - 1]!.label}](${all[i - 1]!.href})`)
  return `${text}\n\n${notes.join('\n')}\n`
}

test('audreySkillCitationFootnotes matches an independently written oracle', async () => {
  // mulberry32，固定種子；片段刻意選在解析邊界上
  let seed = 20260804
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const fragments = [
    '[', ']', '(', ')', '1', '2', '3', '9', '63852758', ',',
    'h', 'ht', 'https:', 'https://', 'https://archive.tw/', 'a-talk#s1',
    'tech', 'research', 'x', ' ', '，', '。', '.', '\n',
  ]

  let compared = 0
  for (let round = 0; round < 2000; round += 1) {
    const parts: string[] = []
    for (let i = 1 + Math.floor(next() * 12); i > 0; i -= 1) {
      parts.push(fragments[Math.floor(next() * fragments.length)]!)
    }
    const input = parts.join('')
    const streamed = await renderStrictChunks([input])

    assert.equal(renderAudreySkillMarkdown(input, sources), oracle(input, sources), input)
    compared += 1

    // 安全不變式：任何輸入、任何切點都必須成立
    const cut = 1 + Math.floor(next() * Math.max(1, input.length - 1))
    assert.equal(
      await renderStrictChunks([input.slice(0, cut), input.slice(cut)]),
      streamed,
      `切點 ${cut}：${input}`,
    )
    const body = streamed.split('\n\n[^')[0]!
    assert.doesNotMatch(body, /archive\.tw/, `網址外洩：${input}`)
    assert.doesNotMatch(body, /\[[12]\]/, `殘留裸引註：${input}`)
  }
  assert.equal(compared, 2000, '每一筆都必須與 oracle 逐字比對，不得跳過')
})
