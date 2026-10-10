// 图片地址的解析：把 markdown 里写的那串地址，变成一个**文件系统里的绝对路径**。
//
// 为什么是绝对路径，而不是「拿文档 URL 当基准做 new URL(相对路径, base)」：
// Tauri 的 asset 协议把整条路径百分号编码成一个路径段
// （`convertFileSrc('/a/b/c.md')` → `asset://localhost/%2Fa%2Fb%2Fc.md`），
// 这个 base 的最后一段就是 `%2Fa%2Fb%2Fc.md` 本身，`new URL('pixel.png', base)`
// 只会得到 `asset://localhost/pixel.png`——落在进程的工作目录上，图片必然加载失败。
// 所以相对路径必须先在这里拼成绝对路径，再交给外壳转成可加载的地址。
//
// 与链接（markdown-link.ts）共用同一条规矩：相对路径相对**当前文档所在目录**解析。
// 返回 null 表示「不是本地文件，按原样交出去」（远程地址、data:、blob:、file:），
// 或者「拼不出来」（还没存盘的未命名文档）。

import { dirnameOf, isAbsolutePath, normalize } from './file-path'

/** 这些协议本身就够用，不需要（也不能）拼成文件路径。 */
const SELF_CONTAINED = /^(?:https?:|data:|blob:|file:)/i

/**
 * `raw` 是 markdown 里写的地址（调用方已去掉 <> 包裹）。
 *
 * 返回绝对路径，或 null（保持原样）。
 */
export function resolveImagePath(raw: string, documentPath: string | null): string | null {
  const value = raw.trim()
  if (!value || SELF_CONTAINED.test(value)) return null

  // 编码过的文件名（`my%20pic.png`）与链接那边一样先解码；解不开就用原样
  // （用户可能真的写了一个带 `%` 的名字，`100%.png`）。
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    decoded = value
  }

  // 盘符不是 URI scheme：`C:\x\y.png` 是绝对路径。
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) && !/^[a-z]:[\\/]/i.test(decoded)) return null

  if (isAbsolutePath(decoded)) return normalize(decoded)
  if (!documentPath) return null
  return normalize(`${dirnameOf(documentPath)}/${decoded}`)
}
