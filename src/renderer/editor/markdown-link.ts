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

// 目录名、绝对路径判定与 `.`/`..` 归一化三个工具与图片地址解析共用一份
// （见 file-path.ts）：两边都是「相对当前文档目录解析」这一条规矩。
import { dirnameOf, isAbsolutePath, normalize } from './file-path'

/** 只认这几种扩展名：一个 `.md` 链接才值得为它开一个标签页。 */
const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']

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
