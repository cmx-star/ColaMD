// Word（.docx）导出。从 Electron 版的 src/main/docx-export.ts 搬来，改动只有一处：
// 图片不再用 Electron 的 nativeImage，改成浏览器里量尺寸（见 imageRunFor）。
//
// 为什么生成放在渲染侧而不是外壳：docx 是 JS 库，外壳是 Rust，在 Rust 里重写一遍
// 解析与排版不划算。外壳只负责弹保存框和写文件。
//
// 管线是 Markdown 驱动的：mermaid 图在渲染侧先烧成 PNG、把围栏改写成图片引用
// （src/renderer/editor/mermaid-export.ts），所以这里只认指向真实图片的引用。

import {
  Document, ExternalHyperlink, HeadingLevel, ImageRun, Packer, Paragraph, Table,
  TableCell, TableRow, TextRun, WidthType, type ParagraphChild,
} from 'docx'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

interface MarkdownNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number
  url?: string
  alt?: string
  children?: MarkdownNode[]
}

export interface DocxExportInput {
  content: string
  /**
   * 内存里的图片：名字 → data URL。
   *
   * 图表与公式是在渲染侧现画的，只存在于内存中（`markdownForWord` 的产物），磁盘上
   * 没有对应文件，所以必须随这次调用一起交进来 —— 文档里写的是
   * `![](loomark-math-1.png)` 这种引用，光有 Markdown 取不到它。
   */
  images?: Record<string, string>
  /** 图片在 Word 里最大的显示尺寸，px。超出就等比缩。 */
  maxWidth?: number
  maxHeight?: number
}

function headingForDepth(depth: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const headings = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
  ]
  return headings[Math.max(0, Math.min(5, depth - 1))] as (typeof HeadingLevel)[keyof typeof HeadingLevel]
}

function textContent(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value ?? ''
  if (node.type === 'break') return '\n'
  return node.children?.map(textContent).join('') ?? ''
}

function inlineRuns(
  nodes: MarkdownNode[] | undefined,
  style: { bold?: boolean; italics?: boolean; strike?: boolean } = {},
): ParagraphChild[] {
  if (!nodes) return []
  const runs: ParagraphChild[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(new TextRun({ text: node.value ?? '', ...style }))
    } else if (node.type === 'break') {
      runs.push(new TextRun({ break: 1, ...style }))
    } else if (node.type === 'inlineCode') {
      runs.push(new TextRun({ text: node.value ?? '', font: 'Menlo', shading: { fill: 'F1F3F5' } }))
    } else if (node.type === 'strong') {
      runs.push(...inlineRuns(node.children, { ...style, bold: true }))
    } else if (node.type === 'emphasis') {
      runs.push(...inlineRuns(node.children, { ...style, italics: true }))
    } else if (node.type === 'delete') {
      runs.push(...inlineRuns(node.children, { ...style, strike: true }))
    } else if (node.type === 'link' && node.url) {
      runs.push(new ExternalHyperlink({ link: node.url, children: inlineRuns(node.children, style) }))
    } else if (node.type === 'image') {
      // 图片在段落里单独处理；走到这里说明它没被识别成图片，用文字占位。
      runs.push(new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true }))
    } else {
      runs.push(...inlineRuns(node.children, style))
    }
  }
  return runs
}

/** 量一张图的原始像素尺寸。浏览器没有同步 API，只能解码一次。 */
function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve(null)
    image.src = url
  })
}

/**
 * 把 `data:` URL 解成字节。
 *
 * **不能用 `fetch`**：页面的 CSP 是 `default-src 'self'`，而 `connect-src` 没有列
 * `data:`，于是 `fetch('data:image/png;base64,...')` 被安全策略拦下、抛 `Load failed`，
 * 表现是 Word 里每个图都变成 `[示意图]` 占位（2026-10-09，靠诊断日志定位到）。
 * `img-src` 里允许 `data:`，所以 `<img>` 能加载它，但 fetch 走的是 connect-src。
 *
 * 这里手工解码，既绕开 CSP，也不必为了读内存里的几个字节去放宽安全策略。
 */
function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const [, , base64, payload] = match
  if (base64) {
    try {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    } catch {
      return null
    }
  }
  // 非 base64 的 data URL：内容是按 URL 规则转义的。
  try {
    const text = decodeURIComponent(payload)
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * 一张图 → 一个 ImageRun。
 *
 * 图片来源有两处，按顺序找：
 *   1. `images`：图表与公式现画出来的 data URL，只存在于内存里（磁盘上没有这个文件）；
 *   2. `fetch(url)`：文档里本来就有的图片，已经由渲染侧转成 data URL 或本来就是 http。
 *
 * **先查 `images` 不能省**：`loomark-math-1.png` 这种名字是凭空起的，磁盘上不存在，
 * 光靠 fetch 必然失败，Word 里就只剩一行占位文字。
 */
async function imageRunFor(
  node: MarkdownNode,
  images: Record<string, string> | undefined,
  maxWidth: number,
  maxHeight: number,
): Promise<ImageRun | null> {
  const url = node.url
  if (!url) return null
  const source = images?.[url] ?? url
  try {
    let bytes: Uint8Array | null = null
    if (source.startsWith('data:')) {
      // 内存里现画的图（图表、公式，以及渲染侧转好的本地图片）：手工解码，见 decodeDataUrl。
      bytes = decodeDataUrl(source)
      if (!bytes) {
        void window.loomark.logRendererError(`[export] Word 图片解码失败 ${url}`)
        return null
      }
    } else {
      // 远程图片才走网络。
      const response = await fetch(source)
      if (!response.ok) {
        void window.loomark.logRendererError(`[export] Word 取图失败 ${url}：HTTP ${response.status}`)
        return null
      }
      bytes = new Uint8Array(await response.arrayBuffer())
    }

    const measured = await measureImage(source)
    const size = measured ?? { width: maxWidth, height: maxHeight }
    const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height)
    const type = /\.jpe?g$/i.test(url) || bytes[0] === 0xff ? 'jpg' : 'png'
    return new ImageRun({
      type,
      data: bytes,
      transformation: {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      },
    })
  } catch (error) {
    void window.loomark.logRendererError(
      `[export] Word 取图异常 ${url}（images 里有吗：${images?.[url] ? '有' : '没有'}）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

function imagePlaceholder(node: MarkdownNode): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: node.alt ? `[${node.alt}]` : '[image]', italics: true })],
  })
}

function tableForNode(node: MarkdownNode): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (node.children ?? []).map((row) => new TableRow({
      children: (row.children ?? []).map((cell) => new TableCell({
        children: [new Paragraph({ children: inlineRuns(cell.children) })],
      })),
    })),
  })
}

/** 一次导出里到处要用、又不该反复传的东西。 */
interface DocxContext {
  images: Record<string, string> | undefined
  maxWidth: number
  maxHeight: number
}

async function blockNodes(
  nodes: MarkdownNode[] | undefined,
  context: DocxContext,
  listDepth = 0,
): Promise<Array<Paragraph | Table>> {
  if (!nodes) return []
  const output: Array<Paragraph | Table> = []
  for (const node of nodes) {
    if (node.type === 'heading') {
      output.push(new Paragraph({ heading: headingForDepth(node.depth ?? 1), children: inlineRuns(node.children) }))
    } else if (node.type === 'paragraph') {
      const only = node.children?.length === 1 ? node.children[0] : null
      if (only?.type === 'image') {
        const run = await imageRunFor(only, context.images, context.maxWidth, context.maxHeight)
        output.push(run ? new Paragraph({ children: [run] }) : imagePlaceholder(only))
      } else {
        output.push(new Paragraph({ children: inlineRuns(node.children), spacing: { after: 120 } }))
      }
    } else if (node.type === 'image') {
      const run = await imageRunFor(node, context.images, context.maxWidth, context.maxHeight)
      output.push(run ? new Paragraph({ children: [run] }) : imagePlaceholder(node))
    } else if (node.type === 'blockquote') {
      output.push(new Paragraph({
        children: [new TextRun({ text: textContent(node), italics: true })],
        indent: { left: 720 },
        border: { left: { color: 'AEB7C2', space: 8, style: 'single', size: 12 } },
      }))
    } else if (node.type === 'code') {
      output.push(new Paragraph({
        children: [new TextRun({ text: node.value ?? '', font: 'Menlo', size: 18 })],
        shading: { fill: 'F1F3F5' },
        spacing: { before: 120, after: 120 },
      }))
    } else if (node.type === 'list') {
      const start = node.start ?? 1
      for (const [index, item] of (node.children ?? []).entries()) {
        const first = item.children?.find((child) => child.type === 'paragraph')
        const prefix = node.ordered ? `${start + index}. ` : '• '
        output.push(new Paragraph({
          children: [new TextRun({ text: prefix }), ...inlineRuns(first?.children)],
          indent: { left: 360 + listDepth * 360, hanging: 240 },
          spacing: { after: 60 },
        }))
        output.push(...await blockNodes(
          item.children?.filter((child) => child !== first),
          context, listDepth + 1,
        ))
      }
    } else if (node.type === 'table') {
      output.push(tableForNode(node))
    } else if (node.type === 'thematicBreak') {
      output.push(new Paragraph({ border: { bottom: { color: 'AEB7C2', space: 1, style: 'single', size: 6 } } }))
    } else if (node.type === 'html') {
      // HTML 注释（`<!-- ... -->`）不是内容，丢掉。留着的后果是它原样出现在 Word 正文里
      // ——一份文档里混进 `<!-- 12121 -->` 这种字符串，用户会以为导出坏了（2026-10-09）。
      const raw = (node.value ?? '').trim()
      if (!/^<!--[\s\S]*-->$/.test(raw)) {
        output.push(new Paragraph({ children: [new TextRun({ text: node.value ?? '' })] }))
      }
    } else if (node.type === 'footnoteDefinition') {
      output.push(new Paragraph({ children: [new TextRun({ text: textContent(node), size: 18, color: '667085' })] }))
    } else {
      output.push(...await blockNodes(node.children, context, listDepth))
    }
  }
  return output
}

/** Markdown → .docx 字节。 */
export async function markdownToDocx(input: DocxExportInput): Promise<Uint8Array> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(input.content) as MarkdownNode
  const document = new Document({
    creator: 'loomark',
    title: 'loomark export',
    sections: [{
      children: await blockNodes(tree.children, {
        images: input.images,
        maxWidth: input.maxWidth ?? 560,
        maxHeight: input.maxHeight ?? 420,
      }),
    }],
  })
  // 用 toArrayBuffer，不要用 toBuffer：后者返回 Node 的 Buffer，在页面里它不存在，
  // 打包器会带着 zip 的流式实现一起进来，最后在 generateInternalStream 里炸掉
  // （2026-10-09 实测：`导出 Word` 弹框，栈顶就是 docx 的 generateAsync）。
  const buffer = await Packer.toArrayBuffer(document)
  return new Uint8Array(buffer)
}
