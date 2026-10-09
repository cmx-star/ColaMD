// Mermaid diagrams and math for the Word export.
//
// Word is a white page, so every diagram that goes into a .docx is rendered
// again with Mermaid's light palette, even when the app is in a dark theme. The
// SVG on screen is deliberately not reused: it may belong to a dark theme, and
// in source mode (or on a block whose source is open for editing) there is no
// SVG on screen at all, yet the export can still draw one.
//
// The Word pipeline is Markdown based (the docx export parses the text
// and only understands images that point at a real file), so each diagram is
// burned into a PNG here and the fence is rewritten into an image reference that
// names it in `images`. A diagram that cannot be drawn keeps its code fence: an
// export never fails because one diagram did.
//
// 公式走同一条路（2026-10-09）：Markdown → Word 的管线里没有公式这一步，`$E = mc^2$`
// 到了 docx 就是普通字符，Word 里显示成源码。把它烧成 PNG 至少能看见公式 —— 代价是
// **在 Word 里不可编辑**。要可编辑得输出 OMML，那是另一件事，先不做。

import katex from 'katex'

import { renderMermaid } from './mermaid-bridge'

const MERMAID_FENCE = /^([ \t]*)```[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)^\1```[ \t]*$/gm
/** 行内公式 `$...$` 与块级 `$$...$$`。与编辑器里的扫描规则保持一致的保守配对。 */
const INLINE_MATH = /(?<!\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g
const BLOCK_MATH = /^\s*\$\$([\s\S]+?)\$\$\s*$/gm

export interface WordExportPayload {
  content: string
  images: Record<string, string>
}

// Mermaid gives the SVG a viewBox and often a `width="100%"` style, which an
// <img> cannot size from. Pin the natural size on a copy before serialising.
async function diagramPNG(code: string): Promise<string | null> {
  const svg = await renderMermaid(code, { theme: 'default', bg: '#ffffff' })
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  if (!root || root.nodeName !== 'svg') return null

  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const width = viewBox.length === 4 && viewBox.every(Number.isFinite)
    ? viewBox[2]
    : Number.parseFloat(root.getAttribute('width') ?? '')
  const height = viewBox.length === 4 && viewBox.every(Number.isFinite)
    ? viewBox[3]
    : Number.parseFloat(root.getAttribute('height') ?? '')
  if (!(width > 0) || !(height > 0)) return null

  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const source = new XMLSerializer().serializeToString(root)

  const image = new Image()
  const decoded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
  })
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  if (!(await decoded)) return null

  // Twice the natural size: the docx scales the image down to fit the page, and
  // the extra pixels are what keep the labels sharp in print.
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

export async function markdownForWord(markdown: string, chinese: boolean): Promise<WordExportPayload> {
  const fences: Array<{ start: number; end: number; code: string }> = []
  MERMAID_FENCE.lastIndex = 0
  for (let match = MERMAID_FENCE.exec(markdown); match; match = MERMAID_FENCE.exec(markdown)) {
    const indent = match[1] ?? ''
    const body = match[2] ?? ''
    fences.push({
      start: match.index,
      end: match.index + match[0].length,
      code: (indent ? body.replace(new RegExp(`^${indent}`, 'gm'), '') : body).trimEnd(),
    })
  }
  if (fences.length === 0) return { content: markdown, images: {} }

  const images: Record<string, string> = {}
  const pieces: string[] = []
  let cursor = 0
  let index = 0
  for (const fence of fences) {
    index += 1
    const name = `loomark-diagram-${index}.png`
    const png = await diagramPNG(fence.code).catch(() => null)
    pieces.push(markdown.slice(cursor, fence.start))
    if (png) {
      images[name] = png
      pieces.push(`![${chinese ? '示意图' : 'Diagram'}](${name})`)
    } else {
      pieces.push(markdown.slice(fence.start, fence.end))
    }
    cursor = fence.end
  }
  pieces.push(markdown.slice(cursor))

  // 图表处理完之后再烧公式，并把图表那一步已经产出的图片带上。
  return burnMath(pieces.join(''), images, chinese)
}

/**
 * 把公式烧成 PNG，改写成图片引用。图表与公式共用同一个 `images` 表。
 *
 * **代码块里的 `$` 不能碰**：`printf("$5")` 是代码，不是公式。所以先把围栏代码块与行内
 * 代码抠出来占位，处理完再放回去 —— 直接对全文跑正则一定会误伤。
 */
async function burnMath(
  markdown: string,
  images: Record<string, string>,
  chinese: boolean,
): Promise<WordExportPayload> {
  const held: string[] = []
  const hold = (text: string): string => {
    held.push(text)
    // 用不会出现在 Markdown 里的形式占位，避免被后续正则碰到。
    return `\u0000${held.length - 1}\u0000`
  }

  let work = markdown
    .replace(/```[\s\S]*?```/g, hold)
    .replace(/`[^`\n]*`/g, hold)

  let index = 0

  // 块级在前：`$$...$$` 若先被行内规则碰到会被拆坏。
  const formulas: Array<{ token: string; code: string; block: boolean }> = []
  work = work.replace(BLOCK_MATH, (whole, code: string) => {
    const token = hold(whole)
    formulas.push({ token, code, block: true })
    return token
  })
  work = work.replace(INLINE_MATH, (whole, code: string) => {
    const token = hold(whole)
    formulas.push({ token, code, block: false })
    return token
  })

  for (const formula of formulas) {
    index += 1
    const name = `loomark-math-${index}.png`
    const png = await mathPNG(formula.code, formula.block).catch(() => null)
    if (!png) continue // 画不出来就保留源码：占位符换回原文时它自然还在
    images[name] = png
    const reference = `![${chinese ? '公式' : 'Formula'}](${name})`
    // 块级公式单独成段，行内公式留在原处。
    work = work.replace(formula.token, formula.block ? `\n\n${reference}\n\n` : reference)
  }

  // 把占位换回原文。刻意不用 replace 的 `$&` 之类：内容里可能有 `$`。
  work = work.replace(/\u0000(\d+)\u0000/g, (_whole, i: string) => held[Number(i)] ?? '')

  return { content: work, images }
}

/**
 * 一个公式 → PNG data URL。
 *
 * 用 KaTeX 在**页面里已经加载好的样式**（它就在当前文档中），所以字体、字号、颜色都
 * 与屏幕上一致。渲染到一个固定宽度的容器里量尺寸，再按 2 倍导出——与 Mermaid 那边
 * 同样的理由：docx 会缩放图片，多出来的像素是清晰度的来源。
 */
async function mathPNG(code: string, block: boolean): Promise<string | null> {
  const holder = document.createElement('div')
  holder.style.cssText = block
    ? 'position:fixed;left:-100000px;top:0;background:#ffffff;padding:4px 8px;'
    : 'position:fixed;left:-100000px;top:0;background:#ffffff;display:inline-block;'
  // 浅色底上的深色字：Word 是一张白纸，深色主题的公式颜色搬过去会看不见。
  holder.style.color = '#000000'
  try {
    holder.innerHTML = katex.renderToString(code, {
      displayMode: block,
      throwOnError: true,
      trust: false,
    })
  } catch {
    // 渲染不了就交回给调用方，让它保留源码文字。宁可难看，不丢字。
    holder.remove()
    return null
  }
  document.body.appendChild(holder)

  try {
    await document.fonts.ready.catch(() => undefined)
    // 等一帧再量：KaTeX 的布局要靠字体度量，字体没就绪时宽度会偏小。
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const box = holder.getBoundingClientRect()
    const width = Math.ceil(box.width)
    const height = Math.ceil(box.height)
    if (width <= 0 || height <= 0) return null

    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)

    // 用 foreignObject 直接把这段 DOM 画下来：KaTeX 的公式是 DOM + CSS，不是 SVG，
    // 换别的画法就得自己重排一遍。
    //
    // 样式表与转义都复用 export/render.ts 那一份：公式烧图会踩**同一个坑** —— 样式里
    // 只要留下一个指向外链的字体（Vite 把 KaTeX 的字体改写成了 `./KaTeX_xxx.woff2`，
    // 在 `data:` 的 SVG 里解析不到），整张 SVG 就不加载；而 CSS 注释里的 `<` 和 `&`
    // 会让 XML 解析直接失败。那两件事都已经在那边解决过了。
    const { styleTextWithFontsInlined, escapeForXML } = await import('../export/render')
    const styles = await styleTextWithFontsInlined()
    const clone = holder.cloneNode(true) as HTMLElement
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<foreignObject width="100%" height="100%">`
      + `<div xmlns="http://www.w3.org/1999/xhtml"><style>${escapeForXML(styles)}</style>`
      + `${new XMLSerializer().serializeToString(clone)}</div></foreignObject></svg>`

    const image = new Image()
    image.width = width
    image.height = height
    const decoded = await new Promise<boolean>((resolve) => {
      image.onload = () => resolve(true)
      image.onerror = () => resolve(false)
      // 字体已经在当前文档里就绪，这里不需要再内联：SVG 是从同一份文档序列化出来的，
      // 而 KaTeX 的 CSS 也随样式表一起带上了。
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    })
    if (!decoded) return null

    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    holder.remove()
  }
}
