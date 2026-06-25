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
