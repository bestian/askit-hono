/**
 * Build and embed a full section index over the 105 transcripts selected in
 * `local/cag-compare/corpus-manifest.json`.
 *
 * Local only. No Cloudflare contact of any kind.
 *
 * Usage:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/build-full-section-index.ts
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/build-full-section-index.ts --rebuild
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export const DEFAULT_MANIFEST_PATH = path.resolve('local/cag-compare/corpus-manifest.json')
export const DEFAULT_TRANSCRIPT_DIR = '/Users/au/w/transcript'
export const DEFAULT_OUT_PATH = path.resolve('local/cag-compare/sections-full.jsonl')
export const LOCAL_EMBED_URL = 'http://127.0.0.1:11434/api/embed'
export const LOCAL_EMBED_MODEL = 'qwen3-embedding:0.6b'
export const MAX_SECTION_CHARS = 175
export const DEFAULT_BATCH_SIZE = 128
export const PROGRESS_INTERVAL = 2000

export type SectionRecord = {
  section_id: number
  filename: string
  turn_index: number
  chunk_index: number
  speaker: string
  content: string
  vector: number[]
}

export type ManifestFile = {
  version?: string
  corpus?: {
    totalFiles?: number
    totalSections?: number
    files?: string[]
  }
}

export type TranscriptTurn = {
  turnIndex: number
  speaker: string
  text: string
}

export type ParsedTranscript = {
  title: string
  roomDate: string
  sourceFile: string
  roomId: string
  turns: TranscriptTurn[]
}

export function htmlToPlainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function textLength(s: string): number {
  return Array.from(s).length
}

export function chunkPlainText(plain: string, maxChars: number = MAX_SECTION_CHARS): string[] {
  const text = plain.trim()
  if (!text) return []
  if (textLength(text) <= maxChars) return [text]
  const parts = text.split(/(?<=[。！？.!?…])/u)
  const chunks: string[] = []
  let buf = ''
  const flush = () => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ''
  }
  const hardWrap = (piece: string) => {
    const chars = Array.from(piece)
    for (let i = 0; i < chars.length; ) {
      const slice = chars.slice(i, i + maxChars).join('').trim()
      if (slice) chunks.push(slice)
      i += maxChars
    }
  }
  for (const raw of parts) {
    const piece = raw.trim()
    if (!piece) continue
    const joined = buf ? `${buf}${piece}` : piece
    if (textLength(joined) <= maxChars) {
      buf = joined
      continue
    }
    flush()
    if (textLength(piece) <= maxChars) buf = piece
    else hardWrap(piece)
  }
  flush()
  return chunks
}

export function syntheticSectionId(filename: string, turnIndex: number, chunkIndex: number): number {
  const h = createHash('sha256').update(`${filename}\x00${turnIndex}\x00${chunkIndex}`).digest()
  return h.readUInt32BE(0) >>> 1
}

export function parseTranscriptMarkdown(markdown: string, sourceFile: string): ParsedTranscript {
  const roomId = path.basename(sourceFile)
  const dateMatch = roomId.match(/^(\d{4}-\d{2}-\d{2})/)
  const roomDate = dateMatch?.[1] ?? '1970-01-01'
  const titleMatch = markdown.match(/^#\s+(.+)$/m)
  const title = (titleMatch?.[1] ?? roomId).trim()
  const chunks = markdown.split(/^### /m)
  const turns: TranscriptTurn[] = []
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? ''
    const nl = chunk.indexOf('\n')
    const header = (nl === -1 ? chunk : chunk.slice(0, nl)).trim()
    const body = nl === -1 ? '' : chunk.slice(nl + 1)
    const speaker = header.replace(/[：:]\s*$/, '').trim()
    turns.push({ turnIndex: i - 1, speaker, text: body.replace(/\s+$/, '') })
  }
  return { title, roomDate, sourceFile, roomId, turns }
}

export async function confirmOllama(): Promise<void> {
  const res = await fetch('http://127.0.0.1:11434/api/tags')
  if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`)
  const body = (await res.json()) as { models?: { name?: string }[] }
  const names = (body.models ?? []).map((m) => m.name ?? '')
  if (!names.includes(LOCAL_EMBED_MODEL)) {
    throw new Error(`Ollama is up but missing tag ${LOCAL_EMBED_MODEL}. Have: ${names.join(', ')}`)
  }
  console.log(`Ollama is up at ${LOCAL_EMBED_URL}. Local tag present: ${LOCAL_EMBED_MODEL}`)
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const res = await fetch(LOCAL_EMBED_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: LOCAL_EMBED_MODEL, input: texts }),
  })
  if (!res.ok) {
    throw new Error(`Ollama embed returned HTTP ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as { embeddings?: number[][] }
  if (!body.embeddings || body.embeddings.length !== texts.length) {
    throw new Error(
      `Ollama embed returned ${body.embeddings?.length ?? 0} embeddings, expected ${texts.length}`,
    )
  }
  return body.embeddings
}

export function loadExistingSectionMap(filePath: string): Map<number, SectionRecord> {
  const map = new Map<number, SectionRecord>()
  if (!existsSync(filePath)) return map
  const raw = readFileSync(filePath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as SectionRecord
      if (
        typeof rec.section_id === 'number' &&
        typeof rec.content === 'string' &&
        Array.isArray(rec.vector) &&
        rec.vector.length === 1024
      ) {
        map.set(rec.section_id, rec)
      }
    } catch {
      // skip corrupted lines
    }
  }
  return map
}

type DraftChunk = Omit<SectionRecord, 'vector'>

export async function buildFullSectionIndex(options?: {
  manifestPath?: string
  transcriptDir?: string
  outPath?: string
  batchSize?: number
  rebuild?: boolean
}): Promise<{
  filesProcessed: number
  totalChunks: number
  maxChunkLen: number
  distinctFiles: number
  wallClockSeconds: number
  outputPath: string
}> {
  const manifestPath = options?.manifestPath ?? DEFAULT_MANIFEST_PATH
  const transcriptDir = options?.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR
  const outPath = options?.outPath ?? DEFAULT_OUT_PATH
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const rebuild = options?.rebuild ?? false

  console.log(`Reading manifest: ${manifestPath}`)
  if (!existsSync(manifestPath)) {
    throw new Error(`Corpus manifest not found: ${manifestPath}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestFile
  const fileList = manifest.corpus?.files ?? []
  if (fileList.length === 0) {
    throw new Error(`Manifest has no corpus.files: ${manifestPath}`)
  }
  console.log(`Corpus manifest specifies ${fileList.length} files.`)

  // Step 1: Resolve every file under transcriptDir. Fail loudly on missing.
  console.log(`Resolving transcripts in ${transcriptDir} (no tree walk)…`)
  const missingFiles: string[] = []
  for (const file of fileList) {
    const fullPath = path.join(transcriptDir, file)
    if (!existsSync(fullPath)) {
      missingFiles.push(file)
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `Failed to find ${missingFiles.length} transcript files under ${transcriptDir}:\n` +
        missingFiles.map((f) => `  - ${f}`).join('\n'),
    )
  }
  console.log(`All ${fileList.length} files successfully resolved.`)

  // Step 2: Parse and chunk all files
  const draftChunks: DraftChunk[] = []
  let maxChunkLen = 0
  const distinctFilesSet = new Set<string>()

  for (const file of fileList) {
    const fullPath = path.join(transcriptDir, file)
    const content = readFileSync(fullPath, 'utf8')
    const parsed = parseTranscriptMarkdown(content, fullPath)
    const filename = file.replace(/\.md$/i, '')
    distinctFilesSet.add(filename)

    for (const turn of parsed.turns) {
      const plain = htmlToPlainText(turn.text)
      const chunks = chunkPlainText(plain, MAX_SECTION_CHARS)
      for (const [chunkIndex, chunkContent] of chunks.entries()) {
        const len = textLength(chunkContent)
        if (len > maxChunkLen) maxChunkLen = len
        draftChunks.push({
          section_id: syntheticSectionId(filename, turn.turnIndex, chunkIndex),
          filename,
          turn_index: turn.turnIndex,
          chunk_index: chunkIndex,
          speaker: turn.speaker,
          content: chunkContent,
        })
      }
    }
  }

  const totalChunks = draftChunks.length
  console.log(`Drafted ${totalChunks} chunks from ${fileList.length} files. Max chunk length: ${maxChunkLen}`)

  const projectedCount = manifest.corpus?.totalSections
  if (typeof projectedCount === 'number') {
    const diff = totalChunks - projectedCount
    const pctDiff = (Math.abs(diff) / projectedCount) * 100
    console.log(
      `Manifest projected sections: ${projectedCount} (actual: ${totalChunks}, diff: ${diff > 0 ? '+' : ''}${diff}, ${pctDiff.toFixed(2)}%)`,
    )
    if (pctDiff > 20) {
      console.warn(
        `WARNING: Total chunk count differs from manifest projection by ${pctDiff.toFixed(1)}% (>20% threshold)!`,
      )
    }
  }

  // Step 3: Resumability check
  mkdirSync(path.dirname(outPath), { recursive: true })
  let existingMap = new Map<number, SectionRecord>()
  if (!rebuild && existsSync(outPath)) {
    existingMap = loadExistingSectionMap(outPath)
    console.log(`Loaded ${existingMap.size} existing embedded chunks from ${outPath}`)
  }

  // Confirm Ollama is up before embedding
  await confirmOllama()

  // Collect missing chunks to embed
  const needEmbedIndices: number[] = []
  for (let i = 0; i < draftChunks.length; i++) {
    const chunk = draftChunks[i]!
    if (!existingMap.has(chunk.section_id)) {
      needEmbedIndices.push(i)
    }
  }

  const alreadyEmbedded = draftChunks.length - needEmbedIndices.length
  console.log(
    `Already cached: ${alreadyEmbedded}/${totalChunks} chunks. Need embedding: ${needEmbedIndices.length} chunks.`,
  )

  const startTime = Date.now()
  let newlyEmbedded = 0
  let lastProgressReport = 0

  // Open / append to output file
  // If rebuilding or file did not exist, write freshly
  if (rebuild || !existsSync(outPath) || existingMap.size === 0) {
    writeFileSync(outPath, '')
  }

  // Embed in batches
  for (let offset = 0; offset < needEmbedIndices.length; offset += batchSize) {
    const sliceIndices = needEmbedIndices.slice(offset, offset + batchSize)
    const texts = sliceIndices.map((idx) => draftChunks[idx]!.content)
    const vectors = await embedBatch(texts)

    const completedRecords: SectionRecord[] = []
    for (let j = 0; j < sliceIndices.length; j++) {
      const idx = sliceIndices[j]!
      const draft = draftChunks[idx]!
      const vector = vectors[j]!
      const fullRecord: SectionRecord = { ...draft, vector }
      existingMap.set(draft.section_id, fullRecord)
      completedRecords.push(fullRecord)
    }

    // Append batch to disk
    const appendLines = completedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n'
    appendFileSync(outPath, appendLines)

    newlyEmbedded += sliceIndices.length
    const totalProcessed = alreadyEmbedded + newlyEmbedded
    if (totalProcessed - lastProgressReport >= PROGRESS_INTERVAL || totalProcessed === totalChunks) {
      const elapsedSec = (Date.now() - startTime) / 1000
      const rate = newlyEmbedded > 0 ? (newlyEmbedded / elapsedSec).toFixed(1) : '0'
      const pct = ((totalProcessed / totalChunks) * 100).toFixed(1)
      console.log(
        `Progress: ${totalProcessed}/${totalChunks} chunks (${pct}%) | newly embedded: ${newlyEmbedded} @ ${rate} chunks/sec | elapsed: ${elapsedSec.toFixed(1)}s`,
      )
      lastProgressReport = totalProcessed
    }
  }

  // If there were previously existing records not newly appended, make sure the output file contains all draftChunks in order
  // Check if output line count matches draftChunks
  const finalMap = loadExistingSectionMap(outPath)
  if (finalMap.size !== totalChunks) {
    console.log(`Writing unified ordered output file: ${outPath} (${draftChunks.length} records)…`)
    const orderedLines: string[] = []
    for (const draft of draftChunks) {
      const rec = finalMap.get(draft.section_id)
      if (!rec) {
        throw new Error(`Missing record for section_id ${draft.section_id} after embedding!`)
      }
      orderedLines.push(JSON.stringify(rec))
    }
    writeFileSync(outPath, orderedLines.join('\n') + '\n')
  }

  const wallClockSeconds = (Date.now() - startTime) / 1000
  console.log(`\n=== Section Index Build Complete ===`)
  console.log(`Output: ${outPath}`)
  console.log(`Files processed: ${fileList.length}`)
  console.log(`Distinct source files in index: ${distinctFilesSet.size}`)
  console.log(`Total chunks: ${totalChunks}`)
  console.log(`Max chunk length: ${maxChunkLen} chars (≤${MAX_SECTION_CHARS})`)
  console.log(`Wall-clock embedding time: ${wallClockSeconds.toFixed(2)}s (${(wallClockSeconds / 60).toFixed(2)}m)`)

  return {
    filesProcessed: fileList.length,
    totalChunks,
    maxChunkLen,
    distinctFiles: distinctFilesSet.size,
    wallClockSeconds,
    outputPath: outPath,
  }
}

// CLI entry point
const thisFile = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (thisFile.endsWith('build-full-section-index.ts')) {
  const args = process.argv.slice(2)
  let manifestPath = DEFAULT_MANIFEST_PATH
  let transcriptDir = DEFAULT_TRANSCRIPT_DIR
  let outPath = DEFAULT_OUT_PATH
  let batchSize = DEFAULT_BATCH_SIZE
  let rebuild = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--manifest' && args[i + 1]) {
      manifestPath = path.resolve(args[++i]!)
    } else if (a === '--transcript-dir' && args[i + 1]) {
      transcriptDir = path.resolve(args[++i]!)
    } else if (a === '--out' && args[i + 1]) {
      outPath = path.resolve(args[++i]!)
    } else if (a === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[++i]!, 10)
    } else if (a === '--rebuild') {
      rebuild = true
    }
  }

  buildFullSectionIndex({ manifestPath, transcriptDir, outPath, batchSize, rebuild })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error building full section index:', err)
      process.exit(1)
    })
}
