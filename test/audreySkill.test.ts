import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUDREY_SKILL_DEFAULT_MODEL,
  AUDREY_SKILL_DS4_FLASH_MODEL,
  AUDREY_SKILL_FUGU_MODEL,
  AUDREY_SKILL_NEMOTRON_ULTRA_MODEL,
  AUDREY_SKILL_GLM_52_MODEL,
  audreySkillCitationFootnotes,
  buildAudreySkillAnswerInstruction,
  renderAudreySkillMarkdown,
  resolveAudreySkillModel,
} from '../src/utils/audreySkill'
import { estimateCagRequestCostUsd } from '../src/utils/cagEval'
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

// DS4 Flash runs on the Workers AI binding, so /au needs no gateway token on
// this path; a near-miss id must still fall back rather than reach ai.run.
test('resolveAudreySkillModel allows deepseek-v4-flash-0731 but not lookalikes', () => {
  assert.equal(
    resolveAudreySkillModel(AUDREY_SKILL_DS4_FLASH_MODEL),
    AUDREY_SKILL_DS4_FLASH_MODEL,
  )
  assert.equal(AUDREY_SKILL_DS4_FLASH_MODEL, '@cf/deepseek-ai/deepseek-v4-flash-0731')
  assert.equal(
    resolveAudreySkillModel('@cf/deepseek-ai/deepseek-v4-pro-0813'),
    AUDREY_SKILL_DEFAULT_MODEL,
  )
  assert.equal(
    resolveAudreySkillModel('deepseek-v4-flash'),
    AUDREY_SKILL_DEFAULT_MODEL,
  )
})

// /au/status reported estimatedCostPerRequestUsd: null before DS4 and nemotron
// had pricing rows; keep the cost estimate observable for both.
test('estimateCagRequestCostUsd covers the /au models', () => {
  const ds4 = estimateCagRequestCostUsd(AUDREY_SKILL_DS4_FLASH_MODEL)
  const nemotron = estimateCagRequestCostUsd(AUDREY_SKILL_NEMOTRON_ULTRA_MODEL)
  assert.ok(ds4 !== null && nemotron !== null)
  assert.ok(Math.abs(ds4 - 0.002376) < 1e-9, `ds4 estimate was ${ds4}`)
  assert.ok(Math.abs(nemotron - 0.00342) < 1e-9, `nemotron estimate was ${nemotron}`)
  // DS4 on the Workers AI binding is the cheaper of the two /au gateway options.
  assert.ok(ds4 < nemotron)
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

test('audreySkillCitationFootnotes handles citations immediately after h', async () => {
  const input = 'Taiwan civic tech[1] builds on research[2].'
  const output = await renderStrictChunks([...input])

  assert.match(output, /tech\[\^1\]/)
  assert.match(output, /research\[\^2\]/)
  assert.doesNotMatch(output, /tech\[1\]|research\[2\]/)
  assert.match(output, /\[\^1\]:/)
  assert.match(output, /\[\^2\]:/)
})

test('audreySkillCitationFootnotes strips archive URLs after a non-URL h', async () => {
  const input = 'Prefix hhttps://archive.tw/2026-05-28-demo#s63852758。'

  assert.equal(await renderStrictChunks([...input]), 'Prefix h。')
})

test('Audrey citation renderers handle redispatch and nested archive URL cases', async () => {
  const longPrefix = 'x'.repeat(65)
  const cases: Array<[input: string, expected: string]> = [
    [`[${longPrefix}[1] 後續`, `[${longPrefix}[^1] 後續`],
    ['見 https://archive.tw/a-talk#s1[1] 結束', '見 [^1] 結束'],
    ['參見 [https://archive.tw/a-talk#s1] 這段', '參見 [] 這段'],
    ['[參見 https://archive.tw/a-talk#s1 之後', '[參見  之後'],
    ['前 [[63852758]1] 後', '前 [^1] 後'],
    ['有效 [1](https://archive.tw/a-talk#s1) 結束', '有效 [^1] 結束'],
  ]

  for (const [input, expected] of cases) {
    const renderedBody = renderAudreySkillMarkdown(input, sources).split('\n\n[^')[0]!

    assert.equal(renderedBody, expected, `rendered: ${input}`)
    assert.doesNotMatch(renderedBody, /https:\/\/archive\.tw\//)

    const chunkings = [[input], [...input]]
    for (let split = 1; split < input.length; split += 1) {
      chunkings.push([input.slice(0, split), input.slice(split)])
    }
    for (const chunks of chunkings) {
      const streamed = await renderStrictChunks(chunks)
      const streamedBody = streamed.split('\n\n[^')[0]!

      assert.equal(streamedBody, expected, `streamed ${JSON.stringify(chunks)}: ${input}`)
      assert.doesNotMatch(streamedBody, /https:\/\/archive\.tw\//)
      if (expected.includes('[^1]')) assert.match(streamed, /\n\n\[\^1\]:/)
    }
  }
})

test('Audrey citation streaming is chunk-independent for malformed combinations', async () => {
  let seed = 63
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x1_0000_0000
  }
  const fragments = [
    '[',
    ']',
    '(',
    ')',
    '1',
    '2',
    '9',
    '63852758',
    ',',
    'h',
    'https://archive.tw/',
    'HTTPS://ARCHIVE.TW/',
    'a-talk#s1',
    'tech',
    '文字',
    ' ',
    '。',
  ]

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const count = 1 + Math.floor(random() * 12)
    let input = ''
    for (let index = 0; index < count; index += 1) {
      input += fragments[Math.floor(random() * fragments.length)]!
    }

    const expected = await renderStrictChunks([input])
    const chunks: string[] = []
    for (let at = 0; at < input.length;) {
      const size = 1 + Math.floor(random() * 7)
      chunks.push(input.slice(at, at + size))
      at += size
    }
    const streamed = await renderStrictChunks(chunks)
    const body = streamed.split('\n\n[^')[0]!

    assert.equal(streamed, expected, `chunking changed output: ${JSON.stringify(input)}`)
    assert.doesNotMatch(body, /https:\/\/archive\.tw\//)
    assert.doesNotMatch(body, /\[(?:1|2)\]/)
  }
})

test('Audrey citation scanner preserves non-archive links and enforces bounds', async () => {
  const body64 = 'x'.repeat(64)
  const body65 = 'y'.repeat(65)
  const input = [
    `[${body64}]`,
    `[${body65}]`,
    '[1](https://example.com/source)',
    '[1, 9]',
    'HTTPS://ARCHIVE.TW/a-talk#s1',
    '[2](HTTPS://ARCHIVE.TW/a-talk#s2)',
  ].join(' ')
  const expectedBody = [
    `[${body64}]`,
    `[${body65}]`,
    '[^1](https://example.com/source)',
    '[^1]',
    '',
    '[^2]',
  ].join(' ')

  const rendered = renderAudreySkillMarkdown(input, sources)
  const streamed = await renderStrictChunks([...input])

  assert.equal(rendered.split('\n\n[^')[0], expectedBody.trim())
  assert.equal(streamed.split('\n\n[^')[0], expectedBody)
  assert.doesNotMatch(rendered, /HTTPS:\/\/ARCHIVE\.TW\/a-talk/)
  assert.doesNotMatch(streamed, /HTTPS:\/\/ARCHIVE\.TW\/a-talk/)
  assert.match(streamed, /\[\^1\]:/)
  assert.match(streamed, /\[\^2\]:/)
})

test('audreySkillCitationFootnotes drops unfinished citations and URLs on flush', async () => {
  assert.equal(await renderStrictChunks(['開頭 [638527']), '開頭 ')
  assert.equal(await renderStrictChunks(['原始 https://archi']), '原始 ')
  assert.equal(await renderStrictChunks(['原始 HTTPS://ARCHI']), '原始 ')
})
