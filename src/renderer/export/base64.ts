// 字节 → base64。
//
// 单独放一个文件，是为了让 `main.ts` 能用一个轻量工具而不必静态引入整个 `render.ts`。
// `render.ts` 里装着 Canvas 光栅化、字体内联这些重活，属于「导出时才该加载」的代码；
// 而 base64 是导出三条路（PDF / Word / 图片）在**提交结果**时都要用的小工具，把它留在
// render.ts 会让主包被打进这些重活，白白拖慢启动（2026-10-09 构建时实测到的那两条
// "dynamic import will not move module into another chunk" 警告就是它引起的）。

/**
 * 把字节转成 base64 字符串。
 *
 * 分块处理而不是一次 `String.fromCharCode(...bytes)`：一次展开一个超大数组会撑爆调用栈
 * （Electron 版踩过，导出长文档时栈溢出）。8192 是 2 的幂，也远低于多数引擎的参数上限。
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}
