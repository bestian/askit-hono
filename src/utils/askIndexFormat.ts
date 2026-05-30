import Fuse, { type IFuseOptions } from 'fuse.js'

export const ASK_INDEX_VERSION = 1
export const ASK_INDEX_R2_KEY = 'ask-index/audrey-tang.json'
export const ASK_INDEX_MANIFEST_R2_KEY = 'ask-index/audrey-tang.manifest.json'

export type SectionRow = {
  filename: string
  nest_filename: string | null
  section_id: number | string
  section_speaker: string | null
  section_content: string | null
  display_name: string | null
  name: string | null
}

export type AskIndexPayload = {
  v: number
  generatedAt: string
  speakerLike: string
  rowCount: number
  rows: SectionRow[]
  /** Fuse.createIndex(...).toJSON() 結果 */
  index: unknown
}

export type AskIndexManifest = {
  v: number
  generatedAt: string
  indexKey: string
  indexSha256: string
  indexBytes: number
  speakerLike: string
  rowCount: number
  queriedRowCount: number
  maxSectionChars: number
  yearsBack: number
  cutoffDate: string
  d1Database: string
  local: boolean
}

export function manifestKeyForIndexKey(indexKey: string): string {
  if (indexKey === ASK_INDEX_R2_KEY) return ASK_INDEX_MANIFEST_R2_KEY
  return indexKey.endsWith('.json')
    ? indexKey.replace(/\.json$/, '.manifest.json')
    : `${indexKey}.manifest.json`
}

export const ASK_FUSE_OPTIONS: IFuseOptions<SectionRow> = {
  keys: ['section_content'],
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 2,
}

export function createAskFuseFromPayload(
  payload: AskIndexPayload,
): Fuse<SectionRow> {
  const parsed = Fuse.parseIndex<SectionRow>(payload.index as never)
  return new Fuse(payload.rows, ASK_FUSE_OPTIONS, parsed)
}
