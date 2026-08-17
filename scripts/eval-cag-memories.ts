/**
 * Local CAG-memory eval: recall → CagSource[] → buildCagMessages.
 * Does not call resolveCagSources / generateCagAnswer / Cloudflare / mnemon.
 * Does not value-import src/utils/cag.ts (that pulls @au/cf-ai-gateway).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/eval-cag-memories.ts --store A --store B --query "..." --no-llm
 */
import path from 'node:path'

import type { CagSource } from '../src/utils/cag'
import {
  loadCagStore,
  loadEmbeddingsJsonl,
  LOCAL_CHAT_MODEL,
  LOCAL_CHAT_URL,
  memoriesToCagSources,
  mergeCagStores,
  mergeEmbeddings,
  recall,
  recallHybrid,
} from '../src/utils/cagMemories'

type Cli = {
  stores: string[]
  query: string
  noLlm: boolean
  generate: boolean
  later: boolean
}

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    stores: [],
    query: '',
    noLlm: false,
    generate: false,
    later: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--no-llm') cli.noLlm = true
    else if (a === '--later') cli.later = true
    else if (a === '--generate') cli.generate = true
    else if (a === '--store') {
      const dir = argv[++i]
      if (dir) cli.stores.push(path.resolve(dir))
    }
    else if (a === '--query') cli.query = argv[++i] ?? ''
  }
  if (cli.stores.length === 0) cli.stores.push(path.resolve('local/cag-memories'))
  return cli
}

function htmlToPlainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
}

function sourceBlock(
  source: CagSource,
  options: { id?: number; tag: 'source' | 'background_source' },
): string {
  const content = htmlToPlainText(source.content)
  const attrs = options.id === undefined ? '' : ` id="${options.id}"`
  return [
    `<${options.tag}${attrs}>`,
    '```text',
    content,
    '```',
    `</${options.tag}>`,
  ].join('\n')
}

/** Local copy of src/utils/cag.ts:215-270 — no value import from cag.ts. */
function buildCagMessages(
  question: string,
  sources: CagSource[],
  background: CagSource[] = [],
  answerInstruction = 'Answer concisely. Prefer exact wording from the excerpts where useful.',
  answerLanguage?: 'en',
): ChatMessage[] {
  const lore = sources
    .map((source, index) => sourceBlock(source, {
      id: index + 1,
      tag: 'source',
    }))
    .join('\n\n')

  const backgroundText = background
    .map((source) => sourceBlock(source, { tag: 'background_source' }))
    .join('\n\n')

  const systemLines = [
    'You answer questions using only the SayIt transcript excerpts supplied by the user.',
    'Treat every <source> and <background_source> as an independent excerpt that may come from a different article, interview, date, or speaker.',
    'Do not merge adjacent sources into one continuous transcript and do not infer continuity across source boundaries.',
    'Do not invent details outside the excerpts.',
    'When stating a concrete fact, cite a numbered source from <lore> as [1], [2], etc.',
    'If the excerpts do not support an answer, say so clearly.',
    'Cite the section that directly supports each claim.',
    'When sources are unrelated, analyze them separately instead of forcing a single combined narrative.',
  ]
  if (background.length > 0) {
    systemLines.push(
      'The <background> block is unnumbered context to help you understand the topic;',
      'use it to inform your answer but never cite it and never invent source numbers for it.',
    )
  }
  if (answerLanguage === 'en') {
    systemLines.push(
      'Answer in English, even when the excerpts are in Chinese — translate the material you use into English and keep the numeric citation markers.',
    )
  } else {
    systemLines.push(
      'Use Traditional Chinese when the user asks in Chinese or includes #zh-tw.',
    )
  }

  const userLines = ['<lore>', lore, '</lore>']
  if (background.length > 0) {
    userLines.push('', '<background>', backgroundText, '</background>')
  }
  userLines.push('', `Question: ${question}`, '', answerInstruction)

  return [
    { role: 'system', content: systemLines.join(' ') },
    { role: 'user', content: userLines.join('\n') },
  ]
}

function charCount(messages: Array<{ content: string }>): number {
  return messages.reduce((n, m) => n + m.content.length, 0)
}

async function generate(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch(LOCAL_CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_CHAT_MODEL,
      temperature: 0,
      messages,
    }),
  })
  if (!res.ok) throw new Error(`generate ${res.status} ${await res.text()}`)
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return body.choices?.[0]?.message?.content ?? ''
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  if (!cli.query) {
    console.error('usage: eval-cag-memories.ts --store A --store B --query TEXT [--no-llm] [--later] [--generate]')
    process.exit(1)
  }
  console.log(`--store ${cli.stores.join(' --store ')}`)
  const store = mergeCagStores(cli.stores.map((dir) => loadCagStore(dir)))
  const embeddings = mergeEmbeddings(cli.stores.map((dir) => loadEmbeddingsJsonl(dir)))
  const later = cli.later || /後來|之后|之後|later/i.test(cli.query)
  const hit = cli.noLlm
    ? recall(cli.query, store, { noLlm: true, later })
    : await recallHybrid(cli.query, store, embeddings, { noLlm: false, later })

  console.log(`recalled ${hit.memories.length} memories for ${JSON.stringify(cli.query)}`)
  for (const mem of hit.memories) {
    console.log(JSON.stringify({
      id: mem.id,
      roomId: mem.roomId,
      phase: mem.phase,
      category: mem.category,
      score: mem.score,
      content: mem.content,
      quotes: mem.evidence.map((e) => e.quote),
    }, null, 2))
  }

  const titleByRoom: Record<string, string> = {}
  for (const mem of hit.memories) {
    titleByRoom[mem.roomId] ??= mem.roomId.replace(/\.md$/, '')
  }
  const { cited, background } = memoriesToCagSources(hit.memories, titleByRoom)
  const citedSources: CagSource[] = cited
  const messages = buildCagMessages(
    cli.query,
    citedSources,
    background,
    'Answer concisely. Prefer exact wording from the excerpts where useful.',
  )
  const chars = charCount(messages)
  console.log('\n--- buildCagMessages preview ---')
  console.log(JSON.stringify(messages, null, 2))
  console.log(`\nmessage chars: ${chars} (~${Math.ceil(chars / 4)} tokens-ish)`)
  console.log(`cited: ${cited.length}  background: ${background.length}`)

  if (cli.generate) {
    const answer = await generate(messages)
    console.log('\n--- generate (deepseek-v4-flash) ---')
    console.log(answer)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
