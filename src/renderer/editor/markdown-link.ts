// 本地 Markdown 链接的解析：把文档里写的 `[方案](doc/方案A.md#设计目标)` 变成一个
// 可以打开的绝对路径，外加要跳到哪一行/哪个标题。
//
// 相对路径**相对当前文档所在目录**解析，不是相对渲染层的 URL、也不是相对进程的工作目录。
// 上游把它放在主进程，理由正是这一条；Tauri 的 asset protocol 给的是 `asset://` URL，
// 同样不能拿来解析相对路径，所以这条理由在这里照样成立。差别只在于我们把当前文档路径
// （`currentFilePath`）留在渲染层，因此解析也放在渲染层，只把算好的绝对路径交给外壳去开。
//
// 来源：上游 colamd `src/main/markdown-link.ts`（b5bbfad、660ad63），逻辑未改动。

export interface MarkdownLink {
  path: string
  fragment: string
  line?: number
}

/** 只认这几种扩展名：一个 `.md` 链接才值得为它开一个标签页。 */
const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']

/** 纯字符串的目录名（`a/b/c.md` → `a/b`），不引 node 的 path 模块。 */
function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? '' : path.slice(0, cut)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)
}

/** 解析 `.` 与 `..`，保留前导斜杠（或 Windows 盘符）。 */
function normalize(path: string): string {
  const drive = /^([a-z]:)[\\/]/i.exec(path)
  const rest = drive ? path.slice(drive[1].length) : path
  const absolute = rest.startsWith('/') || rest.startsWith('\\')
  const out: string[] = []
  for (const part of rest.split(/[\\/]/)) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  const prefix = drive ? `${drive[1]}/` : absolute ? '/' : ''
  return prefix + joined
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** 把 `file:` URL 变回路径。只处理最常见的 `file:///path` 形式。 */
function pathFromFileUrl(url: string): string {
  const withoutScheme = url.replace(/^file:\/\//i, '')
  if (/^\/[a-z]:/i.test(withoutScheme)) return withoutScheme.slice(1)
  return decodeURIComponent(withoutScheme)
}

export function resolveMarkdownLink(href: string, sourcePath: string | null): MarkdownLink | null {
  if (!href || href.startsWith('#')) return null
  const hash = href.indexOf('#')
  const fragment = hash < 0 ? '' : href.slice(hash + 1)
  let pathname = (hash < 0 ? href : href.slice(0, hash)).split('?')[0]
  // Strip a one-based source line before decoding, preserving encoded colons
  // in filenames and the colon in a Windows drive prefix.
  const suffix = /:(\d+)$/.exec(pathname)
  const line = suffix ? Number(suffix[1]) : undefined
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null
  if (suffix) pathname = pathname.slice(0, suffix.index)
  let path: string
  if (/^file:/i.test(pathname)) {
    path = pathFromFileUrl(pathname)
  } else {
    // A drive letter is not a URI scheme. All other schemes remain disallowed.
    if (/^[a-z][a-z\d+.-]*:/i.test(pathname) && !/^[a-z]:[\\/]/i.test(pathname)) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    if (!isAbsolutePath(decoded) && !sourcePath) return null
    path = isAbsolutePath(decoded)
      ? normalize(decoded)
      : normalize(`${dirnameOf(sourcePath!)}/${decoded}`)
  }
  if (!MARKDOWN_EXTENSIONS.includes(extensionOf(path))) return null
  return { path, fragment, line }
}
