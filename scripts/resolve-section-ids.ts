/**
 * Resolve CagEvidence.sectionId from archive.tw (or a local sections JSON).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/resolve-section-ids.ts --store local/cag-memories --resume
 *
 * --resume  fill missing sectionIds; skip already-numeric ids
 * --force   re-resolve every evidence entry
 * without --resume/--force, a non-empty store is refused (exit 2)
 * --sections-json  local fixture (top-level array, or { [filename]: array }); no network
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  fetchArchiveSections,
  filenameFromRoomId,
  parseArchiveSpeechPayload,
  resolveSectionMatch,
  type ArchiveSection,
  type JsonlRecord,
} from '../src/utils/cagMemories'

type Cli = {
  store: string
  resume: boolean
  force: boolean
  sectionsJson?: string
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    store: path.resolve('local/cag-memories'),
    resume: false,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--resume') cli.resume = true
    else if (a === '--force') cli.force = true
    else if (a === '--store' || a === '--out-dir') cli.store = path.resolve(argv[++i] ?? cli.store)
    else if (a === '--sections-json') cli.sectionsJson = path.resolve(argv[++i] ?? '')
  }
  return cli
}

function loadSectionsFixture(file: string): { list?: ArchiveSection[]; byFilename: Map<string, ArchiveSection[]> } {
  const payload = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const byFilename = new Map<string, ArchiveSection[]>()
  if (Array.isArray(payload)) {
    return { list: parseArchiveSpeechPayload(payload), byFilename }
  }
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>
    if (Array.isArray(rec.sections)) {
      return { list: parseArchiveSpeechPayload(rec), byFilename }
    }
    for (const [key, value] of Object.entries(rec)) {
      byFilename.set(key, parseArchiveSpeechPayload(value))
    }
    return { byFilename }
  }
  throw new Error(`unrecognized --sections-json shape: ${file}`)
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const jsonlPath = path.join(cli.store, 'memories.jsonl')
  if (!existsSync(jsonlPath)) {
    console.error(`no memories.jsonl in ${cli.store}`)
    process.exit(1)
  }
  const storeExists = statSync(jsonlPath).size > 0
  if (storeExists && !cli.resume && !cli.force) {
    console.error(`refusing to wipe non-empty store ${cli.store} (use --resume or --force)`)
    process.exit(2)
  }

  const fixture = cli.sectionsJson ? loadSectionsFixture(cli.sectionsJson) : null
  const cache = new Map<string, ArchiveSection[]>()
  const lines = readFileSync(jsonlPath, 'utf8').split('\n')
  const out: string[] = []
  let resolved = 0
  let skipped = 0
  let missed = 0
  const missReasons: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as JsonlRecord
    if (rec.kind !== 'memory') {
      out.push(JSON.stringify(rec))
      continue
    }
    const filename = filenameFromRoomId(rec.roomId)
    let sections = cache.get(filename)
    if (!sections) {
      if (fixture?.byFilename.has(filename)) sections = fixture.byFilename.get(filename) ?? []
      else if (fixture?.list) sections = fixture.list
      else sections = await fetchArchiveSections(filename)
      cache.set(filename, sections)
    }
    const evidence = rec.evidence.map((ev) => {
      const already = typeof ev.sectionId === 'number' && Number.isFinite(ev.sectionId)
      if (already && cli.resume && !cli.force) {
        skipped++
        return ev
      }
      const hit = resolveSectionMatch(ev.quote, sections ?? [])
      if (!hit) {
        missed++
        const q = ev.quote.replace(/\s+/g, ' ').slice(0, 48)
        missReasons.push(`${rec.extractKey}: quote not in any section (${q}…)`)
        return { ...ev, sectionId: ev.sectionId ?? null }
      }
      resolved++
      return { ...ev, sectionId: hit.sectionId }
    })
    out.push(JSON.stringify({ ...rec, evidence }))
  }

  const tmp = `${jsonlPath}.tmp`
  writeFileSync(tmp, out.length ? `${out.join('\n')}\n` : '')
  renameSync(tmp, jsonlPath)
  console.error(`resolve ${cli.store}: resolved=${resolved} skipped=${skipped} missed=${missed}`)
  for (const reason of missReasons) console.error(`  miss ${reason}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
