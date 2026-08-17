/**
 * Report citation-grade provenance on a resolved CAG memory store.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/report-citability.ts \
 *     --store /tmp/cag-memories-full105-resolved \
 *     --cache /tmp/cag-archive-sections-cache/index.json
 *
 * Does not mutate the store. Does not value-import src/utils/cag.ts.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  archiveSectionHref,
  filenameFromRoomId,
  isVerbatimMemory,
  loadCagStore,
  memoriesToCagSources,
  type CagEvidence,
  type CagMemory,
} from '../src/utils/cagMemories'

type Cli = {
  store: string
  cache: string
  sample: number
  live: number
}

type RoomCache = {
  status: number
  error?: string | null
  n?: number
  payload?: unknown
}

type MissReason =
  | 'room_404'
  | 'room_fetch_error'
  | 'no_evidence'
  | 'quote_empty'
  | 'quote_truncated_mid_tag'
  | 'quote_not_found'

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    store: path.resolve('/tmp/cag-memories-full105-resolved'),
    cache: path.resolve('/tmp/cag-archive-sections-cache/index.json'),
    sample: 20,
    live: 5,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--store') cli.store = path.resolve(argv[++i] ?? cli.store)
    else if (a === '--cache') cli.cache = path.resolve(argv[++i] ?? cli.cache)
    else if (a === '--sample') cli.sample = Number(argv[++i] ?? cli.sample)
    else if (a === '--live') cli.live = Number(argv[++i] ?? cli.live)
  }
  return cli
}

function loadRoomCache(file: string): Map<string, RoomCache> {
  const map = new Map<string, RoomCache>()
  if (!existsSync(file)) return map
  const rec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, RoomCache>
  for (const [k, v] of Object.entries(rec)) map.set(k, v)
  return map
}

function numericSectionId(ev: CagEvidence): number | null {
  return typeof ev.sectionId === 'number' && Number.isFinite(ev.sectionId) ? ev.sectionId : null
}

function firstNumericSectionId(mem: CagMemory): number | null {
  for (const ev of mem.evidence) {
    const id = numericSectionId(ev)
    if (id != null) return id
  }
  return null
}

function looksTruncatedMidTag(quote: string): boolean {
  const q = quote.trim()
  if (!q) return false
  if (/^<(iframe|div|span|p|br|img|script|section)\b/i.test(q)) return true
  const opens = (q.match(/</g) ?? []).length
  const closes = (q.match(/>/g) ?? []).length
  if (opens > closes) return true
  if (/<[a-zA-Z][^>]*$/.test(q)) return true
  return false
}

function classifyMiss(mem: CagMemory, room: RoomCache | undefined): MissReason {
  if (room && room.status === 404) return 'room_404'
  if (room && room.status !== 200) return 'room_fetch_error'
  if (mem.evidence.length === 0) return 'no_evidence'
  const quote = mem.evidence.map((e) => e.quote).join('').trim()
  if (!quote) return 'quote_empty'
  if (mem.evidence.some((e) => looksTruncatedMidTag(e.quote))) return 'quote_truncated_mid_tag'
  return 'quote_not_found'
}

function clip(s: string, n = 72): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

function hrefShapeOk(href: string, filename: string, sectionId: number): boolean {
  const expected = archiveSectionHref(filename, sectionId)
  if (href !== expected) return false
  return /^https:\/\/archive\.tw\/.+#s\d+$/.test(href)
}

async function liveCheck(filename: string, sectionId: number): Promise<{ href: string; pageStatus: number; apiHasSection: boolean }> {
  const href = archiveSectionHref(filename, sectionId)
  const pageUrl = `https://archive.tw/${encodeURIComponent(filename)}`
  const apiUrl = `https://archive.tw/api/speech/${encodeURIComponent(filename)}`
  let pageStatus = 0
  try {
    const res = await fetch(pageUrl, { method: 'GET', redirect: 'follow' })
    pageStatus = res.status
  } catch {
    pageStatus = 0
  }
  let apiHasSection = false
  try {
    const res = await fetch(apiUrl)
    if (res.ok) {
      const payload = (await res.json()) as Array<{ section_id?: number }>
      apiHasSection = Array.isArray(payload) && payload.some((s) => s.section_id === sectionId)
    }
  } catch {
    apiHasSection = false
  }
  return { href, pageStatus, apiHasSection }
}

function mainSync(cli: Cli): {
  memories: CagMemory[]
  cache: Map<string, RoomCache>
  withSectionId: CagMemory[]
  citable: CagMemory[]
  roomsAttempted: string[]
  rooms404: string[]
  roomsResolved: string[]
  distinctIds: Set<number>
  missByReason: Map<MissReason, CagMemory[]>
  verbatimCount: number
  citedViaHelper: number
} {
  const store = loadCagStore(cli.store)
  const cache = loadRoomCache(cli.cache)
  const memories = store.memories
  const withSectionId: CagMemory[] = []
  const citable: CagMemory[] = []
  const distinctIds = new Set<number>()
  const roomsWithHit = new Set<string>()
  const roomsAttempted = new Set<string>()
  const missByReason = new Map<MissReason, CagMemory[]>()
  let verbatimCount = 0

  for (const mem of memories) {
    const filename = filenameFromRoomId(mem.roomId)
    roomsAttempted.add(filename)
    if (isVerbatimMemory(mem)) verbatimCount++
    const sid = firstNumericSectionId(mem)
    if (sid != null) {
      withSectionId.push(mem)
      distinctIds.add(sid)
      roomsWithHit.add(filename)
    } else {
      const reason = classifyMiss(mem, cache.get(filename))
      const bucket = missByReason.get(reason) ?? []
      bucket.push(mem)
      missByReason.set(reason, bucket)
    }
    if (mem.phase === 'audrey' && sid != null && isVerbatimMemory(mem)) citable.push(mem)
  }

  const rooms404 = [...roomsAttempted].filter((fn) => cache.get(fn)?.status === 404).sort()
  const { cited } = memoriesToCagSources(memories)

  return {
    memories,
    cache,
    withSectionId,
    citable,
    roomsAttempted: [...roomsAttempted].sort(),
    rooms404,
    roomsResolved: [...roomsWithHit].sort(),
    distinctIds,
    missByReason,
    verbatimCount,
    citedViaHelper: cited.length,
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  if (!existsSync(path.join(cli.store, 'memories.jsonl'))) {
    console.error(`no memories.jsonl in ${cli.store}`)
    process.exit(1)
  }
  const r = mainSync(cli)
  const total = r.memories.length
  const denom12868 = 12868
  const citablePct = total ? (100 * r.citable.length) / total : 0
  const citablePct12868 = (100 * r.citable.length) / denom12868
  const observerWithId = r.withSectionId.filter((m) => m.phase !== 'audrey').length

  console.log('=== citability report ===')
  console.log(`store                 ${cli.store}`)
  console.log(`total memories        ${total}`)
  console.log(`verbatim (no #llm#)   ${r.verbatimCount}/${total}  (heuristic extractKeys throughout)`)
  console.log(`phase audrey/observer ${r.memories.filter((m) => m.phase === 'audrey').length}/${r.memories.filter((m) => m.phase === 'observer').length}`)
  console.log(`memories w/ sectionId ${r.withSectionId.length}  (observer-with-id ${observerWithId})`)
  console.log(`distinct section_ids  ${r.distinctIds.size}`)
  console.log(`rooms attempted       ${r.roomsAttempted.length}`)
  console.log(`rooms API 200         ${r.roomsAttempted.length - r.rooms404.length}`)
  console.log(`rooms API 404         ${r.rooms404.length}`)
  console.log(`rooms resolved (hit)  ${r.roomsResolved.length}`)
  console.log(`citable (audrey ∧ sectionId ∧ verbatim)  ${r.citable.length}`)
  console.log(`citable fraction      ${citablePct.toFixed(1)}% of ${total}`)
  console.log(`citable vs 12,868     ${citablePct12868.toFixed(1)}%  (${r.citable.length}/${denom12868})`)
  console.log(`memoriesToCagSources cited  ${r.citedViaHelper}  (must equal citable)`)

  console.log('\n=== rooms 404 (join-key coverage) ===')
  for (const fn of r.rooms404) console.log(`  404  ${fn}`)

  console.log('\n=== miss reasons (memories with no numeric sectionId) ===')
  const order: MissReason[] = [
    'room_404',
    'room_fetch_error',
    'no_evidence',
    'quote_empty',
    'quote_truncated_mid_tag',
    'quote_not_found',
  ]
  for (const reason of order) {
    const items = r.missByReason.get(reason) ?? []
    if (!items.length) continue
    console.log(`\n${reason}: ${items.length}`)
    for (const mem of items.slice(0, 3)) {
      const q = mem.evidence[0]?.quote ?? ''
      console.log(`  - ${mem.extractKey}  ${clip(q)}`)
    }
  }

  const byRoom = new Map<string, CagMemory[]>()
  for (const mem of r.citable) {
    const list = byRoom.get(mem.roomId) ?? []
    list.push(mem)
    byRoom.set(mem.roomId, list)
  }
  const sample: CagMemory[] = []
  const roomLists = [...byRoom.values()]
  let round = 0
  while (sample.length < cli.sample && roomLists.some((list) => list.length > round)) {
    for (const list of roomLists) {
      if (sample.length >= cli.sample) break
      const mem = list[round]
      if (mem) sample.push(mem)
    }
    round++
  }
  console.log(`\n=== ${sample.length} href shape checks (archiveSectionHref) ===`)
  let shapeOk = 0
  for (const mem of sample) {
    const sid = firstNumericSectionId(mem)
    if (sid == null) continue
    const filename = filenameFromRoomId(mem.roomId)
    const href = archiveSectionHref(filename, sid)
    const ok = hrefShapeOk(href, filename, sid)
    if (ok) shapeOk++
    console.log(`  ${ok ? 'OK' : 'BAD'}  ${href}`)
  }
  console.log(`shape-valid ${shapeOk}/${sample.length}`)

  const liveN = Math.min(cli.live, sample.length)
  console.log(`\n=== ${liveN} live href checks (page GET + API section_id) ===`)
  for (const mem of sample.slice(0, liveN)) {
    const sid = firstNumericSectionId(mem)!
    const filename = filenameFromRoomId(mem.roomId)
    const check = await liveCheck(filename, sid)
    console.log(
      `  page=${check.pageStatus} api_has_section=${check.apiHasSection}  ${check.href}`,
    )
    await new Promise((res) => setTimeout(res, 200))
  }

  const missTotal = [...r.missByReason.values()].reduce((n, a) => n + a.length, 0)
  const dominant = [...r.missByReason.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  const blocker = dominant
    ? dominant[0] === 'room_404'
      ? `archive.tw 404 on transcript-basename join key (${r.rooms404.length}/${r.roomsAttempted.length} rooms, ${dominant[1].length} memories)`
      : `${dominant[0]} (${dominant[1].length} memories)`
    : 'none'
  console.log('\n=== verdict ===')
  console.log(
    `${citablePct.toFixed(1)}% of the claim index (${r.citable.length}/${total}) is citation-grade today; dominant blocker for the rest is ${blocker}.`,
  )
  console.log(`non-citable ${total - r.citable.length} = no-sectionId ${missTotal} + observer-with-id ${observerWithId}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
