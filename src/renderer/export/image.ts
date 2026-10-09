// PNG 导出。
//
// 一篇文档出一张连续长图；超过捕获表面上限时退回编号页，一页一张。分页用**画布裁切**
// 而不是滚动或 translate：Electron 版试过 scrollTop，它在文末会 clamp，那个错位就是
// 整片内容错位、丢行的原因（#121 丢了 28px）。裁切没有这个问题。

import {
  MAX_CAPTURE_EDGE_PX, canvasToPNG, prepareDocument, renderPrepared,
} from './render'

export type ImageExportPreset = 'desktop' | 'mobile'

/** 阅读宽度与一页的高度，沿用 Electron 版的取值。 */
const PRESETS: Record<ImageExportPreset, { width: number; height: number; padding: number }> = {
  desktop: { width: 1200, height: 800, padding: 64 },
  mobile: { width: 414, height: 896, padding: 28 },
}

export function presetSize(preset: ImageExportPreset): { width: number; height: number } {
  const { width, height } = PRESETS[preset]
  return { width, height }
}

/**
 * 导出成一或多张 PNG。
 *
 * 返回的是字节而不是 data URL：PDF 与图片两条路都要把结果交给外壳写盘，字节更直接。
 */
export async function renderImages(
  element: HTMLElement,
  preset: ImageExportPreset,
  background: string,
): Promise<Uint8Array[]> {
  const { width, padding } = PRESETS[preset]
  const pageHeight = PRESETS[preset].height

  // 阅读宽度是导出的布局宽度，把根节点摆成那个宽度再渲染，否则拿到的还是窗口宽度。
  const holder = document.createElement('div')
  holder.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;`
    + `box-sizing:border-box;padding:${padding}px;background:${background};`
  const clone = element.cloneNode(true) as HTMLElement
  holder.appendChild(clone)
  document.body.appendChild(holder)

  const scale = 2
  try {
    // holder 必须真的在文档里：inlineStyles 走 getComputedStyle，脱离文档的节点
    // 量不到样式。它放在屏幕外，用户看不到。
    const prepared = await prepareDocument(clone)
    const limit = MAX_CAPTURE_EDGE_PX

    // 整篇装得下一张画布：渲一次，直接出图。
    const fitsOne = prepared.width * scale <= limit && prepared.fullHeight * scale <= limit
    if (fitsOne) {
      const rendered = await renderPrepared(prepared, scale, background, null)
      return [await canvasToPNG(rendered.canvas)]
    }

    // 太高了，按页高切，逐页渲染。每页高度同样受上限约束，取页高与上限中小的那个。
    // 不能先整篇渲再裁：整篇渲染本身就会撞 16384 设备像素上限（超长文档图片导不出来的
    // 根因，2026-10-09 报的 45 小节文档就是这样）。逐页渲染则每页都远低于上限。
    const pagePixelHeight = Math.min(Math.round(pageHeight * scale), limit)
    const pageCssHeight = pagePixelHeight / scale
    const pages: Uint8Array[] = []
    for (let top = 0; top < prepared.fullHeight; top += pageCssHeight) {
      const height = Math.min(pageCssHeight, prepared.fullHeight - top)
      if (height <= 0) break
      const page = await renderPrepared(prepared, scale, background, { top, height })
      pages.push(await canvasToPNG(page.canvas))
      // 每页转出后清空画布，长文档几十页连续建 2x 高清画布，不清会积压在显存里。
      page.canvas.width = 0
      page.canvas.height = 0
    }
    return pages
  } finally {
    holder.remove()
  }
}
