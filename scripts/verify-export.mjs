#!/usr/bin/env node
// 导出验收（PDF / 图片 / Word 三条路共用）：把文档画成字节，再逐行读回颜色。
//
// 为什么需要它：导出出过「长文档只有开头一段」（CodeMirror 只为视口建 DOM，不摊平就只
// 导出一屏）、「接缝处丢掉一小条」（#121 丢 28px）这类问题。它们不报错、不崩溃，产物
// 看起来也像那么回事，肉眼很难发现。所以判据必须是数值的：让每一行携带一个编码了行号
// 的颜色，导出后逐行还原行号，丢失、重复、错位、被压扁全部成为比较。
//
// 量在页面里做（src/renderer/verify/export-check.ts），这里只判红绿。两处"必须"：
//   · 判据要等整篇渲染完再取：夹具没进编辑器时每条判据都会"通过"，因为没东西可量。
//   · 字体内联那条路只在文档里有公式时才走到，所以夹具里放一行公式。
//
// 用法: npm run verify:export-pdf / verify:export-image（先 npm run build && npx tauri build --no-bundle）
// 窗口放在屏幕外，不占用屏幕。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const BINARY = process.env.COLAMD_BINARY ?? join(APP, 'src-tauri', 'target', 'release', 'loomark')

/** 色带数量。够多才撑得出一张长图，也才让「丢几行」看得出来。 */
const BANDS = 40

/** 行号编码成颜色，必须与 export-check.ts 的 colorOf 一致。 */
function colorOf(index) {
  const level = (value) => 40 + value * 30
  return [level(index % 7), level(Math.floor(index / 7) % 7), level(Math.floor(index / 49) % 7)]
}

/**
 * 夹具：一份长得像真实文档的东西。
 *
 * 色带之外还放了中文、表格、长 URL、公式 —— 长 URL 与公式都是踩过的坑：
 * 前者会把表格撑得比页面宽（#108），后者决定字体内联那条路有没有被走到。
 */
function fixture() {
  const lines = [
    '# 导出验证',
    '',
    '一段中文正文，验证字体的回退与排版是否与屏幕一致。English mixed in, 1234567890.',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| 单元格 | https://example.com/a/very/long/unbreakable/url/that/must/wrap |',
    '',
    '行内公式 $E = mc^2$ 结束。',
    '',
    '```js',
    'const answer = 42',
    '```',
    '',
  ]
  for (let index = 0; index < BANDS; index++) {
    const [r, g, b] = colorOf(index)
    lines.push(`<div style="height:40px;background:rgb(${r},${g},${b})">&nbsp;</div>`, '')
  }
  return lines.join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  // 产物存在还不够，还要比源码新：改了渲染层却忘了重新构建，验的是旧产物（见 build-freshness.mjs）。
  try {
    assertBuildFresh()
  } catch (error) {
    console.error(`✗ ${error.message}`)
    process.exitCode = 2
    return
  }

  const check = process.env.COLAMD_VERIFY_CHECK ?? 'export-pdf'
  const { dir: WORK } = verifyWorkdir('export')
  const source = join(WORK, 'export.md')
  const answer = join(WORK, 'answer.json')
  writeFileSync(source, fixture(), 'utf8')

  const child = spawn(BINARY, [source], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, COLAMD_VERIFY: check, COLAMD_VERIFY_OUT: answer }
  })

  let failures = 0
  try {
    let payload = null
    for (let i = 0; i < 400; i++) {
      if (existsSync(answer)) {
        payload = JSON.parse(readFileSync(answer, 'utf8'))
        break
      }
      await sleep(200)
    }
    if (!payload) throw new Error('等不到应用的验证结果（80 秒）')
    if (!payload.ok) throw new Error(`页面里执行失败：${payload.failure}`)

    const result = payload.result
    console.log(`渲染尺寸 ${result.width}×${result.height}（CSS 像素），耗时 ${result.durationMs}ms`)

    // --- 图片 ---
    if (result.png.bytes <= 0) {
      failures++
      console.log('  ✗ PNG：没有产出字节')
    } else {
      console.log(`  ✓ PNG：${result.png.pages} 张，首张 ${result.png.width}×${result.png.height}，${Math.round(result.png.bytes / 1024)}KB`)
    }

    // --- PDF ---
    if (result.pdf.magic !== '%PDF-') {
      failures++
      console.log(`  ✗ PDF：文件头是 ${JSON.stringify(result.pdf.magic)}，不是 %PDF-`)
    } else if (result.pdf.pages < 1) {
      failures++
      console.log('  ✗ PDF：页数为 0')
    } else {
      console.log(`  ✓ PDF：${result.pdf.pages} 页，${Math.round(result.pdf.bytes / 1024)}KB，文件头合法`)
    }

    // --- Word ---
    // .docx 是 zip 包，头两个字节必须是 PK。
    if (result.docx.magic !== 'PK') {
      failures++
      console.log(`  ✗ Word：文件头是 ${JSON.stringify(result.docx.magic)}，不是 PK（zip）`)
    } else {
      console.log(`  ✓ Word：${Math.round(result.docx.bytes / 1024)}KB，文件头合法`)
    }

    // --- 逐行还原 ---
    const wrong = result.samples.filter((sample) => sample.got !== sample.expected)
    const missing = result.samples.filter((sample) => sample.got < 0)
    console.log(`色带 ${result.bands} 行，还原正确 ${result.samples.length - wrong.length} 行`)
    if (result.bands === 0) {
      failures++
      console.log('  ✗ 一个色带都没有：夹具没进编辑器，上面那些"通过"没有意义')
    }
    for (const sample of wrong.slice(0, 10)) {
      console.log(`      ✗ 第 ${sample.expected} 行 → 读到 ${sample.got === -2 ? '越界' : sample.got < 0 ? '未匹配' : sample.got}` +
        `（${sample.color}，占 ${(sample.share * 100).toFixed(0)}%）`)
    }
    if (wrong.length > 0) {
      failures++
      console.log(`  ✗ 有 ${wrong.length} 行对不上（未匹配 ${missing.length} 行）`)
    }

    // --- 公式 ---
    // 没有公式的话，@font-face 内联那条路就没被走到，这份结果不能替它背书。
    if (!result.hasMath) {
      console.log('  · 夹具里没有渲染出公式，字体内联那条路这次没被验到')
    } else {
      console.log('  ✓ 公式已渲染（字体内联那条路被走到了）')
    }
  } finally {
    // 按标记（工作目录路径）回收，不按 pid：脚本自己被强杀时按 pid 那条路不会跑到。
    stopVerifyApp(WORK)
    await sleep(300)
  }

  if (failures > 0) {
    console.log(`\n✗ ${failures} 项不通过`)
    process.exitCode = 1
  } else {
    console.log('\n✓ 导出验收通过')
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
})
