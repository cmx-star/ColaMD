// 纯字符串的路径工具：不引 node 的 path 模块（渲染层跑在 WebView 里，没有它）。
//
// 从 markdown-link.ts 里原样搬出来，供链接与图片两处共用：两边的规矩是同一条，
// 相对路径一律相对**当前文档所在目录**解析，而不是相对渲染层的 URL、也不是进程的工作目录。

/** 纯字符串的目录名（`a/b/c.md` → `a/b`）。 */
export function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? '' : path.slice(0, cut)
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)
}

/** 解析 `.` 与 `..`，保留前导斜杠（或 Windows 盘符）。 */
export function normalize(path: string): string {
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
