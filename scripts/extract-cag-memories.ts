/**
 * Local CAG-memory extractor. JSONL under --out-dir (default local/cag-memories).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/extract-cag-memories.ts --no-llm --input <file> --max-files 1
 *
 * --resume  skip completed basenames (sha256 + phaseADone + phaseBDone).
 *           Windowed LLM: checkpoint.windowsDone is the count of completed
 *           windows. If sha256 matches and windowsDone < totalWindows, skip
 *           windows 0..windowsDone-1 and continue; do not wipe prior windows.
 *           A crash mid-file may leave uncapped window rows; --compact after
 *           a failed run is ok.
 * --force   wipe memories.jsonl + checkpoint even when the store is non-empty
 *           (without --resume/--force, a non-empty store is refused with exit 2)
 * --compact compact --out-dir and exit 0 (no extract, no wipe; works on a non-empty store without --force)
 * --timeout-ms N  LLM chat timeout in milliseconds (default 300000)
 * --speaker REGEX  LLM extract only (repeatable; joined with |). Example:
 *           --speaker '唐鳳|Audrey Tang'
 *           Heuristic --no-llm ignores --speaker (full file).
 * --cap     opt-in human digest: 1 observer + 12 audrey per room. Default off
 *           (index path keeps every claim). Does not rewrite existing stores.
 * --window-turns 3  LLM extract only. After speaker filter, consecutive groups of N
 *           turns (last group may be shorter). Default 0 = no windowing (whole
 *           filtered transcript). Heuristic --no-llm ignores --window-turns.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { glob } from 'node:fs/promises'

import {
  appendJsonl,
  capWindowedMemories,
  clampExtractImportance,
  compactCagStore,
  dropRoomFromJsonl,
  embedTexts,
  extractHeuristic,
  findSpan,
  linkNewMemories,
  loadCagStore,
  loadCheckpoint,
  LOCAL_CHAT_MODEL,
  LOCAL_CHAT_URL,
  memoryIdForExtractKey,
  isWindowTimeout,
  parseJsonArray,
  parseTranscriptMarkdown,
  sanitizeEntities,
  saveCheckpoint,
  sha256Text,
  type CagCategory,
  type CagEvidence,
  type CagLink,
  type CagMemory,
  type JsonlRecord,
  type ParsedTranscript,
} from '../src/utils/cagMemories'

type Cli = {
  input?: string
  outDir: string
  maxFiles: number
  noLlm: boolean
  resume: boolean
  force: boolean
  compact: boolean
  timeoutMs: number
  speakerRe?: RegExp
  windowTurns: number
  cap: boolean
}

function parseCli(argv: string[]): Cli {
  const speakers: string[] = []
  const cli: Cli = {
    outDir: path.resolve('local/cag-memories'),
    maxFiles: 3,
    noLlm: true,
    resume: false,
    force: false,
    compact: false,
    timeoutMs: 300_000,
    windowTurns: 0,
    cap: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--no-llm') cli.noLlm = true
    else if (a === '--llm') cli.noLlm = false
    else if (a === '--resume') cli.resume = true
    else if (a === '--force') cli.force = true
    else if (a === '--compact') cli.compact = true
    else if (a === '--input') cli.input = argv[++i]
    else if (a === '--out-dir') cli.outDir = path.resolve(argv[++i] ?? cli.outDir)
    else if (a === '--max-files') cli.maxFiles = Number(argv[++i] ?? 3) || 3
    else if (a === '--timeout-ms') cli.timeoutMs = Number(argv[++i] ?? 300_000) || 300_000
    else if (a === '--window-turns') cli.windowTurns = Math.max(0, Number(argv[++i] ?? 0) || 0)
    else if (a === '--cap') cli.cap = true
    else if (a === '--speaker') {
      const re = argv[++i]
      if (re) speakers.push(re)
    }
  }
  if (speakers.length > 0) cli.speakerRe = new RegExp(speakers.join('|'))
  return cli
}

async function resolveInputFiles(input: string | undefined, maxFiles: number): Promise<string[]> {
  const raw = input ?? path.resolve('test/fixtures/cag-memories')
  let files: string[] = []
  if (existsSync(raw) && statSync(raw).isDirectory()) {
    files = readdirSync(raw)
      .filter((n) => n.endsWith('.md'))
      .map((n) => path.join(raw, n))
  } else if (existsSync(raw) && statSync(raw).isFile()) {
    files = [raw]
  } else {
    for await (const p of glob(raw)) files.push(path.resolve(p))
  }
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'en'))
  return files.slice(0, maxFiles)
}

type LlmClaim = {
  category?: string
  importance?: number
  content?: string
  entities?: string[]
  tags?: string[]
  claimIndex?: number
  evidence?: Array<{ turnIndex: number; startChar?: number; endChar?: number; quote: string }>
}

const CAG_CATEGORIES: Record<CagCategory, true> = {
  preference: true,
  decision: true,
  insight: true,
  fact: true,
  context: true,
}

function clampCategory(category: string | undefined, phase: CagMemory['phase']): CagCategory {
  if (category && category in CAG_CATEGORIES) return category as CagCategory
  return phase === 'observer' ? 'context' : 'insight'
}

async function chat(
  messages: Array<{ role: string; content: string }>,
  timeoutMs = 300_000,
): Promise<string> {
  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : (() => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), timeoutMs)
        return controller.signal
      })()
  try {
    const res = await fetch(LOCAL_CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_CHAT_MODEL,
        temperature: 0,
        messages,
      }),
      signal,
    })
    if (!res.ok) throw new Error(`chat ${res.status} ${await res.text()}`)
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return body.choices?.[0]?.message?.content ?? ''
  } catch (err) {
    if (signal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
      throw new Error(`chat timeout after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw err
  }
}

function selectTurns(parsed: ParsedTranscript, speakerRe?: RegExp): ParsedTranscript['turns'] {
  if (!speakerRe) return parsed.turns
  const filtered = parsed.turns.filter((t) => speakerRe.test(t.speaker))
  if (filtered.length === 0) {
    console.error(`--speaker ${speakerRe} matched 0 turns; falling back to all turns`)
    return parsed.turns
  }
  return filtered
}

function partitionTurns(turns: ParsedTranscript['turns'], windowTurns: number): ParsedTranscript['turns'][] {
  if (windowTurns <= 0 || turns.length === 0) return [turns]
  const windows: ParsedTranscript['turns'][] = []
  for (let i = 0; i < turns.length; i += windowTurns) {
    windows.push(turns.slice(i, i + windowTurns))
  }
  return windows
}

function formatTranscript(parsed: ParsedTranscript, turns: ParsedTranscript['turns']): string {
  const render = (ts: typeof turns) =>
    ts.map((t, i) => `### [${t.turnIndex ?? i}] ${t.speaker}：\n${t.text}`).join('\n\n')
  return `# ${parsed.title}\n\n${render(turns)}`
}

function claimsToMemories(
  parsed: ParsedTranscript,
  phase: CagMemory['phase'],
  claims: LlmClaim[],
  windowIndex?: number,
): CagMemory[] {
  const createdAt = `${parsed.roomDate}T${new Date().toISOString().slice(11)}`
  const turnByIndex = new Map(parsed.turns.map((t) => [t.turnIndex, t]))
  const out: CagMemory[] = []
  claims.forEach((claim, i) => {
    const evIn = claim.evidence ?? []
    const evidence: CagEvidence[] = []
    for (const e of evIn) {
      const turn = turnByIndex.get(e.turnIndex)
      if (!turn) continue
      const quote = (e.quote || '').trim()
      if (!quote) continue
      const collapsedTurn = turn.text.replace(/<br\s*\/?>/gi, '').replace(/\s+/g, '')
      const collapsedQuote = quote.replace(/<br\s*\/?>/gi, '').replace(/\s+/g, '')
      const head = collapsedQuote.slice(0, Math.min(8, collapsedQuote.length))
      if (!head || !collapsedTurn.includes(head)) continue
      const span = findSpan(turn.text, quote)
      evidence.push({
        file: parsed.sourceFile,
        turnIndex: turn.turnIndex,
        speaker: turn.speaker,
        startChar: span.startChar,
        endChar: span.endChar,
        quote: span.quote.slice(0, 240),
        sectionId: null,
      })
    }
    if (evidence.length < 1 || !claim.content?.trim()) return
    const claimIndex = claim.claimIndex ?? i
    const extractKey = windowIndex === undefined
      ? `${parsed.roomId}#llm#${phase}#${claimIndex}`
      : `${parsed.roomId}#llm#${phase}#w${windowIndex}#${claimIndex}`
    const importance = clampExtractImportance(phase, claim.importance)
    out.push({
      id: memoryIdForExtractKey(extractKey),
      extractKey,
      phase,
      category: clampCategory(claim.category, phase),
      importance,
      content: claim.content.trim(),
      entities: sanitizeEntities(claim.entities ?? []),
      tags: claim.tags ?? [],
      roomId: parsed.roomId,
      roomDate: parsed.roomDate,
      sourceFile: parsed.sourceFile,
      evidence,
      createdAt,
    })
  })
  return out
}


async function extractLlmWindow(
  parsed: ParsedTranscript,
  turns: ParsedTranscript['turns'],
  timeoutMs: number,
  windowIndex?: number,
): Promise<CagMemory[]> {
  const label = windowIndex === undefined ? parsed.roomId : `${parsed.roomId} w${windowIndex}`
  const transcript = formatTranscript(parsed, turns)
  const observerUser = [
    'You are seated in this room. You do not speak. Replay start→finish.',
    'Take notes on dynamics, named costs/conditions, who actually spoke.',
    'Return a JSON array of at most 6 observer notes. Each must have category, importance (1-5), content, entities[], claimIndex, evidence[{turnIndex,quote}].',
    'Headers are ### [originalTurnIndex] Speaker. evidence.turnIndex MUST be that number.',
    'category MUST be one of preference|decision|insight|fact|context. phase is observer. Prefer category context. fact only if a speaker said it.',
    'Entities must not include 唐鳳 or Audrey Tang (speaker is on evidence).',
    'No memory without a verbatim quote from the transcript. Quote cap 240 chars.',
    '',
    transcript,
  ].join('\n')
  const observerMessages = [
    { role: 'system', content: 'Silent first-person observer in the room. JSON only.' },
    { role: 'user', content: observerUser },
  ]
  console.error(`phase A observer starting (${label}, ${turns.length} turns)`)
  let phaseAText: string
  try {
    phaseAText = await chat(observerMessages, timeoutMs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`window ${windowIndex ?? 0} phase A observer: ${msg}`)
  }
  const phaseA = claimsToMemories(parsed, 'observer', parseJsonArray(phaseAText) as LlmClaim[], windowIndex).slice(0, 6)
  console.error(`phase A done (${label}), ${phaseA.length} notes`)
  console.error(`phase B audrey starting (${label})`)

  const audreyUser = [
    'Now you are Audrey Tang, after the tape. What happened; what would you recall.',
    'Return a JSON array of at most 12 Audrey memories. category MUST be one of preference|decision|insight|fact|context.',
    'Each must cite a verbatim quote from a turn whose speaker is 唐鳳 or Audrey Tang.',
    'Entities must not include 唐鳳 or Audrey Tang (speaker is on evidence).',
    'No stance without a cited span. Quote cap 240.',
  ].join('\n')
  let phaseBText: string
  try {
    phaseBText = await chat([
      ...observerMessages,
      { role: 'assistant', content: phaseAText },
      { role: 'user', content: audreyUser },
    ], timeoutMs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`window ${windowIndex ?? 0} phase B audrey: ${msg}`)
  }
  const phaseB = claimsToMemories(parsed, 'audrey', parseJsonArray(phaseBText) as LlmClaim[], windowIndex).slice(0, 12)
  console.error(`phase B done (${label}), ${phaseB.length} memories`)
  return [...phaseA, ...phaseB]
}

async function extractLlm(
  parsed: ParsedTranscript,
  alreadyWritten: CagMemory[],
  timeoutMs: number,
  speakerRe?: RegExp,
  windowTurns = 0,
  windowOpts?: {
    startWindow?: number
    onWindow?: (w: number, memories: CagMemory[], links: CagLink[]) => void
    cap?: boolean
  },
): Promise<{ memories: CagMemory[]; links: CagLink[] }> {
  const applyCap = windowOpts?.cap === true
  const turns = selectTurns(parsed, speakerRe)
  if (windowTurns <= 0) {
    const raw = await extractLlmWindow(parsed, turns, timeoutMs)
    const memories = applyCap ? capWindowedMemories(raw) : raw
    return { memories, links: linkNewMemories(memories, alreadyWritten) }
  }
  const windows = partitionTurns(turns, windowTurns)
  const startWindow = Math.max(0, windowOpts?.startWindow ?? 0)
  console.error(`window-turns ${windowTurns}: ${turns.length} filtered turns → ${windows.length} windows (start w${startWindow})`)
  const others = alreadyWritten.filter((m) => m.roomId !== parsed.roomId)
  const collected: CagMemory[] = startWindow > 0
    ? alreadyWritten.filter((m) => m.roomId === parsed.roomId)
    : []
  for (let w = startWindow; w < windows.length; w++) {
    try {
      const windowMemories = await extractLlmWindow(parsed, windows[w] ?? [], timeoutMs, w)
      const windowLinks = linkNewMemories(windowMemories, [...others, ...collected])
      collected.push(...windowMemories)
      windowOpts?.onWindow?.(w, windowMemories, windowLinks)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isWindowTimeout(msg)) {
        console.error(`window ${w} failed, skip: ${msg}`)
        windowOpts?.onWindow?.(w, [], [])
        continue
      }
      throw err
    }
  }
  const memories = applyCap ? capWindowedMemories(collected) : collected
  if (applyCap) {
    console.error(`capped windows: ${collected.length} → ${memories.length} (observer ≤1, audrey ≤12)`)
  }
  return { memories, links: linkNewMemories(memories, others) }
}

async function maybeEmbed(outDir: string, memories: CagMemory[], noLlm: boolean): Promise<void> {
  if (noLlm || memories.length === 0) return
  const vecs = await embedTexts(memories.map((m) => m.content))
  if (!vecs) return
  const lines = memories.map((m, i) => JSON.stringify({ id: m.id, vector: vecs[i] }))
  appendFileSync(path.join(outDir, 'embeddings.jsonl'), `${lines.join('\n')}\n`)
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  if (cli.compact) {
    const result = compactCagStore(cli.outDir)
    console.error(`compacted ${cli.outDir}: ${result.memories} memories, ${result.links} links, dropped ${result.droppedMemoryDupes} memory dupes`)
    return
  }
  const files = await resolveInputFiles(cli.input, cli.maxFiles)
  if (files.length === 0) {
    console.error('no input files')
    process.exit(1)
  }
  mkdirSync(cli.outDir, { recursive: true })
  if (!cli.resume) {
    const memoriesPath = path.join(cli.outDir, 'memories.jsonl')
    const storeExists = existsSync(memoriesPath) && statSync(memoriesPath).size > 0
    if (storeExists && !cli.force) {
      console.error(`refusing to wipe non-empty store ${cli.outDir} (use --resume or --force)`)
      process.exit(2)
    }
    writeFileSync(memoriesPath, '')
    saveCheckpoint(cli.outDir, { processed: {} })
  }
  let checkpoint = loadCheckpoint(cli.outDir)
  for (const file of files) {
    const basename = path.basename(file)
    const markdown = readFileSync(file, 'utf8')
    const digest = sha256Text(markdown)
    const prior = checkpoint.processed[basename]
    if (cli.resume && prior?.sha256 === digest && prior.phaseADone && prior.phaseBDone) {
      console.error(`skip ${basename}`)
      continue
    }
    const parsed = parseTranscriptMarkdown(markdown, path.resolve(file))
    const windowedLlm = !cli.noLlm && cli.windowTurns > 0
    const totalWindows = windowedLlm
      ? partitionTurns(selectTurns(parsed, cli.speakerRe), cli.windowTurns).length
      : 0
    const priorDone = prior?.sha256 === digest ? (prior.windowsDone ?? 0) : 0
    let startWindow = 0
    if (windowedLlm && cli.resume && prior?.sha256 === digest && priorDone > 0) {
      const peek = loadCagStore(cli.outDir)
      const hasRows = peek.memories.some((m) => m.roomId === parsed.roomId)
      if (hasRows) startWindow = Math.min(priorDone, totalWindows)
    }
    if (startWindow === 0) dropRoomFromJsonl(cli.outDir, basename)
    const store = loadCagStore(cli.outDir)
    console.error(`extract ${basename} via ${cli.noLlm ? 'heuristic' : 'llm'}${windowedLlm ? ` windows ${startWindow}..${Math.max(0, totalWindows - 1)}` : ''}`)
    const extracted = cli.noLlm
      ? extractHeuristic(parsed, store.memories, { cap: cli.cap })
      : await extractLlm(
        parsed,
        store.memories,
        cli.timeoutMs,
        cli.speakerRe,
        cli.windowTurns,
        {
          cap: cli.cap,
          ...(windowedLlm
            ? {
              startWindow,
              onWindow: (w, memories, links) => {
                appendJsonl(cli.outDir, [
                  ...memories.map((m) => ({ kind: 'memory' as const, ...m })),
                  ...links.map((l) => ({ kind: 'link' as const, ...l })),
                ])
                const cp = loadCheckpoint(cli.outDir)
                const prevIds = cp.processed[basename]?.memoryIds ?? []
                cp.processed[basename] = {
                  sha256: digest,
                  memoryIds: [...prevIds, ...memories.map((m) => m.id)],
                  phaseADone: false,
                  phaseBDone: false,
                  windowsDone: w + 1,
                }
                saveCheckpoint(cli.outDir, cp)
                console.error(`checkpoint ${basename} windowsDone=${w + 1}/${totalWindows}`)
              },
            }
            : {}),
        },
      )
    if (windowedLlm) dropRoomFromJsonl(cli.outDir, parsed.roomId)
    const records: JsonlRecord[] = [
      ...extracted.memories.map((m) => ({ kind: 'memory' as const, ...m })),
      ...extracted.links.map((l) => ({ kind: 'link' as const, ...l })),
    ]
    appendJsonl(cli.outDir, records)
    await maybeEmbed(cli.outDir, extracted.memories, cli.noLlm)
    checkpoint = loadCheckpoint(cli.outDir)
    checkpoint.processed[basename] = {
      sha256: digest,
      memoryIds: extracted.memories.map((m) => m.id),
      phaseADone: true,
      phaseBDone: true,
      ...(windowedLlm ? { windowsDone: totalWindows } : {}),
    }
    saveCheckpoint(cli.outDir, checkpoint)
    console.error(`wrote ${basename}: ${extracted.memories.length} memories, ${extracted.links.length} links`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
