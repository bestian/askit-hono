/**
 * 把「DELETE header + 一串 INSERT 語句」切成多個遠端匯入分檔，每檔的 UTF-8 位元組
 * 不超過 maxBytes（單一語句本身就超標時，例外地獨佔一檔——絕不產生空檔或死迴圈）。
 *
 * 純函式、無副作用，方便被 build-bigram-index.ts 與單元測試共用。
 * 行為與原本內聯切檔迴圈逐位元組等價。
 */
export function splitSqlIntoImportFiles(
  header: string,
  statements: string[],
  maxBytes: number,
): string[] {
  const files: string[] = []
  let body = header
  for (const stmt of statements) {
    const bodyBytes = Buffer.byteLength(body, 'utf-8')
    const stmtBytes = Buffer.byteLength(stmt, 'utf-8')
    // 目前分檔非空、且再加一條會超標，就先收檔、開新檔（新檔不再帶 header）。
    // 守住 body.length > 0：避免單一語句本身就大於上限時陷入空檔死迴圈。
    if (body.length > 0 && bodyBytes + stmtBytes > maxBytes) {
      files.push(body)
      body = ''
    }
    body += stmt
  }
  if (body.length > 0) files.push(body)
  return files
}
