#!/usr/bin/env node
// 功能验收：把 changelog 里承诺过的功能，在新编辑器核心下逐条量一遍。
//
// 为什么需要它：换核心（Milkdown/ProseMirror → CodeMirror 6 文本优先）会静默丢掉一批
// 「渲染 + 交互」能力——类型检查过得去，构建也过得去，只有真机上才看得出图片不显示、
// 脚注没预览、复制出来是源码。这个脚本把那些能力写成断言，量在页面里做
// （src/renderer/verify/features-check.ts），这里只判红绿。
//
// 与 Electron 版的差别，都是这条验证通道带来的：
//   - Electron 版用 Chrome DevTools 协议的 Runtime.evaluate 把探针源码送进页面；
//     系统 WebView 的页面有 CSP，`new Function` 被拦，所以探针随包编译（features-check.ts），
//     名字由 COLAMD_VERIFY=features 传给壳，结果写到 COLAMD_VERIFY_OUT。
//   - Electron 版靠 Emulation.setDeviceMetricsOverride 把视口撑到 2600 高；这里由壳在
//     COLAMD_VERIFY 时把窗口开大并放到屏幕外（src-tauri/src/windows.rs）。
//   - Electron 版靠 Input.dispatchKeyEvent 发真键盘、Browser.grantPermissions 放行剪贴板；
//     这里交互用编辑器自己的 view.dispatch 驱动，剪贴板断言只看 copy 事件里的 DataTransfer
//     两个口味（系统剪贴板那条挪不进来，删掉）。
//
// 用法: npm run verify:features（先 npm run build && npx tauri build --no-bundle）
// 窗口放在屏幕外，不占用屏幕。
//
// 曾经红着的两条断言（2026-10-10 迁移时实测，当天修好）：「本地图片渲染」与
// 「导出的 HTML 带图片」。根因是 `resolveImageSrc` 拿 `convertFileSrc(文档路径)` 当 base
// 去 `new URL(相对路径, base)`——asset 协议把整条路径编码成一个路径段，兄弟文件解析不出来，
// 图片触发 error 回退成源码，导出 HTML 里自然也没有 `<img>`。
// 修法：相对路径先在 `src/renderer/editor/image-path.ts` 里按「当前文档所在目录」拼成
// 绝对路径，再交给外壳的 `assetUrl`（platform-api）换成 asset 地址；CSP 的 `img-src`
// 同时补上 `asset:`。路径拼接那条有纯 Node 的 `npm run verify:links` 守着。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'
import { assertBuildFresh } from './build-freshness.mjs'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const { dir: WORK } = verifyWorkdir('features')
const BINARY = process.env.COLAMD_BINARY ?? join(APP, 'src-tauri', 'target', 'release', 'loomark')

/** 1×1 透明 PNG，用来验证本地图片能不能画出来（与 Electron 版逐字一致）。 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * 夹具：每一条对应 changelog 里一个承诺。断言按「文字片段」定位行，片段必须唯一。
 * 与 Electron 版逐字一致。
 */
function fixture() {
  return [
    '---',
    'title: 功能验收',
    'tags: [a, b]',
    '---',
    '',
    '# 一级标题',
    '',
    '普通段落，含 **加粗**、*斜体*、~~删除线~~、`行内代码`、==高亮==、',
    '[链接文字](https://example.com/a) 和 [站内跳转](#一级标题)。',
    '',
    '![本地图片](pixel.png)',
    '',
    '## 二级标题',
    '',
    '- 无序项一',
    '- 无序项二',
    '  - 嵌套项',
    '- [ ] 待办未完成',
    '- [x] 待办已完成',
    '',
    '1. 有序项一',
    '2. 有序项二',
    '',
    '> 引用文字',
    '> 引用第二行',
    '',
    '---',
    '',
    '```js',
    '// 注释一行',
    'const answer = 42',
    'function greet(name) {',
    "  return 'hi ' + name",
    '}',
    '```',
    '',
    '| 列甲 | 列乙 |',
    '| --- | --- |',
    '| 甲一 | 乙一 |',
    '',
    '行内公式 $a^2+b^2=c^2$ 与价格 $349。',
    '',
    '$$',
    '\\int_0^1 x^2 dx',
    '$$',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    '',
    '脚注引用[^note]。',
    '',
    '[^note]: 脚注定义内容。',
    '',
    '<div class="raw-html">HTML 块</div>',
    '',
  ].join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 逐条判红绿。value 是 features-check.ts 量回来的原始值。 */
function judge(name, value) {
  const bad = (detail) => ({ name, ok: false, detail })

  switch (name) {
    case '标题渲染': return value.h1 >= 1 && value.h2 >= 1 ? null : bad(`h1=${value.h1} h2=${value.h2}`)
    case '标题标记隐藏': return value === false ? null : bad(`行里还看得到 #: ${value}`)
    case '行内格式渲染': return value.strong >= 1 && value.em >= 1 && value.strike >= 1 && value.code >= 1
      ? null : bad(`strong=${value.strong} em=${value.em} strike=${value.strike} code=${value.code}`)
    case '行内格式标记隐藏': return value === false ? null : bad(`还看得到原始标记: ${value}`)
    case '==高亮== 渲染': return value >= 1 ? null : bad(`highlight=${value}`)
    case '链接可点（带地址）': return value >= 1 ? null : bad(`带 data-href 的元素=${value}`)
    case '链接不露源码': return value === false ? null : bad(`还看得到 ](: ${value}`)
    case '本地图片渲染': return value.imgs >= 1 && value.naturalWidth > 0
      ? null : bad(`img=${value.imgs} naturalWidth=${value.naturalWidth} 加载失败=${value.failed}`)
    case '列表圆点': return value >= 3 ? null : bad(`bullets=${value}`)
    case '嵌套列表缩进': return value >= 1 ? null : bad(`嵌套行=${value}`)
    case '嵌套行只带自己那一层的类':
      return (value ?? '').includes('cm-md-li-1') && !(value ?? '').includes('cm-md-li-0')
        ? null : bad(`嵌套行类=${value}`)
    case '待办复选框': return value.tasks >= 2 && value.checked >= 1
      ? null : bad(`tasks=${value.tasks} checked=${value.checked}`)
    case '表格渲染': return value.realTables >= 1 && value.cells >= 2
      ? null : bad(`表格=${value.tables} 真 table=${value.realTables} cells=${value.cells}`)
    case '引用渲染': return value.count >= 1 && value.raw === false
      ? null : bad(`count=${value.count} 露 >: ${value.raw}`)
    case '分隔线渲染': return value >= 1 ? null : bad(`hr=${value}`)
    case '公式渲染': return value.katex >= 2
      ? null : bad(`katex=${value.katex} block=${value.block} error=${value.error}`)
    case 'Mermaid 渲染': return value.ready >= 1 && value.svg >= 1
      ? null : bad(`ready=${value.ready} svg=${value.svg} failed=${value.failed}`)
    case '代码块底色': return value >= 3 ? null : bad(`codeblock 行=${value}`)
    case '代码围栏不露源码': return value === false ? null : bad(`正文里还看得到围栏: ${value}`)
    case '代码语法高亮': return value.tokens >= 8 && value.colors >= 4
      ? null : bad(`token=${value.tokens} 颜色种类=${value.colors}`)
    case '语言名压淡': return value >= 1 ? null : bad(`语言名标注=${value}`)
    case '代码块复制按钮': return value >= 1 ? null : bad(`按钮数=${value}`)
    case '属性区收起': return value.count === 0
      ? null : bad(`属性区不该渲染出来，却画了 ${value.count} 个（光标没在属性区里）`)
    case '脚注渲染': return value >= 1 ? null : bad(`refs=${value}`)
    case '脚注悬停预览': return value >= 1 ? null : bad(`预览卡片=${value}`)
    case 'HTML 块渲染': return value.rendered >= 1 ? null : bad(`rendered=${value.rendered} 露源码=${value.raw}`)
    case '导出的 HTML 是语义标签':
      return value.strong && value.em && value.anchor && value.list && value.code && value.table && value.quote && value.heading
        ? null : bad(`strong=${value.strong} em=${value.em} a=${value.anchor} ul=${value.list} pre=${value.code} table=${value.table} quote=${value.quote} h1=${value.heading}`)
    case '导出的 HTML 不带编辑器结构':
      return value.cmClass === false && value.cmLine === false && value.frontmatter === false
        ? null : bad(`cm-md 残留=${value.cmClass} cm-line 残留=${value.cmLine} 属性区残留=${value.frontmatter}`)
    case '导出的 HTML 带图片': return value.img === true ? null : bad(`img=${value.img} 长度=${value.size}`)
    case '复制带富文本口味': return /<strong/.test(value.html) && value.handled === true
      ? null : bad(`html 长度=${value.html.length} 有处理器=${value.handled}`)
    case '复制不带编辑器结构':
      return value.html !== '' && !value.html.includes('cm-md-') && !value.html.includes('cm-line')
        ? null : bad(`text/html: ${value.html.slice(0, 120)}`)
    case '复制的纯文本是原文':
      return value.text.includes('**加粗**') && value.text.includes('==高亮==')
        ? null : bad(`text/plain: ${JSON.stringify(value.text)}`)
    case '全选复制拿到整篇': return value.text === fixture()
      ? null : bad(`复制到 ${value.text.length} 字节，原文 ${value.docLength} 字节，结尾 ${JSON.stringify(value.text.slice(-24))}`)
    case '复制的 HTML 列表结构合法':
      return value.html !== '' && value.unbalanced.length === 0 && !/<(ul|ol)>(?!<li>)/.test(value.html)
        ? null : bad(`不配对的标签=${value.unbalanced.join(',') || '无'}`)
    case '点击待办能勾选': return value.after === value.before + 1
      ? null : bad(`点击前已勾=${value.before} 点击后=${value.after}`)
    case 'Tab 缩进列表项':
      return value.after === '  ' + value.before && (value.nestedClass ?? '').includes('cm-md-li-1') && !(value.nestedClass ?? '').includes('cm-md-li-0')
        ? null : bad(`前=${JSON.stringify(value.before)} 后=${JSON.stringify(value.after)} 移开光标后的类=${value.nestedClass}`)
    case 'Shift+Tab 退回一级':
      return value.back === value.before && !(value.backClass ?? '').includes('cm-md-li-1')
        ? null : bad(`退回后=${JSON.stringify(value.back)} 类=${value.backClass}`)
    default:
      return { name, ok: false, detail: `没有这条断言的判据: ${JSON.stringify(value).slice(0, 120)}` }
  }
}

async function main() {
  try {
    assertBuildFresh()
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 2
    return
  }

  const source = join(WORK, 'features.md')
  const answer = join(WORK, 'answer.json')
  writeFileSync(source, fixture(), 'utf8')
  // 夹具里 `![本地图片](pixel.png)` 引用的是相对路径，图片必须落在同一目录。
  writeFileSync(join(WORK, 'pixel.png'), PIXEL_PNG)

  const child = spawn(BINARY, [source], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      COLAMD_VERIFY: 'features',
      COLAMD_VERIFY_OUT: answer
    }
  })

  try {
    let payload = null
    for (let i = 0; i < 300; i++) {
      if (existsSync(answer)) {
        payload = JSON.parse(readFileSync(answer, 'utf8'))
        break
      }
      await sleep(200)
    }
    if (!payload) throw new Error('等不到应用的验证结果（60 秒）')
    if (!payload.ok) throw new Error(`页面里执行失败：${payload.failure}`)

    const assertions = payload.result.assertions ?? []
    let failures = 0
    for (const a of assertions) {
      const verdict = judge(a.name, a.value)
      if (verdict) {
        failures++
        console.log(`✗ ${a.name}  ← ${verdict.detail}`)
      } else {
        console.log(`✓ ${a.name}`)
      }
    }
    if (failures) {
      console.log(`\n✗ ${failures}/${assertions.length} 条没通过`)
      process.exitCode = 1
    } else {
      console.log(`\n✓ ${assertions.length} 条全通过`)
    }
  } finally {
    stopVerifyApp(WORK)
    await sleep(300)
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 2
})
