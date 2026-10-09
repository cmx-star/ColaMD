// 把文档渲染成位图：PDF、PNG 两条导出都从这里的画布出发。
//
// 为什么是 foreignObject 而不是原生截图：wry 0.57.0 没有向桌面三平台暴露任何截图能力
// （只有 iOS 的 WKWebView.rs 有 takeSnapshot），而 canvas 画 <svg><foreignObject> 是
// 浏览器自带的能力，不需要任何原生代码。原型验证见
// docs/export-pdf-image-plan.md，40/40 行色带逐行还原正确。
//
// 两个必须守住的点，都是实测踩出来的：
//
//   1. **@font-face 的 url() 必须内联成 data URL。** canvas 光栅化 foreignObject 时不做
//      外部资源加载，@font-face 指向外链时**整张 SVG 直接不加载**（不是字体退化，是图
//      完全出不来）。KaTeX 的样式表里有 @font-face，所以文档里只要有公式就会踩到。
//      20 个 woff2 合计 296KB。
//   2. **不能拿 computed style 整体覆盖已有 style 属性的节点。** 那样会抹掉节点原有的
//      inline style，纯色块会变白。只补该补的几个属性，且跳过已经有 style 的节点。

const FONT_FACE_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/g

/** 一张画布，以及它用了多少设备像素。 */
export interface RenderedCanvas {
  canvas: HTMLCanvasElement
  /** CSS 像素尺寸，布局用 */
  width: number
  height: number
  /** 画布实际像素，输出清晰度由它决定 */
  scale: number
}

export interface RenderOptions {
  /** 设备像素比。导出取 2 就够；在它之上再乘只会过采样、翻倍体积（Electron 版踩过）。 */
  scale?: number
  /** 内容背景色，PDF 页底色与 PNG 底都用它。 */
  background?: string
  /**
   * 只渲染内容的一段竖直区间（CSS 像素，相对内容顶部）。
   *
   * 给超长文档用：一张画布单边上限 16384 设备像素，整篇渲染会撞上限。分页导出时逐段
   * 调用，每段都远低于上限。不传就是整篇。
   */
  slice?: { top: number; height: number }
}

/** 把样式表里 @font-face 的字体读成 data URL，缓存住：一次导出可能要渲染好几页。 */
const fontCache = new Map<string, string>()
let fontDataUrls: Map<string, string> | null = null

/** 把样式表里的一个 url() 引用解析成可以 fetch 的地址。解析不了返回 null。 */
function resolveAgainstSheet(reference: string, sheetHref: string | null): string | null {
  try {
    // sheet.href 就是这份 CSS 自己的地址。它可能为 null（内联 <style>），
    // 那种情况下相对路径的基准本来就是页面，退回页面 URL 是对的。
    return new URL(reference, sheetHref ?? document.baseURI).href
  } catch {
    return null
  }
}

/**
 * 把 `@font-face` 的字体读成 data URL。
 *
 * 两条实测得到的规矩，都不能省：
 *
 * 1. **只留 woff2。** 每个 `@font-face` 的 `src` 里有三种格式（woff2/woff/ttf），
 *    三种都内联等于把同一份字体放三遍：KaTeX 的 20 个字体会从约 1MB 涨到近 3MB。
 *    浏览器只会用其中一种，其余两种连同它们指向外链的 `url()` 一起删掉。
 * 2. **一个都不能漏。** 留在样式里的相对路径（`fonts/xxx.woff`）在 `data:` 的 SVG 里
 *    解析不到，而**只要有一个外链字体，整张 SVG 就不加载**——不是那个字体退化，是整张
 *    图出不来（见 docs/export-pdf-image-plan.md）。所以取不到的字体要连 `src` 一起去掉，
 *    宁可让它用后备字体渲染，也不能留下一个外链。
 */
async function loadFontDataUrls(): Promise<Map<string, string>> {
  if (fontDataUrls) return fontDataUrls
  const found = new Map<string, string>()
  // 键是样式表里写的那个引用（重建 @font-face 时按它查），值是能直接 fetch 的绝对地址。
  const references = new Map<string, string | null>()

  // 相对路径必须**相对样式表本身**解析，不能相对页面。
  //
  // 这是公式导出空白了一整轮的根因（2026-10-09）：构建后 KaTeX 的字体引用被 Vite 改写成
  // `url(./KaTeX_Main-Regular-BQhdFMY1.woff2)`，它是相对 **CSS 文件所在目录**（assets/）的；
  // 而 `fetch('./KaTeX_...woff2')` 的基准是页面 URL，于是请求打到 renderer 根目录 → 404。
  // 字体拿不到，KaTeX 的私有区字形就画不出来，公式位置留下一片空白 —— 而它不报错，
  // 因为渲染本身是成功的。
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[]
    try {
      rules = Array.from(sheet.cssRules)
    } catch {
      // 跨源样式表读不到规则，跳过。
      continue
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      const source = rule.style.getPropertyValue('src')
      for (const match of source.matchAll(FONT_FACE_URL)) {
        const reference = match[1]
        if (/^data:/i.test(reference)) continue
        // 只要浏览器真正会用的那种格式。
        if (!/\.woff2(\?|$)/i.test(reference)) continue
        if (!references.has(reference)) {
          references.set(reference, resolveAgainstSheet(reference, sheet.href))
        }
      }
    }
  }

  // 逐个取，不并发：一次几十个请求容易被节流，而漏掉一个就废掉整张 SVG。
  for (const [reference, absolute] of references) {
    const cached = fontCache.get(reference)
    if (cached) {
      found.set(reference, cached)
      continue
    }
    if (!absolute) continue
    try {
      const response = await fetch(absolute)
      if (!response.ok) continue
      const bytes = new Uint8Array(await response.arrayBuffer())
      let binary = ''
      // 分块避免 apply 的参数上限，字体文件动辄几十 KB。
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      }
      const dataUrl = `data:font/woff2;base64,${btoa(binary)}`
      fontCache.set(reference, dataUrl)
      found.set(reference, dataUrl)
    } catch {
      // 取不到就交给下面的清理逻辑：连同它所在的 @font-face 一起去掉。
    }
  }

  fontDataUrls = found
  return found
}

/**
 * 样式表的规则文本，`@font-face` 的字体已内联。
 *
 * 导出给 Word 那条路复用（见 editor/mermaid-export.ts 的 mathPNG）：公式烧图同样要用
 * `foreignObject`，同样会踩「留下一个外链字体就整张 SVG 不加载」这个坑。这份实现只能有
 * 一份 —— 抄一遍就意味着下次修 bug 要记得修两处。
 */
export async function styleTextWithFontsInlined(): Promise<string> {
  const fonts = await loadFontDataUrls()
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      parts.push(Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n'))
    } catch {
      // 读不到的跳过，理由同 loadFontDataUrls。
    }
  }
  const text = parts.join('\n')

  // 逐个 @font-face 重建 src：只保留取到的 woff2。取不到就整条 src 去掉 —— 留下任何
  // 一个指向外链的 url() 都会让整张 SVG 不加载。
  return text.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    const declarations: string[] = []
    const family = /font-family\s*:\s*([^;}]+)/i.exec(block)?.[1]?.trim()
    if (!family) return block
    declarations.push(`font-family:${family}`)

    const weight = /font-weight\s*:\s*([^;}]+)/i.exec(block)?.[1]?.trim()
    if (weight) declarations.push(`font-weight:${weight}`)
    const style = /font-style\s*:\s*([^;}]+)/i.exec(block)?.[1]?.trim()
    if (style) declarations.push(`font-style:${style}`)
    const display = /font-display\s*:\s*([^;}]+)/i.exec(block)?.[1]?.trim()
    // 一律改成 swap，**不要照抄原来的值**。KaTeX 用的是 `font-display:block`，它的含义是
    // 「字体没就绪就不画字」——在网页里这是为了避免公式闪一下换字体，但在我们这条路上
    // 是致命的：整张 SVG 只在 canvas 上光栅化一次，没有「稍后字体到了再重画」这回事，
    // 于是公式位置留下一片空白（2026-10-09 实测）。`swap` 让字形立刻用可用字体画出来。
    declarations.push(`font-display:swap`)
    void display

    // 这个 @font-face 用到的、已经拿到手的数据 URL。
    const sources: string[] = []
    for (const match of block.matchAll(FONT_FACE_URL)) {
      const reference = match[1]
      const dataUrl = fonts.get(reference) ?? fonts.get(reference.replace(/^\.\//, ''))
      if (dataUrl && !sources.includes(dataUrl)) sources.push(dataUrl)
    }
    if (sources.length === 0) return '' // 一条都拿不到：整块丢掉，不给外链留位置
    declarations.push(`src:${sources.map((url) => `url("${url}") format("woff2")`).join(',')}`)
    return `@font-face{${declarations.join(';')}}`
  })
}

/** 序列化时只补这些属性；它们决定了背景、文字与边框，是样式表在 foreignObject 里最容易丢的部分。 */
const INLINE_PROPERTIES = [
  'background-color', 'color', 'font-family', 'font-size', 'font-style', 'font-weight',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration-color', 'text-decoration-line',
  'vertical-align', 'white-space', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'list-style-type', 'display', 'width', 'max-width', 'height', 'overflow-wrap', 'word-break',
]

const SKIP_VALUES = new Set(['', 'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'transparent'])

/**
 * 克隆节点树，把关键样式写成 inline。
 *
 * **已经有 style 属性的节点不动它**：整体覆盖 computed style 会抹掉原有的 inline
 * style。探针第一版就是这么写的，结果 40 个纯色块全变白，一度让人以为 foreignObject
 * 不支持 CSS 背景色（见 docs/export-pdf-image-plan.md）。
 */
function inlineStyles(root: HTMLElement): HTMLElement {
  const clone = root.cloneNode(true) as HTMLElement
  const source = [root]
  const target = [clone]
  while (source.length > 0) {
    const from = source.pop() as HTMLElement
    const to = target.pop() as HTMLElement
    if (!to.hasAttribute('style')) {
      const computed = getComputedStyle(from)
      const declarations: string[] = []
      for (const property of INLINE_PROPERTIES) {
        const value = computed.getPropertyValue(property)
        if (!value || SKIP_VALUES.has(value.trim())) continue
        declarations.push(`${property}:${value}`)
      }
      if (declarations.length > 0) to.setAttribute('style', declarations.join(';'))
    }
    const fromChildren = Array.from(from.children) as HTMLElement[]
    const toChildren = Array.from(to.children) as HTMLElement[]
    for (let index = 0; index < fromChildren.length; index++) {
      source.push(fromChildren[index])
      target.push(toChildren[index])
    }
  }
  return clone
}

/** 图片全部就绪后才画，否则图会缺。 */
async function waitForImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.all(images.map((image) => image.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => resolve(), { once: true })
    })))
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * 样式文本按 XML 规则转义，才能放进 SVG 的 `<style>` 里。
 *
 * 为什么必须做：HTML 里 `<style>` 的内容是 CDATA，`<` 和 `&` 随意；而我们把整张 SVG
 * 交给 `image.src` 时它按 **XML** 解析，裸的 `<` 或 `&` 会让解析器直接报格式错误 ——
 * 表现是**整张图加载失败**，不是某个样式失效。
 *
 * 踩到的正是注释：`editor-preview.css` 里写着「注入到 <head> 末尾」「不用真 <pre>」，
 * `premium.css` 里写着「writing & reading apps」。这些注释在屏幕上毫无影响，却足以让
 * PDF 与图片导出全灭（2026-10-09，靠弹框里的尺寸+样式体积加上逐个文件检索才定位到）。
 *
 * `&` 必须先换，否则会把后面替换出的 `&lt;` 再转一次。
 */
export function escapeForXML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 把文档**准备**成可以渲染的素材：内联样式后的 body、内联字体后的样式表、整篇宽高。
 *
 * 准备是导出里最贵的一步——`inlineStyles` 克隆整篇 DOM 并逐节点 `getComputedStyle`，
 * `styleTextWithFontsInlined` 遍历所有样式表并重写 @font-face。超长文档逐页渲染时，
 * 这一步只需做一次，之后每页只改 SVG 的视口与偏移。所以把它单独拎出来，供逐页路径复用。
 */
export interface PreparedDocument {
  /** 内联字体后的样式表文本（未做 XML 转义）。 */
  styles: string
  /** 内联样式后、序列化好的整篇 body。 */
  body: string
  /** 整篇 CSS 宽度。 */
  width: number
  /** 整篇 CSS 高度。 */
  fullHeight: number
}

export async function prepareDocument(root: HTMLElement): Promise<PreparedDocument> {
  await document.fonts.ready.catch(() => undefined)
  await waitForImages(root)
  await nextFrame()

  const width = Math.ceil(root.scrollWidth || root.getBoundingClientRect().width)
  const fullHeight = Math.ceil(root.scrollHeight || root.getBoundingClientRect().height)
  if (width <= 0 || fullHeight <= 0) throw new Error('没有可导出的内容')

  // 每步都带上名字：这几种失败的原因完全不同（字体没拿到、序列化坏了、SVG 解码失败、
  // 画布超限），而它们最终都只是「导出没完成」。名字进弹框，才能一眼看出该修哪儿。
  let styles = ''
  try {
    styles = await styleTextWithFontsInlined()
  } catch (error) {
    throw new Error(`收集样式失败（${width}×${fullHeight}）：${error instanceof Error ? error.message : String(error)}`)
  }

  let body = ''
  try {
    body = new XMLSerializer().serializeToString(inlineStyles(root))
  } catch (error) {
    throw new Error(`序列化文档失败（${width}×${fullHeight}）：${error instanceof Error ? error.message : String(error)}`)
  }

  return { styles, body, width, fullHeight }
}

/**
 * 把一篇**已经准备好**的文档的一段竖直区间光栅化成画布。
 *
 * `slice` 为 null 时渲染整篇；否则只渲染 `[top, top+height)` 这一段。无论哪种，内容都
 * 按整篇排版（同一个 width），只是 SVG 高度收窄、内容整体上移 offset，所以行高、表格
 * 边框都不会因为切片而变。
 */
export async function renderPrepared(
  prepared: PreparedDocument,
  scale: number,
  background: string,
  slice: { top: number; height: number } | null,
): Promise<RenderedCanvas> {
  const { styles, body, width, fullHeight } = prepared
  // 要画的这一段高度。不指定就画整篇。
  const offset = slice ? Math.max(0, Math.min(slice.top, fullHeight)) : 0
  const height = slice
    ? Math.max(1, Math.ceil(Math.min(slice.height, fullHeight - offset)))
    : fullHeight

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="height:${height}px;overflow:hidden">`
    + `<style>${escapeForXML(styles)}</style>`
    + `<div style="margin-top:${-offset}px">${body}</div>`
    + `</div>`
    + `</foreignObject></svg>`

  const image = new Image()
  image.width = width
  image.height = height

  // 先试 data: URL。它最直接，但长度有实际限制：一份带 20 个内联字体的样式表
  // 就能到 1MB 上下，而超长的 data: URL 会被浏览器拒绝。失败就换 Blob URL 重试——
  // 字体已经内联在文档里，Blob URL 同样不依赖外部资源，且没有长度限制。
  const decode = (src: string): Promise<boolean> => new Promise((resolve) => {
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
    image.src = src
  })

  let loaded = await decode(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  if (!loaded) {
    const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    try {
      loaded = await decode(blobUrl)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }
  if (!loaded) {
    throw new Error(
      `SVG 解码失败（内容 ${width}×${height}，样式 ${Math.round(styles.length / 1024)}KB，`
      + `文档 ${Math.round(body.length / 1024)}KB）。`
      + '原因通常是文档里有外部资源没能内联，或者尺寸超出上限。',
    )
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  // 画布超限时不要硬画：拿不到画布或 drawImage 抛错都只会留下一句「导出没完成」。
  // 上限按设备像素算，理由同 Electron 版（CSS 像素直接比会在 2 倍屏上放过一倍）。
  if (canvas.width > MAX_CAPTURE_EDGE_PX || canvas.height > MAX_CAPTURE_EDGE_PX) {
    throw new Error(
      `内容太高，一张画布放不下（${canvas.width}×${canvas.height} 设备像素，上限 ${MAX_CAPTURE_EDGE_PX}）。`,
    )
  }
  const context = canvas.getContext('2d')
  if (!context) throw new Error('拿不到 2d 画布')
  context.fillStyle = background === 'rgba(0, 0, 0, 0)' ? '#ffffff' : background
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return { canvas, width, height, scale }
}

/**
 * 把一个元素渲染成画布。
 *
 * 高度由元素的 scrollHeight 决定，所以调用方要先把文档摊平（print-layout 的
 * enterPaperLayout 做这件事），否则拿到的是视口那一屏。
 *
 * 短文档（装得下一张画布）直接整篇渲一次；长文档的逐页渲染应改用 `prepareDocument` +
 * `renderPrepared` 复用素材，避免每一页都重做内联与序列化。
 */
export async function renderToCanvas(
  element: HTMLElement | null,
  options: RenderOptions = {},
): Promise<RenderedCanvas> {
  const root = element ?? document.querySelector<HTMLElement>('#editor .cm-content') ?? document.body
  const scale = options.scale ?? Math.min(window.devicePixelRatio || 1, 2)
  const background = options.background ?? getComputedStyle(document.body).backgroundColor ?? '#ffffff'
  const slice = options.slice ?? null

  const prepared = await prepareDocument(root)
  return renderPrepared(prepared, scale, background, slice)
}

/** 画布的一部分，用来做分页。 */
export function cropCanvas(source: HTMLCanvasElement, y: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('拿不到 2d 画布')
  context.drawImage(source, 0, y, source.width, height, 0, 0, source.width, height)
  return canvas
}

/** 画布转 PNG 字节。 */
export function canvasToPNG(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('画布转 PNG 失败'))
        return
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
    }, 'image/png')
  })
}

/** 捕获表面单边上限。Electron 版实测 16384 有图、16800 返回空，这里的判据用设备像素。 */
export const MAX_CAPTURE_EDGE_PX = 16384
