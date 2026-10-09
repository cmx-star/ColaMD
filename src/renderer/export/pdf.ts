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

import { canvasToPNG, cropCanvas, renderToCanvas } from './render'

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
 * 内容短于一页时缩放到页宽；长于一页时按 A4 的正文高度切页，每页一张位图。
 */
export async function renderPDF(element: HTMLElement, background: string): Promise<PdfResult> {
  const rendered = await renderToCanvas(element, { scale: 2, background })

  const contentWidth = A4_WIDTH - MARGIN * 2
  const contentHeight = A4_HEIGHT - MARGIN * 2
  const scale = rendered.scale
  // 位图的一个 CSS 像素对应多少 pt，按页宽算。
  const ptPerCssPx = contentWidth / rendered.width
  const contentPtHeight = rendered.height * ptPerCssPx

  const pdf = await PDFDocument.create()
  pdf.setTitle('loomark export')
  pdf.setProducer('loomark')

  const pageCount = Math.max(1, Math.ceil(contentPtHeight / contentHeight))
  // 一页能装多少 CSS 像素的内容。
  const cssPerPage = contentHeight / ptPerCssPx

  for (let index = 0; index < pageCount; index++) {
    const top = index * cssPerPage
    const sliceHeight = Math.min(cssPerPage, rendered.height - top)
    if (sliceHeight <= 0) break

    const slice = cropCanvas(
      rendered.canvas,
      Math.round(top * scale),
      Math.max(1, Math.round(sliceHeight * scale)),
    )
    const png = await canvasToPNG(slice)

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

  return { bytes: await pdf.save(), pages: pageCount }
}
