import { CAG_MODEL_GEMMA } from './cagEval'
import type { CagSource } from './cag'

export const AUDREY_SKILL_DEFAULT_MODEL = CAG_MODEL_GEMMA
export const AUDREY_SKILL_GLM_52_MODEL = '@cf/zai-org/glm-5.2'
export const AUDREY_SKILL_FUGU_MODEL = 'fugu'
export const AUDREY_SKILL_NEMOTRON_ULTRA_MODEL = 'nemotron-ultra'

const ALLOWED_AUDREY_MODELS: Record<string, true> = {
  [AUDREY_SKILL_DEFAULT_MODEL]: true,
  [AUDREY_SKILL_GLM_52_MODEL]: true,
  [AUDREY_SKILL_FUGU_MODEL]: true,
  [AUDREY_SKILL_NEMOTRON_ULTRA_MODEL]: true,
}

export function resolveAudreySkillModel(value: string | undefined): string {
  const model = value?.trim()
  if (!model) return AUDREY_SKILL_DEFAULT_MODEL
  return ALLOWED_AUDREY_MODELS[model] ? model : AUDREY_SKILL_DEFAULT_MODEL
}

export function buildAudreySkillAnswerInstruction(
  answerLanguage?: 'en',
): string {
  if (answerLanguage === 'en') {
    return [
      'Answer in English in Audrey Tang\'s public communication style.',
      'Do not claim to be Audrey Tang and do not speak for her.',
      'Use only the supplied transcript excerpts as factual evidence; the style guide is not evidence.',
      'For substantive claims, only cite the numbered runtime sources as [1], [2], etc.',
      'Do not output archive.tw raw URLs or archive section-id citations such as [63852758].',
      'Prefer a conversational reframe, a concrete Taiwan civic-tech example when supported, and an optimistic forward close.',
      'Stay non-partisan; critique mechanisms and tradeoffs, not people, parties, companies, or products.',
      'If the excerpts do not support the answer, say so clearly.',
    ].join(' ')
  }

  return [
    '請用唐鳳公開溝通風格作答，但不要聲稱自己是 Audrey Tang，也不要聲稱自己是唐鳳或代表她發言。',
    '預設使用繁體中文。',
    '只能使用本次提供的逐字稿段落作為事實依據；風格指南不是證據。',
    '所有實質論述只能引用本次提供的編號來源，例如 [1]、[2]。',
    '不要輸出 archive.tw 原始網址，也不要輸出像 [63852758] 這種 archive 章節編號假引註。',
    '回答節奏採對話式重新框架；若來源支持，先落在具體的台灣公民科技例子，再擴展成方法。',
    '保持非黨派；批判機制與取捨，不批判特定人物、政黨、公司或產品。',
    '如果來源不足以回答，請清楚說明。',
  ].join(' ')
}

function footnoteForSource(source: CagSource): string {
  return `[${source.label}](${source.href})`
}

const ARCHIVE_URL_PREFIX = 'https://archive.tw/'
const ARCHIVE_URL_PREFIX_PATTERN = ARCHIVE_URL_PREFIX.replace(/\./g, '\\.')

// 每個構造的長度都有上限，串流時需要保留的尾段因此有界，畸形輸入不會無限緩衝。
const CITATION_BODY_MAX = 64
const URL_BODY_MAX = 512
/**
 * 回收重掃的「級聯」上限。單次回收一定完整取得（迴圈先取再判斷），這個上限
 * 只擋住「刪一段又露出一段」連續數十次的病態輸入，避免 CPU 被拖住。
 */
const MAX_CARRY = 256

// 引註內容不得再含 `[`：否則一個沒閉合的 `[` 會把後面真正的引註整個吞進去。
const CITATION_RE = new RegExp(`\\[([^\\][]{0,${CITATION_BODY_MAX}})\\]`, 'y')
// 括號內只有空白與 `)` 能終止網址；裸網址則另外被中英標點終止。
const ARCHIVE_LINK_TAIL_RE = new RegExp(
  `\\(${ARCHIVE_URL_PREFIX_PATTERN}[^\\s)]{0,${URL_BODY_MAX}}\\)`,
  'y',
)
const ARCHIVE_RAW_URL_RE = new RegExp(
  `${ARCHIVE_URL_PREFIX_PATTERN}[^\\s)[\\]，。,.；;！？!?]{0,${URL_BODY_MAX}}`,
  'y',
)
// 保留下來的方括號文字裡也可能夾帶裸網址，需一併剝除。
const ARCHIVE_RAW_URL_GLOBAL_RE = new RegExp(ARCHIVE_RAW_URL_RE.source, 'g')
const NUMERIC_CITATION = /^\d+(?:\s*,\s*\d+)*$/
// 回收重掃時，用來認出尾端「未收完的 `[內容](archive 網址`」。
const LINK_OPEN_RE = new RegExp(`\\[[^\\][]{0,${CITATION_BODY_MAX}}\\]\\(([^)]*)$`)
const LINK_LOOKBEHIND = CITATION_BODY_MAX + URL_BODY_MAX + ARCHIVE_URL_PREFIX.length + 4

const OPEN_BRACKET = 0x5b // '['
const LOWER_H = 0x68 // 'h'

type Construct =
  | { kind: 'citation'; end: number; body: string; link: boolean }
  | { kind: 'url'; end: number }

/** `'partial'` = 構造可能尚未結束，需要更多輸入才能判定。 */
type MatchResult = Construct | 'partial' | null

function appendFootnotes(
  controller: TransformStreamDefaultController<string>,
  used: Set<number>,
  sources: CagSource[],
) {
  const indexes = [...used].sort((a, b) => a - b)
  if (indexes.length === 0) return
  controller.enqueue('\n\n')
  for (const index of indexes) {
    controller.enqueue(`[^${index}]: ${footnoteForSource(sources[index - 1]!)}\n`)
  }
}

function renderCitation(
  body: string,
  link: boolean,
  used: Set<number>,
  sourceCount: number,
): string {
  // 先剝除內文夾帶的裸網址，再判定是不是編號引註：剝完才知道剩下什麼。
  const safe = body.replace(ARCHIVE_RAW_URL_GLOBAL_RE, '')
  const trimmed = safe.trim()
  if (!NUMERIC_CITATION.test(trimmed)) return link ? safe : `[${safe}]`

  const valid: number[] = []
  for (const part of trimmed.split(',')) {
    const index = Number(part.trim())
    if (Number.isInteger(index) && index >= 1 && index <= sourceCount) {
      valid.push(index)
      used.add(index)
    }
  }
  if (valid.length === 0) return ''
  return valid.map((index) => `[^${index}]`).join(', ')
}

/** `(` 之後的內容是否仍可能長成 `(archive 網址)`，亦即還缺後續輸入才能判定。 */
function archiveLinkTailOpen(input: string, at: number): boolean {
  if (input.length - at < ARCHIVE_URL_PREFIX.length) {
    return ARCHIVE_URL_PREFIX.startsWith(input.slice(at))
  }
  if (!input.startsWith(ARCHIVE_URL_PREFIX, at)) return false
  const body = input.slice(at + ARCHIVE_URL_PREFIX.length)
  return body.length <= URL_BODY_MAX && !/[\s)]/.test(body)
}

function matchCitation(input: string, at: number): MatchResult {
  CITATION_RE.lastIndex = at
  const matched = CITATION_RE.exec(input)
  if (!matched) {
    // 只有「還沒收到 `]` 且長度未超限」才算尚未完成。這裡刻意不排除巢狀 `[` ——
    // 巢狀情形下後續刪除可能讓這個 `[` 變成引註開頭，必須留在緩衝區裡等。
    const bodyLength = input.length - at - 1
    return bodyLength <= CITATION_BODY_MAX && input.indexOf(']', at + 1) < 0
      ? 'partial'
      : null
  }

  const body = matched[1]!
  const end = CITATION_RE.lastIndex
  if (end === input.length) return 'partial' // 後面可能還接 `(archive 網址)`
  if (input.charCodeAt(end) !== 0x28 /* ( */) {
    return { kind: 'citation', end, body, link: false }
  }

  ARCHIVE_LINK_TAIL_RE.lastIndex = end
  if (ARCHIVE_LINK_TAIL_RE.exec(input)) {
    return { kind: 'citation', end: ARCHIVE_LINK_TAIL_RE.lastIndex, body, link: true }
  }
  return archiveLinkTailOpen(input, end + 1)
    ? 'partial'
    : { kind: 'citation', end, body, link: false }
}

function matchArchiveUrl(input: string, at: number): MatchResult {
  ARCHIVE_RAW_URL_RE.lastIndex = at
  if (!ARCHIVE_RAW_URL_RE.exec(input)) {
    // 網址主體可為 0 長度，比對失敗只可能是前綴還沒收齊 —— 亦即剩餘長度
    // 必短於前綴。先檢查長度再 slice，避免對每個 `h` 複製整段剩餘字串。
    return (
      input.length - at < ARCHIVE_URL_PREFIX.length &&
      ARCHIVE_URL_PREFIX.startsWith(input.slice(at))
    )
      ? 'partial'
      : null
  }
  const end = ARCHIVE_RAW_URL_RE.lastIndex
  const bodyLength = end - at - ARCHIVE_URL_PREFIX.length
  // 停在輸入尾端而非終止字元：網址可能還沒串完。
  if (end === input.length && bodyLength < URL_BODY_MAX) return 'partial'
  return { kind: 'url', end }
}

/**
 * 已輸出內容尾端「還可能成為構造開頭」的最長後綴（未閉合的 `[`，或 archive
 * 網址的真前綴）。構造被整段刪除後，刪除點前後的文字會貼在一起，必須把這段
 * 後綴收回來重掃，否則會憑空生出 `[1]` 這種沒有註腳的裸引註。
 */
function openableSuffix(out: string): string {
  if (!out) return ''
  let start = out.length

  // 未閉合的 `[`
  const citationFrom = Math.max(0, out.length - CITATION_BODY_MAX - 1)
  for (let index = citationFrom; index < start; index += 1) {
    if (out.charCodeAt(index) !== OPEN_BRACKET) continue
    if (out.indexOf(']', index + 1) >= 0) continue
    start = index
    break
  }

  // 未收完的 `[內容](archive 網址`；先用 `](` 便宜地過濾，避免每次都跑 regex
  const linkFrom = Math.max(0, out.length - LINK_LOOKBEHIND)
  const window = out.slice(linkFrom)
  if (window.includes('](')) {
    const link = LINK_OPEN_RE.exec(window)
    if (link && linkFrom + link.index < start) {
      const urlAt = linkFrom + link.index + link[0].length - link[1]!.length
      if (archiveLinkTailOpen(out, urlAt)) start = linkFrom + link.index
    }
  }

  // archive 網址的真前綴
  const urlFrom = Math.max(0, out.length - ARCHIVE_URL_PREFIX.length + 1)
  for (let index = urlFrom; index < start; index += 1) {
    if (ARCHIVE_URL_PREFIX.startsWith(out.slice(index))) {
      start = index
      break
    }
  }

  return start < out.length ? out.slice(start) : ''
}

function nextOpener(input: string, from: number): number {
  for (let index = from; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    if (code === OPEN_BRACKET || code === LOWER_H) return index
  }
  return -1
}

/**
 * 串流結束時仍未完成的構造，依既定規則收尾（截斷的網址一律丟棄，不得外洩）。
 * 回傳 `null` 代表「這不是構造」，由主迴圈吐出開頭字元後重新掃描剩下的內容 ——
 * 未閉合的 `[` 走這條，其內文夾帶的裸網址才會照樣被剝除。
 */
function resolveTruncated(
  rest: string,
  used: Set<number>,
  sourceCount: number,
): string | null {
  if (rest.charCodeAt(0) === OPEN_BRACKET) {
    const close = rest.indexOf(']')
    if (close < 0) {
      const body = rest.slice(1)
      return NUMERIC_CITATION.test(body.trim()) ? '' : null
    }
    // 引註已閉合，尾巴是還沒收完的 `(archive 網址`。是否丟棄比照下方裸網址規則：
    // 已經看到 `https://` 以上長度才算網址（丟棄），否則當一般文字原樣吐出。
    const tail = rest.slice(close + 1)
    const truncatedUrl = tail.slice(1)
    const isLink = truncatedUrl.length >= 'https://'.length
    return (
      renderCitation(rest.slice(1, close), isLink, used, sourceCount) + (isLink ? '' : tail)
    )
  }
  return rest.length >= 'https://'.length ? '' : rest
}

/**
 * 引註改寫的唯一實作，`audreySkillCitationFootnotes`（串流）與
 * `renderAudreySkillMarkdown`（非串流）共用，兩條路徑因此不會語意分歧。
 *
 * | 輸入                          | 輸出         |
 * | ----------------------------- | ------------ |
 * | `[n]`，n 在 1..sources.length | `[^n]`       |
 * | `[n]`，n 越界（含假章節編號） | 刪除         |
 * | `[1,2]`                       | `[^1], [^2]` |
 * | `[非數字]`                    | 原樣保留     |
 * | `[內容含裸網址]`              | 剝除網址後再依上列規則判定 |
 * | `[n](archive 網址)`，n 有效   | `[^n]`       |
 * | `[n](archive 網址)`，n 越界   | 刪除         |
 * | `[文字](archive 網址)`        | `文字`       |
 * | 裸 `https://archive.tw/…`     | 刪除         |
 *
 * `awaitingMore` 為 true 時，尾端未完成的構造原樣回傳到 `rest` 由下一個 chunk
 * 接續；為 false 時（flush 或非串流）就地收尾。輸出與 chunk 切點無關。
 *
 * 兩個支撐正確性的性質：
 *
 * 1. 比對失敗只前進一格：吐出一個字元、游標 +1，下一輪從該位置之後重新尋找
 *    構造。「重新分派」因此是迴圈本身的性質，不是各分支要各自記得做的事——
 *    先前的字元狀態機把它交給各狀態分支自行處理，一漏就靜默吃掉引註。
 * 2. 輸出是改寫的不動點：構造被整段刪除後，刪除點前後的文字會貼在一起，可能
 *    組成新的構造（`[[63852758]1]` → 刪掉假引註後剩 `[1]`）。因此刪除後要把
 *    已輸出尾端可能成為開頭的部分收回來重掃，直到不再變化為止。
 */
function scanAudreySkillCitations(
  input: string,
  sources: CagSource[],
  used: Set<number>,
  awaitingMore: boolean,
): { text: string; rest: string } {
  let out = ''
  let buffer = input
  let cursor = 0

  /**
   * 把已輸出尾端「可能成為構造開頭」的後綴收回來，供重新掃描。
   * 連續延伸：刪掉尾端那段之後，前面可能又露出一段（例如接連數個 `https://`），
   * 級聯必須一次收足，否則串流已 enqueue 的部分再也拿不回來。
   */
  function takeOpenableSuffix(): string {
    let carry = ''
    while (carry.length < MAX_CARRY) {
      const next = openableSuffix(out)
      if (!next) break
      carry = next + carry
      out = out.slice(0, out.length - next.length)
    }
    return carry
  }

  while (cursor < buffer.length) {
    const at = nextOpener(buffer, cursor)
    if (at < 0) {
      out += buffer.slice(cursor)
      break
    }
    out += buffer.slice(cursor, at)
    cursor = at

    const match =
      buffer.charCodeAt(at) === OPEN_BRACKET
        ? matchCitation(buffer, at)
        : matchArchiveUrl(buffer, at)

    if (match === 'partial') {
      const rest = buffer.slice(at)
      if (awaitingMore) {
        // 已 enqueue 的內容收不回來：把尾端可能要收回重掃的部分一起留在緩衝區。
        // 先取 carry（會就地縮短 out）再讀 out，順序不可對調。
        const carry = takeOpenableSuffix()
        return { text: out, rest: carry + rest }
      }
      const resolved = resolveTruncated(rest, used, sources.length)
      if (resolved === null) {
        // 不是構造，退回一般文字處理，剩下的內容重新掃描
        out += buffer[at]!
        cursor = at + 1
        continue
      }
      // 收尾規則吃掉剩餘全部內容；若那是一次刪除，尾端可能又露出新的未完成構造
      out += resolved
      buffer = resolved === '' ? takeOpenableSuffix() : ''
      cursor = 0
      continue
    }
    if (match === null) {
      out += buffer[at]!
      cursor = at + 1
      continue
    }

    const rendered =
      match.kind === 'citation'
        ? renderCitation(match.body, match.link, used, sources.length)
        : ''
    if (rendered === '') {
      // 整段刪除會讓刪除點前後貼在一起，把可能成為開頭的後綴收回來重掃
      const carry = takeOpenableSuffix()
      if (carry) {
        buffer = carry + buffer.slice(match.end)
        cursor = 0
        continue
      }
    }
    out += rendered
    cursor = match.end
  }

  return { text: out, rest: '' }
}

export function audreySkillCitationFootnotes(
  sources: CagSource[],
): TransformStream<string, string> {
  const used = new Set<number>()
  let pending = ''

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const { text, rest } = scanAudreySkillCitations(pending + chunk, sources, used, true)
      pending = rest
      if (text) controller.enqueue(text)
    },
    flush(controller) {
      if (pending) {
        const { text } = scanAudreySkillCitations(pending, sources, used, false)
        pending = ''
        if (text) controller.enqueue(text)
      }
      appendFootnotes(controller, used, sources)
    },
  })
}

export function renderAudreySkillMarkdown(
  answer: string,
  sources: CagSource[],
): string {
  const used = new Set<number>()
  const { text } = scanAudreySkillCitations(answer, sources, used, false)

  const indexes = [...used].sort((a, b) => a - b)
  if (indexes.length === 0) return text.trim()

  const notes = indexes
    .map((index) => `[^${index}]: ${footnoteForSource(sources[index - 1]!)}`)
    .join('\n')
  return `${text.trim()}\n\n${notes}\n`
}
