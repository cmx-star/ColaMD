// 验收检查项，随包编译进渲染层，由验收脚本按名字触发。
//
// 为什么不是脚本里的一段字符串：验收脚本原先是把要在页面里跑 JS 源码交给应用的。
// 系统 WebView 的页面有 CSP，`new Function` 被拦（而且不该为了测试把 'unsafe-eval'
// 放开），旧脚本之所以能跑是因为 Chrome DevTools 协议的 Runtime.evaluate 绕过 CSP。
// 把检查项写成随包编译的模块，就不需要 eval：类型检查能覆盖它，CSP 也不用松。
//
// 名字由环境变量 COLAMD_VERIFY 传给壳，结果写到 COLAMD_VERIFY_OUT。

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
  void window.colamd?.logRendererError(`[verify] ${message}`)
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

/** 验收脚本按名字要的那一项。 */
export const CHECKS: Record<string, () => Promise<unknown>> = {
  'scroll-render': () => runScrollRenderCheck()
}
