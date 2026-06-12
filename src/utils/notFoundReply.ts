/** Issue #29 — 超範圍回覆：LINE／純文字用與首頁 HTML 用。 */

export const ARCHIVE_TW_URL = 'https://archive.tw'

/** LINE 與其他純文字通道（保留換行）。 */
export const NOT_FOUND_REPLY_PLAIN =
  '您的問題超出了資料庫的範圍，\n逐字稿網站連結如下：https://archive.tw'

/**
 * 首頁 /cag 404 回覆：僅含靜態 <a>，無 script／事件屬性。
 * 客戶端以 sanitizeHtml 再過濾後以 innerHTML 呈現。
 */
export const NOT_FOUND_REPLY_HTML =
  '您的問題超出了資料庫的範圍，逐字稿網站連結如下：' +
  `<a href="${ARCHIVE_TW_URL}" rel="nofollow noreferrer noopener" target="_blank">${ARCHIVE_TW_URL}</a>`