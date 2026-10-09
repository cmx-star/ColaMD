// PNG 导出。
//
// 一篇文档出一张连续长图；超过捕获表面上限时退回编号页，一页一张。分页用**画布裁切**
// 而不是滚动或 translate：Electron 版试过 scrollTop，它在文末会 clamp，那个错位就是
// 整片内容错位、丢行的原因（#121 丢了 28px）。裁切没有这个问题。

import {
  MAX_CAPTURE_EDGE_PX, canvasToPNG, cropCanvas, renderToCanvas, type RenderedCanvas,
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

  let rendered: RenderedCanvas
  try {
    // holder 必须真的在文档里：inlineStyles 走 getComputedStyle，脱离文档的节点
    // 量不到样式。它放在屏幕外，用户看不到。
    rendered = await renderToCanvas(clone, { scale: 2, background })
  } finally {
    holder.remove()
  }

  const limit = MAX_CAPTURE_EDGE_PX
  const fitsOne = rendered.canvas.width <= limit && rendered.canvas.height <= limit
  if (fitsOne) {
    return [await canvasToPNG(rendered.canvas)]
  }

  // 太高了，按页高切。每页高度同样受上限约束，取页高与上限中小的那个。
  const pagePixelHeight = Math.min(Math.round(pageHeight * rendered.scale), limit)
  const pages: Uint8Array[] = []
  for (let y = 0; y < rendered.canvas.height; y += pagePixelHeight) {
    const height = Math.min(pagePixelHeight, rendered.canvas.height - y)
    if (height <= 0) break
    pages.push(await canvasToPNG(cropCanvas(rendered.canvas, y, height)))
  }
  return pages
}
