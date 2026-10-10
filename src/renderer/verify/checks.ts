// 验收检查项，随包编译进渲染层，由验收脚本按名字触发。
//
// 为什么不是脚本里的一段字符串：验收脚本原先是把要在页面里跑 JS 源码交给应用的。
// 系统 WebView 的页面有 CSP，`new Function` 被拦（而且不该为了测试把 'unsafe-eval'
// 放开），旧脚本之所以能跑是因为 Chrome DevTools 协议的 Runtime.evaluate 绕过 CSP。
// 把检查项写成随包编译的模块，就不需要 eval：类型检查能覆盖它，CSP 也不用松。
//
// 名字由环境变量 COLAMD_VERIFY 传给壳，结果写到 COLAMD_VERIFY_OUT。

import { runExportCheck } from './export-check'
import { runFeaturesCheck } from './features-check'

export interface ScrollSample {
  position: number
  waited: number
  top: number
  rows: number
  /** 视口里还带着原始 markdown 标记的行数。必须是 0。 */
  raw: number
  /** 视口里带装饰的行数。必须大于 0，否则说明装饰根本没铺上来。 */
  decorated: number
  first: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 进度写进应用的日志通道（渲染层没有控制台可用），卡住时能看出卡在哪一步。 */
function note(message: string): void {
  void window.loomark?.logRendererError(`[verify] ${message}`)
}

function scroller(): HTMLElement | null {
  return document.querySelector('.cm-scroller')
}

/** 视口里现在可见的行，以及它们的装饰情况。 */
function observe(): Omit<ScrollSample, 'position' | 'waited'> {
  const s = scroller()
  if (!s) throw new Error('找不到 .cm-scroller')
  const sr = s.getBoundingClientRect()
  const lines = [...document.querySelectorAll('#editor .cm-line')].filter((line) => {
    const r = (line as HTMLElement).getBoundingClientRect()
    return r.bottom > sr.top && r.top < sr.bottom
  })
  return {
    top: Math.round(s.scrollTop),
    rows: lines.length,
    raw: lines.filter((line) => (line.textContent ?? '').includes('**')).length,
    decorated: lines.filter((line) => line.querySelector('[class*="cm-md"]') !== null).length,
    first: (lines[0]?.textContent ?? '').slice(0, 40)
  }
}

/**
 * 滚到几个位置，每个位置必须：视口里没有原始标记，且装饰已经铺上来。
 *
 * 装饰是从语法树上读的，而语法树按视口惰性解析，所以要轮询等它铺到视口，而不是睡一个
 * 固定时长（2026-09-26：固定 1600ms 在连续跑测试时会假红）。
 */
export async function runScrollRenderCheck(positions: number[] = [0, 30000, 60000, 999999]): Promise<ScrollSample[]> {
  // 先等文档真的进到编辑器里。壳把检查项交给渲染层时，启动参数里的文件可能还没载入完
  // （2026-10-09：漏了这一步，量到的是欢迎页，四个位置全部"通过"，是假绿）。
  note('waiting for the document')
  for (let i = 0; i < 80; i++) {
    if (document.querySelectorAll('#editor .cm-line').length > 5) break
    await sleep(250)
  }
  note(`document present: ${document.querySelectorAll('#editor .cm-line').length} lines`)

  const samples: ScrollSample[] = []
  for (const position of positions) {
    const s = scroller()
    if (!s) throw new Error('找不到 .cm-scroller')
    s.scrollTop = position
    let state = observe()
    const started = Date.now()
    for (let i = 0; i < 25; i++) {
      state = observe()
      if (state.raw === 0 && state.decorated > 0) break
      await sleep(200)
    }
    note(`position ${position}: raw=${state.raw} decorated=${state.decorated} rows=${state.rows}`)
    samples.push({ position, waited: Date.now() - started, ...state })
  }
  return samples
}

// ─── 主题验收 ────────────────────────────────────────────────────────────────
//
// 主题文件（themes/*.css）里的每一条规则都必须命中真实的元素，并且真的改变至少一条
// 计算样式。为什么要有这条断言：换编辑器内核时 ProseMirror 的 DOM 没了，主题文件里
// 一堆 `#editor .ProseMirror strong` 就永远匹配不到东西——不报错、不崩溃，只是「下载了
// 主题，加粗和标题的颜色却没变」。这类失效肉眼只在换主题的瞬间看得出来。
//
// 判定方式是从上游 colamd `scripts/verify-themes.mjs`（1e9b481）搬过来的：把待测 CSS
// 拆成「一条规则一张表」，全部禁用后按需开关，量这一条的净效果。好处是不用在测试里抄
// 一遍颜色值，主题改了测试不用跟着改。
//
// 与上游的差别只有两点，都是通道带来的：
//   - 上游走 CDP 的 Emulation.setDeviceMetricsOverride 把视口拉到 2600 高；系统 WebView
//     没有 CDP，改由壳在 COLAMD_VERIFY 时把窗口开得足够高（src-tauri/src/windows.rs）。
//     CodeMirror 只为视口内的行建 DOM，窗口不够高的话夹具下半段根本不渲染。
//   - 上游把探针源码用 Runtime.evaluate 送进页面；页面 CSP 不许 eval，所以探针写在这里。

/** 一个主题文件的验收结果。 */
export interface ThemeReport {
  file: string
  /** 文件里的顶层规则条数（@media 这类 at-rule 不计）。 */
  rules: number
  /** 确有作用的规则数，0 说明这个主题是个空壳。 */
  effective: number
  /** 命中不到任何元素的规则。每一条都是失效的选择器。 */
  dead: string[]
  /** :hover / ::before 这类当前量不出差别的选择器，不算失败。 */
  interactive: string[]
  /** 变量规则声明了但没生效的变量（`--x=#fff`）。 */
  wrongVars: string[]
}

export interface ThemeSample {
  file: string
  selector: string
  changed: number
  sample: string[]
}

export interface ThemeCheckResult {
  files: ThemeReport[]
  /** 有作用但没量到差别的规则，取样几条，卡住时能看出是哪种规则。 */
  unchanged: ThemeSample[]
}

/** 注入探针用的属性，方便清理，也避免和页面上别的 style 混起来。 */
const PROBE_ATTR = 'data-theme-probe'

interface ProbeSheet {
  el: HTMLStyleElement
  rule: CSSStyleRule
  index: number
  /** 变量规则一直开着，见 loadThemeCss 里的注释。 */
  isVars: boolean
}

/** 计算样式的全量快照。逐属性比，不抄颜色值。 */
function snapshotOf(el: Element): Map<string, string> {
  const cs = getComputedStyle(el)
  const out = new Map<string, string>()
  for (const prop of cs) out.set(prop, cs.getPropertyValue(prop))
  return out
}

function probeSheets(): HTMLStyleElement[] {
  return [...document.querySelectorAll<HTMLStyleElement>(`style[${PROBE_ATTR}]`)]
}

/**
 * 装入一份待测 CSS：拆成一条规则一张表，默认全部禁用（变量规则除外），返回规则条数。
 *
 * 单独成表是为了隔离：一套主题里几条规则可能命中同一个元素，整表开关量不出是哪条在
 * 起作用。变量规则必须一直开着，别的规则里可能用 var() 引用它们，变量缺席时那条规则
 * 量出来也是「没效果」，会被误判成失效。
 */
function loadThemeCss(css: string): number {
  for (const el of probeSheets()) el.remove()

  const parsed = document.createElement('style')
  parsed.setAttribute(PROBE_ATTR, 'parse')
  parsed.textContent = css
  document.head.appendChild(parsed)
  const list = [...(parsed.sheet?.cssRules ?? [])] as CSSRule[]
  parsed.remove()

  list.forEach((rule, index) => {
    const el = document.createElement('style')
    el.setAttribute(PROBE_ATTR, String(index))
    el.textContent = rule.cssText
    const style = (rule as CSSStyleRule).style
    const isVars =
      style !== undefined && style.length > 0 && [...style].every((prop) => prop.startsWith('--'))
    document.head.appendChild(el)
    // 先插入再禁用：元素进文档之前写 disabled 没有任何效果，sheet 会在插入时新建出来
    // 并保持启用（上游的「与默认值相同」曾经全是假绿，12 个主题，就是这么来的）。
    if (!isVars) el.disabled = true
    sheets.push({ el, rule: rule as CSSStyleRule, index, isVars })
  })
  return list.length
}

let sheets: ProbeSheet[] = []

/**
 * 一条规则：命中几个元素，或者它的变量有没有真的取到值。
 *
 * `kind` 是判定用的分类：`at` 不是选择器规则（跳过），`vars` 只查变量，
 * `interactive` 是 :hover / ::before 这类当前量不出差别的（跳过，不算失败），
 * `rule` 才是「命中数 + 计算样式」那条路。
 */
function describeRule(index: number): {
  selector: string
  kind: 'at' | 'vars' | 'interactive' | 'rule'
  matches: number
  wrong: string[]
} {
  const entry = sheets.find((sheet) => sheet.index === index)
  if (!entry) throw new Error(`没有第 ${index} 条规则`)
  const { rule } = entry
  if (rule.selectorText === undefined) {
    return { selector: rule.cssText.slice(0, 60), kind: 'at', matches: -1, wrong: [] }
  }
  const selector = rule.selectorText
  if (entry.isVars) {
    const html = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    const declared = [...rule.style].map((prop) => [prop, rule.style.getPropertyValue(prop).trim()] as const)
    const wrong = declared
      .filter(([prop, value]) => html.getPropertyValue(prop).trim() !== value || body.getPropertyValue(prop).trim() !== value)
      .map(([prop, value]) => `${prop}=${value}`)
    return { selector, kind: 'vars', matches: 1, wrong }
  }
  if (/:hover|:focus|::|:has\(/.test(selector)) {
    return { selector, kind: 'interactive', matches: -2, wrong: [] }
  }
  return { selector, kind: 'rule', matches: document.querySelectorAll(selector).length, wrong: [] }
}

/**
 * 开关这一条规则，看它有没有真的改变计算样式。
 *
 * 关着的是这**一条**，其余规则（包括变量）保持装载状态，所以量到的是这一条的净效果。
 */
function measureRule(index: number, limit = 3): { changed: number; sample: string[] } {
  const entry = sheets.find((sheet) => sheet.index === index)
  if (!entry || entry.isVars) return { changed: 0, sample: [] }
  const nodes = [...document.querySelectorAll(entry.rule.selectorText)].slice(0, limit)
  if (nodes.length === 0) return { changed: 0, sample: [] }

  const before = nodes.map(snapshotOf)
  entry.el.disabled = false
  const after = nodes.map(snapshotOf)
  entry.el.disabled = true

  let changed = 0
  const sample: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (const [prop, value] of after[i]) {
      if (before[i].get(prop) === value) continue
      changed++
      if (sample.length < 3) sample.push(`${prop}: ${before[i].get(prop)} → ${value}`)
    }
  }
  return { changed, sample }
}

/**
 * 逐条量一个主题文件：命中不到元素 = 失败，整份下来一条都没作用 = 空壳。
 *
 * `source` 是文件原文；文件名只用于报告。
 */
export function runThemeCheck(source: string, file: string): ThemeReport {
  const total = loadThemeCss(source)
  const report: ThemeReport = { file, rules: 0, effective: 0, dead: [], interactive: [], wrongVars: [] }

  for (let index = 0; index < total; index++) {
    const rule = describeRule(index)
    if (rule.kind === 'at') continue
    report.rules++
    if (rule.kind === 'interactive') {
      report.interactive.push(rule.selector)
      continue
    }
    if (rule.kind === 'vars') {
      if (rule.wrong.length > 0) report.wrongVars.push(...rule.wrong)
      else report.effective++
      continue
    }
    if (rule.matches === 0) {
      report.dead.push(rule.selector)
      continue
    }
    const measured = measureRule(index)
    if (measured.changed > 0) report.effective++
    else report.interactive.push(rule.selector)
  }
  return report
}

/** 页面上是不是真有一份渲染好的文档，而不是欢迎页。 */
function fixtureReady(): boolean {
  const lines = document.querySelectorAll('#editor .cm-line').length
  const widget = document.querySelector('#editor .cm-md-table-widget th')
  const heading = document.querySelector('#editor .cm-md-atxheading1')
  return lines > 10 && widget !== null && heading !== null
}

/**
 * 主题验收：把每个主题文件逐条量一遍，返回给脚本判定。
 *
 * 这里只量、不判定——红绿由脚本打印，所以 `npm run verify:themes` 的终端输出与 CI 读的是
 * 同一份数据。量之前必须确认夹具真的进了编辑器：量到欢迎页的话，每条规则都命中不到元素，
 * 那不是主题坏了，是它没在测主题。
 */
export async function runThemeCheckSuite(files: Record<string, string>): Promise<ThemeCheckResult> {
  const names = Object.keys(files).sort()
  note(`themes: waiting for the fixture (${names.length} files)`)

  let ready = false
  for (let i = 0; i < 80; i++) {
    if (fixtureReady()) {
      ready = true
      break
    }
    await sleep(250)
  }
  const lines = document.querySelectorAll('#editor .cm-line').length
  note(`themes: fixture ready=${ready}, ${lines} lines`)
  if (!ready) throw new Error(`夹具没进编辑器（只有 ${lines} 行，或表格/标题还没渲染出来）`)

  // 复现「用户下载了一个主题文件」的那条路径：内置主题类全部摘掉，只留 theme-custom。
  // 主题文件里的规则本来就写成 `#editor .cm-content .cm-md-*`，不挂这个类也照样命中，
  // 但上游是这么做的，保持同一个起点。
  document.body.className = document.body.className.replace(/theme-[a-z-]+/g, '').trim()
  document.body.classList.add('theme-custom')

  const result: ThemeCheckResult = { files: [], unchanged: [] }
  for (const file of names) {
    const report = runThemeCheck(files[file], file)
    result.files.push(report)
    note(`themes: ${file} rules=${report.rules} effective=${report.effective} dead=${report.dead.length}`)
  }
  for (const el of probeSheets()) el.remove()
  return result
}

/** 验收脚本按名字要的那一项。 */
export const CHECKS: Record<string, () => Promise<unknown>> = {
  'scroll-render': () => runScrollRenderCheck(),
  themes: () => runThemeCheckSuite(window.__loomarkVerifyThemes ?? {}),
  features: () => runFeaturesCheck(),
  // 三条导出共用一份检查：量的是同一条渲染链路（文档 → 位图 → 字节），
  // 分开只是让脚本按名字要哪一条都能拿到同一份数据。
  'export-pdf': () => runExportCheck(),
  'export-image': () => runExportCheck(),
  'export-docx': () => runExportCheck()
}
