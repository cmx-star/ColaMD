// `[[目标]]` / `[[目标#标题]]` 双链的纯解析：只负责从一段文本里读出「目标名 + 片段」，
// 不碰文件系统。文件系统上的模糊匹配（目标名 → 绝对路径）在 Rust 外壳里，因为递归搜索
// 目录是外壳的事，渲染层只拿着解析结果去问。
//
// 为什么不塞进 markdown-link.ts：那边处理的是「已经带地址的链接」（`[文字](地址)`、
// `file://`、行号后缀），目标明确、不依赖目录内容；双链给的是**不带扩展名、不带路径**
// 的裸名字，要等目录搜索才能变成路径，两者的职责和失败方式都不同。分开反而清楚。

export interface WikiTarget {
  /** `[[目标]]` 里的目标部分，不含 `#`。可能是 `文件名` 或带子目录的 `子目录/文件名`。 */
  target: string
  /** `#` 之后的标题片段，没有则为空串。 */
  fragment: string
}

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']

/**
 * 从 `[[目标]]` 或 `[[目标#标题]]` 的整串文本里解析出目标与片段。
 *
 * 返回 null 的情况：不是以 `[[` 开头 / `]]` 结尾、目标为空、目标里混进了 URL 式的
 * 协议前缀（`http://`、`file://`）或明显是行内代码等不该被当双链的东西。
 */
export function parseWikiLink(text: string): WikiTarget | null {
  if (!text.startsWith('[[') || !text.endsWith(']]')) return null
  const inner = text.slice(2, -2).trim()
  if (!inner) return null
  // `[[http://…]]` 不是双链，交给普通链接逻辑。
  if (/^[a-z][a-z\d+.-]*:/i.test(inner) && !/^[a-z]:[\\/]/i.test(inner)) return null
  const hash = inner.indexOf('#')
  const target = (hash < 0 ? inner : inner.slice(0, hash)).trim()
  const fragment = hash < 0 ? '' : inner.slice(hash + 1).trim()
  if (!target) return null
  return { target, fragment }
}

/**
 * 一个目标名是否已经带了 markdown 扩展名。带扩展名的目标（`[[a.md]]`）不再追加扩展，
 * 也不做「去扩展名」匹配，按字面找文件。
 */
export function hasMarkdownExtension(target: string): boolean {
  const lower = target.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
