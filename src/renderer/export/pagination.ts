// 分页：把「一页能装多高」翻译成「这一页到哪里为止」。
//
// 为什么需要这一层：PDF 导出原来是按固定像素高度硬切的（`index * cssPerPage`），
// 完全不看文档结构。后果是**表格被拦腰截断**——上半截留在这一页，下半截跑到下一页；
// 标题也会落在页尾，正文翻到下一页去（2026-10-09 报的）。
//
// 这里只做一件事：给定「切点最多能到 Y」和文档里各块的矩形，往前找一个**合法断点**。
// 合法断点 = 不切开任何一个块的位置。
//
// 一条必须守住的取舍：**块比一页还高时，断点只能落回块内部**。长表格、长代码块就是
// 这种情况，无论怎么挪都放不下一页。这时的策略是「不硬塞、也不留空白」：让它在行边界
// 处断开（见 `breakInside`），读者看得出是续页，内容一个字节都不丢。

/** 文档里一个块占据的垂直区间，相对于内容顶部，单位 CSS 像素。 */
export interface BlockBounds {
  /** 块的类型，决定它「允不允许被切开」。 */
  kind: BlockKind
  top: number
  bottom: number
}

/**
 * 块的类型。
 *
 * 区分它们不是为了好看：有些块**绝对不能被切开**（表格被切一半读不出来、图片被切一半
 * 是坏的、公式被切一半是错的），有些块切开了仍然能读（一个很长的代码块、一串很长的
 * 段落），后者在「块比一页还高」时是唯一的出路。
 */
export type BlockKind =
  /** 表格、图片、公式、图表：整体不可分。 */
  | 'atomic'
  /** 代码块、引用、列表：整块尽量不分，但太高时可以在行间断开。 */
  | 'breakable'
  /** 普通段落行：天然可在行间断开。 */
  | 'line'

/** 一个内容块的可断点信息，按 top 升序。 */
export interface BreakPlan {
  /**
   * 给定「这一页最多装到 `limit`」，返回这一页的实际结束位置（CSS 像素）。
   *
   * 返回值保证 >= `start`：一页至少要装下一点东西，否则会死循环。
   */
  nextBreak(start: number, limit: number): number
}

/**
 * 从块的矩形算出分页计划。
 *
 * 规则，按优先级：
 *   1. `limit` 落在某个块**内部**时，往前退到这个块的上边（块整体挪到下一页）。
 *   2. 退无可退（块的上边就在页首，即这个块比一页还高）时，接受在块内断开，
 *      但断点放在块内某个「行边界」上——由调用方给出的候选列表决定。
 *   3. `limit` 落在块与块之间（空隙）时直接用 `limit`。
 */
export function planBreaks(blocks: readonly BlockBounds[], lineStops: readonly number[]): BreakPlan {
  // 只在文档里的行边界上断开，避免把一行文字切成上下两半。
  // 去重：上一行的 bottom 往往就是下一行的 top（相邻行共享一条边），长文档会有大量
  // 重复值，去重后二分查找的数组短一半、跳得快。
  const stops = Array.from(new Set(lineStops)).sort((a, b) => a - b)

  /** 找到 <= value 的最大行边界。没有就返回 value 本身。 */
  const floorStop = (value: number): number => {
    let low = 0
    let high = stops.length - 1
    let best = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (stops[mid] <= value) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return best === -1 ? value : stops[best]
  }

  /** 哪个块盖住了这个位置（严格在内部才算盖住）。 */
  const blockAt = (pos: number): BlockBounds | null => {
    for (const block of blocks) {
      if (pos > block.top && pos < block.bottom) return block
    }
    return null
  }

  return {
    nextBreak(start: number, limit: number): number {
      if (limit <= start) return start
      const covering = blockAt(limit)

      // 落在空隙里：只要不被某一行切断，就地断。
      if (!covering) {
        const stop = floorStop(limit)
        return stop > start ? stop : limit
      }

      // 落在块内部：能整块挪走就挪走。
      const snapped = floorStop(covering.top)
      if (snapped > start) return snapped

      // 块从页首就开始了（比一页还高）：只能在块内断，退到最近的行边界。
      if (covering.top <= start) {
        const inside = floorStop(limit)
        // 一个行边界都没跨过，说明这一页连一行都装不下，用 limit 兜底，
        // 否则 nextBreak 会一直返回 start，调用方会空转。
        return inside > start ? inside : limit
      }

      return covering.top > start ? covering.top : limit
    },
  }
}

/**
 * 从摊平后的编辑器 DOM 里量出块的矩形与行边界。
 *
 * 量的是「相对于内容根节点顶部」的偏移：导出就是把整篇内容当成一张连续的纸来切的，
 * 所以基准点必须与画布一致。
 *
 * 只量**块级**元素。行内元素（加粗、链接）不参与分页：它们跟着所在行一起走。
 */
export function measureBlocks(root: HTMLElement): { blocks: BlockBounds[]; lineStops: number[] } {
  const base = root.getBoundingClientRect().top
  const blocks: BlockBounds[] = []
  const lineStops: number[] = []

  const push = (el: Element, kind: BlockKind): void => {
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) return
    blocks.push({ kind, top: rect.top - base, bottom: rect.bottom - base })
  }

  // 不可切开的块：表格、图片、公式、图表、HTML 块。选择器与 live-preview 画出来的
  // 类名一致（那是这些元素在 DOM 里唯一的标记）。图片是 `.cm-md-image`（见 live-preview
  // 的 ImageWidget），漏掉它会让大图被拦腰截断。
  for (const el of Array.from(root.querySelectorAll('.cm-md-table-widget'))) push(el, 'atomic')
  for (const el of Array.from(root.querySelectorAll('.cm-md-math-block, .katex-display'))) push(el, 'atomic')
  for (const el of Array.from(root.querySelectorAll('.cm-md-mermaid'))) push(el, 'atomic')
  for (const el of Array.from(root.querySelectorAll('.cm-md-image'))) push(el, 'atomic')
  for (const el of Array.from(root.querySelectorAll('.cm-md-html-block'))) push(el, 'atomic')
  // 空行不构成可切位置，跳过。
  for (const el of Array.from(root.querySelectorAll('.cm-md-codeblock, .cm-md-blockquote'))) push(el, 'breakable')

  // 行边界：每一行文字的上边都是可以断开的地方。这里取 `.cm-line` 的上边，
  // 它是编辑器里真正的行；表格、图表这些跨行的块在上面的 loop 里已经被当成整块了。
  for (const el of Array.from(root.querySelectorAll('.cm-line'))) {
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) continue
    lineStops.push(rect.top - base)
    lineStops.push(rect.bottom - base)
  }
  // 表格行（`tr`）也要当可断边界：一个比一页还高的表格内部没有 `.cm-line`，只能在
  // 块内断开时，若不把 tr 的上边算进去，断点会落在某个单元格文字的正中间，把一行
  // 切成上下两半。这里只取「在某个 atomic 表格内部」的 tr，避免误伤其它结构。
  for (const el of Array.from(root.querySelectorAll('.cm-md-table-widget tr'))) {
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) continue
    lineStops.push(rect.top - base)
  }

  blocks.sort((a, b) => a.top - b.top)
  return { blocks, lineStops }
}
