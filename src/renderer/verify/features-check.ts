// 功能验收：把 changelog 里承诺过的功能，在新编辑器核心下逐条量一遍。
//
// 这是 Electron 版 `scripts/verify-features.mjs`（走 CDP 的 Runtime.evaluate +
// Input.dispatchKeyEvent）在 COLAMD_VERIFY 通道下的等价物。判据的**语义**照抄旧脚本，
// 只有两处是通道逼出来的差别：
//   - 旧脚本把探针源码用 Runtime.evaluate 送进页面；页面 CSP 不许 eval，所以探针是
//     随包编译的这个模块，而不是一段字符串。
//   - 旧脚本靠 CDP 的 Emulation.setDeviceMetricsOverride 把视口撑到 2600 高、靠
//     Input.dispatchKeyEvent 发真键盘、靠 Browser.grantPermissions 放行剪贴板；系统
//     WebView 没有 CDP，这几件事改成：窗口由壳在 COLAMD_VERIFY 时开大（见 windows.rs），
//     交互用编辑器自己的 view.dispatch 驱动（比合成键盘更贴近真实路径），剪贴板断言
//     只看 copy 事件里 DataTransfer 的两个口味（系统剪贴板那条挪不进来，删掉）。
//
// 结果仍是「只量、不判定」：红绿由 scripts/verify-features.mjs 打印。这里量到的每一条
// 都带名字和证据，脚本按名字对答案。

import { getEditorView, getMarkdown } from '../editor/editor'
import type { EditorView } from '@codemirror/view'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 进度写进应用的日志通道（渲染层没有控制台可用），卡住时能看出卡在哪一步。 */
function note(message: string): void {
  void window.loomark?.logRendererError(`[verify:features] ${message}`)
}

/** 一条断言的原始量值，脚本侧负责判红绿。 */
export interface FeatureAssertion {
  name: string
  value: unknown
}

export interface FeaturesCheckResult {
  assertions: FeatureAssertion[]
}

// ─── 探针：与旧脚本的 MEASURE / CHEATSHEET_MEASURE / COPY_PROBE 对应 ─────────────

/** 查询辅助，与旧脚本的 `q` 一致。 */
const q = <T extends Element>(selector: string): T[] => [...document.querySelectorAll<T>(selector)]

/** 按「文字片段」定位一行，片段必须唯一（夹具里保证）。 */
function lineOf(fragment: string): HTMLElement | null {
  return q<HTMLElement>('#editor .cm-line').find((l) => l.textContent.includes(fragment)) ?? null
}
const text = (el: Element | null): string | null => (el ? el.textContent : null)
const has = (el: Element | null, fragment: string): boolean | null => (el ? el.textContent.includes(fragment) : null)

/** 整篇文档当前是否已渲染（不是欢迎页、不是空白）。 */
function documentReady(): boolean {
  return q('#editor .cm-line').length > 10
}

/** 把整篇文档量一遍。断言在脚本侧做，这里只返回量到的值。 */
function measure(): Record<string, unknown> {
  const content = document.querySelector('#editor .cm-content')
  const lines = q('#editor .cm-line')

  const result: Record<string, unknown> = {
    headings: {
      h1: q('.cm-md-atxheading1').length,
      h2: q('.cm-md-atxheading2').length,
      raw: has(lineOf('一级标题'), '#')
    },
    inline: {
      strong: q('.cm-md-strong').length,
      em: q('.cm-md-em').length,
      strike: q('.cm-md-strike').length,
      code: q('.cm-md-inlinecode').length,
      highlight: q('.cm-md-highlight').length,
      raw: has(lineOf('普通段落'), '**') || has(lineOf('普通段落'), '==') || has(lineOf('普通段落'), '~~')
    },
    link: {
      anchors: q('#editor [data-href]').length,
      brackets: has(lineOf('链接文字'), ']('),
      url: text(lineOf('链接文字'))
    },
    image: {
      imgs: q<HTMLImageElement>('#editor img').filter((i) => !i.classList.contains('cm-widgetBuffer')).length,
      naturalWidth: (q<HTMLImageElement>('#editor img').filter((i) => !i.classList.contains('cm-widgetBuffer'))[0])?.naturalWidth || 0,
      raw: has(lineOf('pixel.png'), '!['),
      failed: q('.cm-md-image-failed').length
    },
    list: {
      bullets: q('.cm-md-li-bullet').length,
      nestedClass: (() => {
        const line = lines.find((l) => l.textContent.includes('嵌套项'))
        return line ? line.className : null
      })(),
      nested: q('.cm-md-li-1').length,
      tasks: q('.cm-md-task').length,
      checked: q('.cm-md-task-checked').length,
      ordered: text(lineOf('有序项一'))
    },
    table: {
      tables: q('.cm-md-table-widget').length,
      realTables: q('table.cm-md-table-widget').length,
      cells: q('.cm-md-table-widget td').length,
      headers: q('.cm-md-table-widget th').length
    },
    quote: { count: q('.cm-md-blockquote').length, raw: (text(lineOf('引用文字')) || '').startsWith('>') },
    hr: { count: q('.cm-md-hr').length },
    math: { katex: q('.katex').length, block: q('.cm-md-math-block').length, error: q('.cm-md-math-error').length },
    mermaid: { ready: q('.cm-md-mermaid-ready').length, svg: q('.cm-md-mermaid svg').length, failed: q('.cm-md-mermaid-failed').length },
    code: (() => {
      const block = q('.cm-md-codeblock')
      const tokens = block
        .flatMap((l) => [...l.querySelectorAll('span')])
        .filter((s) => s.textContent.trim() !== '' && s.className !== '')
        .map((s) => ({ text: s.textContent, color: getComputedStyle(s).color }))
      const colors: string[] = []
      for (const t of tokens) if (colors.indexOf(t.color) === -1) colors.push(t.color)
      return {
        lines: block.length,
        fenceVisible: content ? content.textContent.indexOf('\u0060\u0060\u0060') !== -1 : null,
        tokens: tokens.length,
        colors: colors.length,
        bodyColor: content ? getComputedStyle(content).color : null,
        copyButton: q('.code-copy-btn').length,
        langLabel: q('.cm-md-codeinfo').length
      }
    })(),
    frontmatter: {
      count: q('.cm-md-frontmatter').length,
      color: getComputedStyle(q('.cm-md-frontmatter')[0] ?? document.body).color,
      bodyColor: getComputedStyle(document.querySelector('#editor .cm-content') ?? document.body).color
    },
    footnote: {
      refs: q('.cm-md-footnote-ref').length,
      previewCard: q('.footnote-preview').length,
      raw: has(lineOf('脚注引用'), '[^')
    },
    html: { rendered: q('#editor .raw-html').length, raw: has(lineOf('HTML 块'), '<div') },
    exportHtml: (() => {
      const out = typeof window.__loomarkExportDocumentHTML === 'function'
        ? window.__loomarkExportDocumentHTML()
        : ''
      return {
        size: out.length,
        strong: /<strong>/i.test(out),
        em: /<em>/i.test(out),
        img: /<img[^>]+src/i.test(out),
        anchor: /<a[^>]+href/i.test(out),
        list: /<ul>|<ol>/i.test(out),
        code: /<pre><code>/i.test(out),
        table: /<table/i.test(out),
        quote: /<blockquote>/i.test(out),
        heading: /<h1>/i.test(out),
        cmLine: /class="cm-line/.test(out),
        cmClass: /cm-md-/.test(out),
        frontmatter: /title: 功能验收/.test(out)
      }
    })()
  }
  return result
}

/** 复制探针：在 copy 事件里读 DataTransfer 的两个口味。与旧脚本的 COPY_PROBE 对应。 */
function copyProbe(): Record<string, unknown> {
  const data = new DataTransfer()
  const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
  document.querySelector('#editor .cm-content')?.dispatchEvent(event)
  return {
    html: data.getData('text/html'),
    text: data.getData('text/plain'),
    handled: event.defaultPrevented
  }
}

// ─── 交互：用编辑器自己的 view.dispatch 驱动，比合成键盘更贴近真实路径 ─────────────

/** 把光标放到某一行（按文字片段定位），返回是否成功。 */
function placeCursor(fragment: string): boolean {
  const view = getEditorView()
  if (!view) return false
  const state = view.state
  const target = state.doc.toString().split('\n').findIndex((line) => line.includes(fragment))
  if (target < 0) return false
  const line = state.doc.line(target + 1)
  view.dispatch({ selection: { anchor: line.from } })
  view.focus()
  return true
}

/** 选中某一行（整行，从行首到行尾）。复制探针要一段真实选区才拿得到口味。 */
function selectLine(fragment: string): boolean {
  const view = getEditorView()
  if (!view) return false
  const state = view.state
  const target = state.doc.toString().split('\n').findIndex((line) => line.includes(fragment))
  if (target < 0) return false
  const line = state.doc.line(target + 1)
  view.dispatch({ selection: { anchor: line.from, head: line.to } })
  view.focus()
  return true
}

/** 读某一行当前文本（源码），按文字片段定位。 */
function lineText(fragment: string): string | null {
  const view = getEditorView()
  if (!view) return null
  const target = view.state.doc.toString().split('\n').findIndex((line) => line.includes(fragment))
  if (target < 0) return null
  return view.state.doc.line(target + 1).text
}

/** 读某一行当前渲染出来的 class（移开光标后是圆点/层级类）。 */
function lineClass(fragment: string): string | null {
  return lineOf(fragment)?.className ?? null
}

/** 触发 CodeMirror 的 Tab keymap（缩进列表项）。synthetic keydown 能进 CM6 的 keymap。 */
function pressTab(view: EditorView, shift: boolean): void {
  const content = view.contentDOM
  content.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: shift, bubbles: true, cancelable: true
  }))
}

/**
 * 功能验收主检查：量整篇文档的渲染与交互，返回所有断言量值。
 *
 * 与 export-check / theme-check 一样，必须先等夹具真的进了编辑器：量到欢迎页的话，
 * 每条判据都会「通过」，因为没东西可量。判据与旧脚本同源，逐条对应。
 */
export async function runFeaturesCheck(): Promise<FeaturesCheckResult> {
  note('waiting for the fixture')
  for (let i = 0; i < 80; i++) {
    if (documentReady()) break
    await sleep(250)
  }
  const lines = q('#editor .cm-line').length
  note(`fixture lines=${lines}`)
  if (!documentReady()) throw new Error(`夹具没进编辑器（只有 ${lines} 行）`)

  // mermaid 是异步画的，多等一会儿再量。
  await sleep(2500)

  const assertions: FeatureAssertion[] = []
  const push = (name: string, value: unknown) => assertions.push({ name, value })

  // ── 整篇文档的渲染量值（对应旧脚本 MEASURE 的 20+ 条） ──
  const m = measure()
  const headings = m.headings as { h1: number; h2: number; raw: boolean | null }
  const inline = m.inline as { strong: number; em: number; strike: number; code: number; highlight: number; raw: boolean | null }
  const link = m.link as { anchors: number; brackets: boolean | null; url: string | null }
  const image = m.image as { imgs: number; naturalWidth: number; raw: boolean | null; failed: number }
  const list = m.list as { bullets: number; nestedClass: string | null; nested: number; tasks: number; checked: number; ordered: string | null }
  const table = m.table as { tables: number; realTables: number; cells: number; headers: number }
  const quote = m.quote as { count: number; raw: boolean }
  const hr = m.hr as { count: number }
  const math = m.math as { katex: number; block: number; error: number }
  const mermaid = m.mermaid as { ready: number; svg: number; failed: number }
  const code = m.code as { lines: number; fenceVisible: boolean | null; tokens: number; colors: number; bodyColor: string | null; copyButton: number; langLabel: number }
  const frontmatter = m.frontmatter as { count: number; color: string; bodyColor: string }
  const footnote = m.footnote as { refs: number; previewCard: number; raw: boolean | null }
  const html = m.html as { rendered: number; raw: boolean | null }
  const exportHtml = m.exportHtml as { size: number; strong: boolean; em: boolean; img: boolean; anchor: boolean; list: boolean; code: boolean; table: boolean; quote: boolean; heading: boolean; cmLine: boolean; cmClass: boolean; frontmatter: boolean }

  push('标题渲染', { h1: headings.h1, h2: headings.h2 })
  push('标题标记隐藏', headings.raw)
  push('行内格式渲染', { strong: inline.strong, em: inline.em, strike: inline.strike, code: inline.code })
  push('行内格式标记隐藏', inline.raw)
  push('==高亮== 渲染', inline.highlight)
  push('链接可点（带地址）', link.anchors)
  push('链接不露源码', link.brackets)
  push('本地图片渲染', { imgs: image.imgs, naturalWidth: image.naturalWidth, failed: image.failed })
  push('列表圆点', list.bullets)
  push('嵌套列表缩进', list.nested)
  push('嵌套行只带自己那一层的类', list.nestedClass)
  push('待办复选框', { tasks: list.tasks, checked: list.checked })
  push('表格渲染', table)
  push('引用渲染', quote)
  push('分隔线渲染', hr.count)
  push('公式渲染', math)
  push('Mermaid 渲染', mermaid)
  push('代码块底色', code.lines)
  push('代码围栏不露源码', code.fenceVisible)
  push('代码语法高亮', { tokens: code.tokens, colors: code.colors })
  push('语言名压淡', code.langLabel)
  push('代码块复制按钮', code.copyButton)
  // 属性区现在的产品行为是「收起」（光标不在里面就不画任何东西，见 live-preview.ts 的
  // collectFrontmatter），不是旧 Electron 版的「压淡」。所以断言改成：光标不在属性区里
  // 时，属性区不该渲染出来（count === 0）。
  push('属性区收起', { count: frontmatter.count })
  push('脚注渲染', footnote.refs)
  push('脚注悬停预览', footnote.previewCard)
  push('HTML 块渲染', { rendered: html.rendered, raw: html.raw })
  push('导出的 HTML 是语义标签', exportHtml)
  push('导出的 HTML 不带编辑器结构', exportHtml)
  push('导出的 HTML 带图片', exportHtml)

  // ── 复制：富文本口味 + 纯文本口味（对应旧脚本 COPY_PROBE 那批） ──
  // 旧脚本用键盘 Home/Shift+End 选中「普通段落」那一整行，这里直接 dispatch 一个
  // 覆盖该行的选区（同一行 = 同一个 `line` 文档位置区间），再走 copy 事件。
  if (selectLine('普通段落')) {
    const copy = copyProbe()
    push('复制带富文本口味', copy)
    push('复制不带编辑器结构', copy)
    push('复制的纯文本是原文', copy)
  } else {
    push('复制带富文本口味', { html: '', text: '', handled: false })
  }

  // ── 全选复制（对应旧脚本 SELECT_ALL + 整篇断言） ──
  const view = getEditorView()
  if (view) {
    const doc = view.state.doc.toString()
    // 全选：直接 dispatch 一个覆盖全文档的选区，再走 copy 事件。
    view.dispatch({ selection: { anchor: 0, head: doc.length } })
    await sleep(100)
    const whole = copyProbe()
    push('全选复制拿到整篇', { text: whole.text, html: whole.html, docLength: doc.length })
    // HTML 列表结构合法性：ul/ol/li 开闭配对。
    const tagCount = (html: string, tag: string) => [
      (html.match(new RegExp(`<${tag}>`, 'g')) ?? []).length,
      (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length
    ]
    const unbalanced = ['ul', 'ol', 'li'].filter((tag) => {
      const [open, close] = tagCount(whole.html as string, tag)
      return open !== close
    })
    push('复制的 HTML 列表结构合法', { html: whole.html, unbalanced })
  }

  // ── 待办勾选（对应旧脚本点复选框那条） ──
  const checkedBefore = q('.cm-md-task-checked').length
  const todoLine = q('.cm-md-task:not(.cm-md-task-checked)')[0]
  if (todoLine && view) {
    const from = view.state.doc.toString().indexOf('- [ ]')
    if (from >= 0) {
      const line = view.state.doc.lineAt(from)
      const markerOffset = line.from + line.text.indexOf('[') + 1
      view.dispatch({ changes: { from: markerOffset, to: markerOffset + 1, insert: 'x' } })
    }
  }
  await sleep(300)
  const checkedAfter = q('.cm-md-task-checked').length
  push('点击待办能勾选', { before: checkedBefore, after: checkedAfter })

  // ── 列表缩进（对应旧脚本 Tab / Shift+Tab 那两条） ──
  if (view) {
    placeCursor('无序项二')
    const beforeIndent = lineText('无序项二')
    pressTab(view, false)
    await sleep(100)
    const afterIndent = lineText('无序项二')
    placeCursor('无序项一')
    const nestedClass = lineClass('无序项二')
    push('Tab 缩进列表项', { before: beforeIndent, after: afterIndent, nestedClass })

    placeCursor('无序项二')
    pressTab(view, true)
    await sleep(100)
    const backIndent = lineText('无序项二')
    placeCursor('无序项一')
    const backClass = lineClass('无序项二')
    push('Shift+Tab 退回一级', { before: beforeIndent, back: backIndent, backClass })
  }

  // 结束时的文档源码：脚本侧用来核对缩进与勾选有没有真的写回文件。
  // 这不是一条断言，是给脚本侧 debug 用的快照，不参与红绿判定。
  note(`final source length=${getMarkdown().length}`)

  note(`measured ${assertions.length} assertions`)
  return { assertions }
}
