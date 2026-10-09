// 导出验收：在应用内跑真实的渲染链路，把结果量成数字交给脚本判定。
//
// 为什么不驱动真实的导出命令：那会弹系统保存框，无头环境点不了（与 Electron 版
// verify-image-export 的处境相同）。所以这里跑的是渲染那一半——文档 → 位图 → PNG/PDF
// 字节 —— 只把「落盘」那一步换掉。落盘由 Rust 的 export 命令负责，那部分是 std::fs::write。
//
// 判据沿用 Electron 版的手法：让每一行携带一个编码了行号的颜色，导出后逐行读回颜色。
// 丢失、重复、压扁的行都变成数值比较，不靠肉眼看图。
//
// 夹具由验收脚本在启动时作为文档交给应用（与主题验收同一条路，COLAMD_VERIFY），
// 这里不自己造：造一份假文档只能证明「我能渲染我自己造的东西」。

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function note(message: string): void {
  void window.loomark?.logRendererError(`[verify] ${message}`)
}

/** 行号编码成颜色：base 7 的三个通道，相邻行至少差 30，取色不会有歧义。 */
function colorOf(index: number): [number, number, number] {
  const level = (value: number): number => 40 + value * 30
  return [level(index % 7), level(Math.floor(index / 7) % 7), level(Math.floor(index / 49) % 7)]
}

export interface ExportLineSample {
  expected: number
  got: number
  color: string
  share: number
}

export interface ExportCheckResult {
  /** 渲染出的内容尺寸（CSS 像素）。 */
  width: number
  height: number
  /** PNG 的字节数与像素尺寸。 */
  png: { bytes: number; width: number; height: number; pages: number }
  /** PDF 的字节数、页数，以及文件头是否合法。 */
  pdf: { bytes: number; magic: string; pages: number }
  /** Word 的字节数与文件头（.docx 是 zip，应以 PK 开头）。 */
  docx: { bytes: number; magic: string }
  /** 逐行还原的行号，`got` 与 `expected` 不一致就是丢了或错位了。 */
  samples: ExportLineSample[]
  /** 色带总数，判据的基数。 */
  bands: number
  /** 文档里是否出现了公式（它决定字体内联那条路有没有被走到）。 */
  hasMath: boolean
  durationMs: number
}

/** 把 base64 解码成字节长度。 */
function byteLength(base64: string): number {
  return Math.floor((base64.length * 3) / 4)
}

/** 读一张 PNG 的像素尺寸。 */
function pngSize(base64: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('PNG 解不开'))
    image.src = `data:image/png;base64,${base64}`
  })
}

/**
 * 导出验收。
 *
 * 必须有内容：量到欢迎页的话每条判据都会"通过"，因为根本没有东西可量。
 */
export async function runExportCheck(): Promise<ExportCheckResult> {
  const started = Date.now()

  const root = document.querySelector<HTMLElement>('#editor .cm-content')
  if (!root) throw new Error('找不到 #editor .cm-content')

  let ready = false
  for (let attempt = 0; attempt < 80; attempt++) {
    if (document.querySelectorAll('#editor .cm-line').length > 10) {
      ready = true
      break
    }
    await sleep(250)
  }
  if (!ready) throw new Error('编辑器里没有装入夹具文档（COLAMD_VERIFY 那一次要带一个 .md）')

  // 整篇摊平：不摊平的话 CodeMirror 只渲染视口那一屏，导出的东西天然是残的。
  const { enterPaperLayout, exitPaperLayout } = await import('../print-layout')
  await enterPaperLayout()

  let result: ExportCheckResult
  try {
    const { renderToCanvas, toBase64: encode } = await import('../export/render')
    const { renderImages } = await import('../export/image')
    const { renderPDF } = await import('../export/pdf')
    const { markdownToDocx } = await import('../export/docx')

    const background = getComputedStyle(document.body).backgroundColor || '#ffffff'

    // 图片那条路，走导出真正用的入口。
    const images = await renderImages(root, 'desktop', background)
    const first = images[0]
    const firstBase64 = encode(first)
    const pngInfo = await pngSize(firstBase64)

    // PDF 那条路。
    const pdf = await renderPDF(root, background)
    const magic = String.fromCharCode(...pdf.bytes.slice(0, 5))

    // Word 那条路。.docx 是 zip，头两个字节是 PK。
    const docx = await markdownToDocx({ content: '# 导出验证\n\n一段正文，验证 Word 这条路。\n' })
    const docxMagic = String.fromCharCode(...docx.slice(0, 2))

    // 整篇画布，用于量尺寸。
    const canvas = await renderToCanvas(root, { scale: 1, background })

    // 逐行取色：把导出的那张 PNG 画到画布上读像素。
    const decoded: HTMLImageElement = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('PNG 解不开'))
      image.src = `data:image/png;base64,${firstBase64}`
    })
    const probe = document.createElement('canvas')
    probe.width = decoded.naturalWidth
    probe.height = decoded.naturalHeight
    const context = probe.getContext('2d')
    if (!context) throw new Error('拿不到 2d 画布')
    context.drawImage(decoded, 0, 0)
    const pixels = context.getImageData(0, 0, probe.width, probe.height).data

    // 色带：夹具把行号编码成底色，这里按它在 DOM 里的位置换算到输出图上取色。
    const domBands = Array.from(root.querySelectorAll<HTMLElement>('div[style*="background"]'))
    const rootRect = root.getBoundingClientRect()
    const ratio = probe.height / Math.max(1, root.scrollHeight)
    const palette = Array.from({ length: domBands.length }, (_, i) => colorOf(i))

    const samples: ExportLineSample[] = []
    for (const [index, band] of domBands.entries()) {
      const box = band.getBoundingClientRect()
      const y = Math.round((box.top - rootRect.top + box.height / 2) * ratio)
      if (y < 0 || y >= probe.height) {
        samples.push({ expected: index, got: -2, color: '越界', share: 0 })
        continue
      }
      const tally = new Map<string, number>()
      for (let x = 4; x < probe.width - 4; x += 4) {
        const offset = (y * probe.width + x) * 4
        const key = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`
        tally.set(key, (tally.get(key) ?? 0) + 1)
      }
      let best: { key: string; hits: number } | null = null
      for (const [key, hits] of tally) if (!best || hits > best.hits) best = { key, hits }
      const [r, g, b] = (best?.key ?? '0,0,0').split(',').map(Number)
      let match = -1
      for (let i = 0; i < palette.length; i++) {
        const [pr, pg, pb] = palette[i]
        if (Math.abs(pr - r) <= 6 && Math.abs(pg - g) <= 6 && Math.abs(pb - b) <= 6) {
          match = i
          break
        }
      }
      samples.push({
        expected: index,
        got: match,
        color: best?.key ?? '',
        share: (best?.hits ?? 0) / Math.max(1, Math.floor((probe.width - 8) / 4)),
      })
    }

    result = {
      width: canvas.width,
      height: canvas.height,
      png: { bytes: byteLength(firstBase64), width: pngInfo.width, height: pngInfo.height, pages: images.length },
      pdf: { bytes: pdf.bytes.length, magic, pages: pdf.pages },
      docx: { bytes: docx.length, magic: docxMagic },
      samples,
      bands: domBands.length,
      hasMath: root.querySelectorAll('.katex').length > 0,
      durationMs: Date.now() - started,
    }
  } finally {
    exitPaperLayout()
  }

  return result
}
