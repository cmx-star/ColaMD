#!/usr/bin/env node
// 主题验收：`themes/*.css` 里的每一条规则都必须**命中真实的元素**，并且那个主题至少
// 有一条规则真的改变了计算样式。
//
// 为什么需要它：换编辑器内核的时候，Milkdown/ProseMirror 的 DOM 没了，`themes/` 里那些
// `#editor .ProseMirror strong { … }` 就永远匹配不到东西，于是「下载了主题，加粗和标题
// 的颜色却没变」。这类失效不报错、不崩溃，肉眼也只在换主题的瞬间才看得出来，所以它必须
// 有断言：没人用的选择器 = 红。
//
// 判据（两条，都是机械的，来自上游 colamd `scripts/verify-themes.mjs`，1e9b481）：
//   1. 每条规则至少命中一个元素。命中 0 个说明它描述了一个不存在的结构。
//   2. 每个主题至少有一条规则能真的改变计算样式。都不变说明这个主题是个空壳。
// 效果的判定方式是把规则单独注入、开关一次，比较命中元素的计算样式快照。这样不用在
// 测试里抄一遍颜色值，主题改了测试不用跟着改。量这件事本身在页面里做，见
// src/renderer/verify/checks.ts 的 runThemeCheckSuite。
//
// 与上游的两处差别，都是这条验证通道带来的：
//   - 上游走 CDP 的 Emulation.setDeviceMetricsOverride 把视口拉到 2600 高；系统 WebView
//     没有 CDP，所以由壳在 COLAMD_VERIFY 时把窗口本身开大并放到屏幕外
//     （src-tauri/src/windows.rs）。窗口不够高的话 CodeMirror 不为下半篇建 DOM，
//     那些规则会被误判成失效——这正是这个脚本最容易被骗的地方。
//   - 主题文件的原文由壳读好、随 'verify-run' 事件递进页面（COLAMD_VERIFY_THEMES）。
//     页面没有能读磁盘的协议，而这一项要按文件逐个报结果，所以必须把文件本身送进去。
//
// 用法: npm run verify:themes（先 npm run build && npx tauri build --no-bundle）
// 窗口放在屏幕外，不占用屏幕。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'
import { assertBuildFresh } from './build-freshness.mjs'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
// 每个脚本一个固定目录，开跑前擦干净，退出时再擦（见 verify-workdir.mjs）。
const { dir: WORK } = verifyWorkdir('themes')
const THEMES = join(APP, 'themes')
const BINARY = process.env.COLAMD_BINARY ?? join(APP, 'src-tauri', 'target', 'release', 'loomark')

/**
 * 夹具要装下主题会碰的每一种元素，缺一种就会把主题误判成失效。上游那份抄过来没改：
 * 标题一到六级、加粗、斜体、行内代码、链接（带文字的与裸的）、删除线、引用、表格、
 * 分隔线、围栏代码块、无序与有序列表、行内公式。
 */
function fixture() {
  return [
    '# 一级标题',
    '',
    '## 二级标题',
    '',
    '### 三级标题',
    '',
    '#### 四级标题',
    '',
    '##### 五级标题',
    '',
    '###### 六级标题',
    '',
    '正文里有 **加粗**、*斜体*、`行内代码`、[一个链接](https://example.com/docs) 和 ~~删除线~~。',
    '',
    '另见裸链接 https://example.com/bare 这一段。',
    '',
    '> 引用的第一行',
    '> 引用的第二行',
    '',
    '| 表头甲 | 表头乙 |',
    '| --- | --- |',
    '| 单元格甲 | 单元格乙 |',
    '',
    '---',
    '',
    '```js',
    'const answer = 42',
    '```',
    '',
    '- 无序项甲',
    '- 无序项乙',
    '',
    '1. 有序项甲',
    '2. 有序项乙',
    '',
    '行内公式 $a^2+b^2=c^2$ 与行尾文本。',
    ''
  ].join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个主题文件该不该判失败。与页面里的 ThemeReport 一一对应。 */
function themeFailures(report) {
  const problems = []
  for (const selector of report.dead) problems.push(`${report.file}: 命中不到任何元素 ${selector}`)
  for (const wrong of report.wrongVars) problems.push(`${report.file}: 变量没生效 ${wrong}`)
  if (report.rules > 0 && report.effective === 0) {
    problems.push(`${report.file}: 没有任何一条规则在起作用，这个主题是个空壳`)
  }
  return problems
}

async function main() {
  // 产物存在还不够，还要比源码新：改了渲染层却忘了重新构建，验的是旧产物，
  // 红的是假的（见 build-freshness.mjs）。
  try {
    assertBuildFresh()
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 2
    return
  }

  const files = readdirSync(THEMES).filter((file) => file.endsWith('.css')).sort()
  if (files.length === 0) {
    console.error(`✗ ${THEMES} 下一个 .css 都没有，没什么可验的`)
    process.exitCode = 2
    return
  }

  const source = join(WORK, 'themes.md')
  const answer = join(WORK, 'answer.json')
  writeFileSync(source, fixture(), 'utf8')

  const child = spawn(BINARY, [source], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      COLAMD_VERIFY: 'themes',
      COLAMD_VERIFY_OUT: answer,
      COLAMD_VERIFY_THEMES: THEMES
    }
  })

  let failures = 0
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

    // payload.result 已经是解析过的值（外层就是 JSON），不要再 parse 一次
    const reports = payload.result.files ?? []
    const measured = new Set(reports.map((report) => report.file))
    console.log(`独立主题文件（${files.length} 个）`)
    for (const report of reports) {
      const problems = themeFailures(report)
      failures += problems.length
      const skipped = report.interactive.length > 0
        ? `，另有 ${report.interactive.length} 条当前量不出差别（${report.interactive.join('、')}）`
        : ''
      console.log(`  ${problems.length === 0 ? '✓' : '✗'} ${report.file}：` +
        `${report.rules} 条规则，${report.effective} 条确有作用${skipped}`)
      for (const problem of problems) console.log(`      ✗ ${problem}`)
    }
    // 壳没把某个文件递进来（读目录失败、被过滤掉）时，它不会出现在报告里。默默少一个
    // 文件就是默默少一份断言，所以这里要把缺口补成红的。
    for (const file of files) {
      if (!measured.has(file)) {
        failures++
        console.log(`  ✗ ${file}：没有出现在结果里（壳没把它交给页面？）`)
      }
    }
  } finally {
    // 按标记（工作目录路径）回收，不按 pid：脚本自己被强杀时，按 pid 的那条路
    // 根本不会跑到，进程就留在机器上了（见 verify-workdir.mjs）。
    stopVerifyApp(WORK)
    await sleep(300)
  }

  if (child.exitCode !== null && child.exitCode !== 0 && failures === 0) {
    console.log(`\n（应用以 ${child.exitCode} 退出，结果已拿到）`)
  }

  if (failures) {
    console.log(`\n✗ 主题验收失败：${failures} 项`)
    process.exitCode = 1
  } else {
    console.log(`\n✓ ${files.length} 个主题文件全部通过`)
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 2
})
