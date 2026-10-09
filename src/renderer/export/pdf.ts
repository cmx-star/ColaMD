// PDF 导出：把文档的位图放进 PDF 页。
//
// 为什么是位图而不是真文字：中文字体嵌入是这条路的死结。jsPDF 之类的库内置字体只有
// 拉丁文，要输出中文必须嵌入字体子集，一个完整中文字体 10MB 以上。用 foreignObject
// 渲染成位图，中文、主题配色、mermaid、公式全部与屏幕一致，代价是文字不可选、不可搜
// ——这一条是产品上确认过的取舍（2026-10-09）。
//
// 这里的 PDF 是**真 .pdf 文件**：一键落盘、不弹系统对话框，`%PDF-` 开头、`%%EOF` 结尾，
// 系统预览与打印都能打开。走的是 pdf-lib，纯 JS，无原生依赖。

import { PDFDocument } from 'pdf-lib'

import { MAX_CAPTURE_EDGE_PX, canvasToPNG, cropCanvas, prepareDocument, renderPrepared } from './render'
import { measureBlocks, planBreaks } from './pagination'

/** A4 纵向，单位 pt。 */
const A4_WIDTH = 595.28
const A4_HEIGHT = 841.89
/** 页边距，pt。与打印导出用的 20mm/18mm 接近，视觉上一致。 */
const MARGIN = 48

export interface PdfResult {
  bytes: Uint8Array
  pages: number
}

/**
 * 把文档渲染成 PDF。
 *
 * 分页不再按固定像素高度硬切，而是**避开块级元素**：切点从「这一页最多能装到哪」往前
 * 退到最近的合法断点，表格、图片、公式、图表不会被拦腰截断，标题也不会孤零零留在页尾
 * （2026-10-09 报的）。判据见 pagination.ts。
 *
 * 这里按文档高度分两条路：
 *
 *   · **装得下捕获上限**：整篇渲一张画布再按断点裁切。裁切不重排，与屏幕完全一致。
 *   · **装不下**（超过 16384 设备像素）：逐页渲染。原来的实现在这种情况下会直接抛错
 *     「内容太高，一张画布放不下」，长文档根本导不出来；逐页渲染则永远不需要一张巨画布，
 *     因为每页都是独立画出来的。
 *
 * 两条路都只 `prepareDocument` 一次：内联样式 + 序列化是导出里最贵的一步，逐页渲染时
 * 每页复用同一份素材，只改 SVG 的视口与偏移（见 render.ts 的 renderPrepared）。
 */
export async function renderPDF(element: HTMLElement, background: string): Promise<PdfResult> {
  const scale = 2
  const contentWidth = A4_WIDTH - MARGIN * 2
  const contentHeight = A4_HEIGHT - MARGIN * 2

  // 准备一次：拿到整篇宽高、内联字体后的样式、序列化好的 body。
  const prepared = await prepareDocument(element)
  const { width, fullHeight: height } = prepared

  // 位图的一个 CSS 像素对应多少 pt，按页宽算；一页能装多少 CSS 像素。
  const ptPerCssPx = contentWidth / width
  const cssPerPage = contentHeight / ptPerCssPx

  // 块边界只在分页时用得上。
  const { blocks, lineStops } = measureBlocks(element)
  const plan = planBreaks(blocks, lineStops)

  // 断点序列：从 0 开始，每次往前找一个合法断点，直到到达文末。
  const cuts: number[] = [0]
  // 防死循环：页数不可能超过「内容高度 / 8px」这个上限。
  const maxPages = Math.max(1, Math.ceil(height / 8) + 2)
  while (cuts[cuts.length - 1] < height - 0.5 && cuts.length <= maxPages) {
    const start = cuts[cuts.length - 1]
    const limit = start + cssPerPage
    if (limit >= height) {
      cuts.push(height)
      break
    }
    const next = plan.nextBreak(start, limit)
    // nextBreak 保证 >= start；真出现相等就往前推一个像素，避免空转。
    cuts.push(next > start ? next : Math.min(start + 1, height))
  }
  if (cuts.length <= 1) cuts.push(Math.max(1, height))

  const pdf = await PDFDocument.create()
  pdf.setTitle('loomark export')
  pdf.setProducer('loomark')

  // 一张画布放不下整篇时，逐段渲染：每页单独画一张，永远不需要巨画布。
  // 放得下就整篇渲一次再裁切，省掉每页一次的光栅化开销。
  const wholeFits = width * scale <= MAX_CAPTURE_EDGE_PX && height * scale <= MAX_CAPTURE_EDGE_PX
  const whole = wholeFits ? await renderPrepared(prepared, scale, background, null) : null

  for (let index = 0; index < cuts.length - 1; index++) {
    const top = cuts[index]
    const bottom = Math.min(cuts[index + 1], height)
    const sliceHeight = bottom - top
    if (sliceHeight <= 0) continue

    let slice: HTMLCanvasElement
    if (whole) {
      slice = cropCanvas(
        whole.canvas,
        Math.round(top * scale),
        Math.max(1, Math.round(sliceHeight * scale)),
      )
    } else {
      const page = await renderPrepared(prepared, scale, background, { top, height: sliceHeight })
      slice = page.canvas
    }
    const png = await canvasToPNG(slice)
    // 每页转出 PNG 字节后主动清空画布，让浏览器能及时回收：长文档几十页连续创建
    // 2x 高清画布，不清会积压在显存里，峰值过高可能白屏。
    slice.width = 0
    slice.height = 0

    const page = pdf.addPage([A4_WIDTH, A4_HEIGHT])
    const embedded = await pdf.embedPng(png)
    const drawHeight = sliceHeight * ptPerCssPx
    page.drawImage(embedded, {
      x: MARGIN,
      // PDF 的原点在左下角，所以从页顶往下排。
      y: A4_HEIGHT - MARGIN - drawHeight,
      width: contentWidth,
      height: drawHeight,
    })
  }

  return { bytes: await pdf.save(), pages: cuts.length - 1 }
}
