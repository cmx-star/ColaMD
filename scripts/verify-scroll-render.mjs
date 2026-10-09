#!/usr/bin/env node
// 滚动渲染验收：滚到长文档没解析过的地方，那几行必须是**渲染过的**，不能是原始源码。
//
// 为什么需要它：装饰是从语法树上读出来的，而语法树按视口惰性解析。用户滚到还没解析的
// 区域时，CodeMirror 会照常把那几行渲染出来，但装饰里没有它们，于是屏幕上显示
// `- **加粗**` 这种原始标记，要点一下才会恢复正常（2026-09-26 报的「长文档只渲染了前面，
// 点击一下就渲染了」）。这个脚本就是盯这件事：每个滚动位置，视口里不许出现原始标记。
//
// 怎么驱动应用：以前走 Chrome DevTools 协议，那需要打包好的 Electron 应用。系统自带的
// WebView 都不提供 CDP，所以改成一条**验证通道**：本脚本用 COLAMD_VERIFY 告诉应用跑哪个
// 检查项（检查项本身随包编译在渲染层里：src/renderer/verify/checks.ts，页面 CSP 不许
// eval，所以不能像旧脚本那样把源码传进去），应用把结果写到 COLAMD_VERIFY_OUT 指定的
// 文件。整段「滚动 → 等解析铺满 → 检查」因此跑在页面内（轮询必须在页面内，跨进程来回
// 等会慢到没法用），脚本只负责发起、读数、判定。
//
// 用法: npm run verify:scroll-render
//       先构建：npm run build && npx tauri build --no-bundle
// 窗口放在屏幕外，不占用屏幕。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
// 每个脚本一个固定目录，开跑前擦干净，退出时再擦（见 verify-workdir.mjs）。
const { dir: WORK } = verifyWorkdir('scroll-render')
const BINARY = process.env.COLAMD_BINARY ?? join(APP, 'src-tauri', 'target', 'release', 'loomark')

/** 文档要足够长，长到「打开时解析到的那一段」离尾部很远。 */
const ROWS = 1200
const POSITIONS = [0, 30000, 60000, 999999]

function fixture() {
  const lines = ['# 滚动渲染验收', '']
  for (let i = 1; i <= ROWS; i++) {
    lines.push(`- **第 ${i} 条**：这一段带加粗和\`行内代码\`，用来检查尾部有没有被装饰。`)
    lines.push('')
  }
  return lines.join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))


async function main() {
  if (!existsSync(BINARY)) {
    console.error(`找不到应用：${BINARY}\n先构建：npm run build && npx tauri build --no-bundle`)
    process.exitCode = 2
    return
  }

  const source = join(WORK, 'big.md')
  const answer = join(WORK, 'answer.json')
  writeFileSync(source, fixture(), 'utf8')

  const child = spawn(BINARY, [source], {
    cwd: APP,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, COLAMD_VERIFY: 'scroll-render', COLAMD_VERIFY_OUT: answer },
  })

  let failures = 0
  try {
    let payload = null
    for (let i = 0; i < 150; i++) {
      if (existsSync(answer)) {
        payload = JSON.parse(readFileSync(answer, 'utf8'))
        break
      }
      await sleep(200)
    }
    if (!payload) throw new Error('等不到应用的验证结果（30 秒）')
    if (!payload.ok) throw new Error(`页面里执行失败：${payload.failure}`)

    // payload.result 已经是解析过的值（外层就是 JSON），不要再 parse 一次
    for (const state of payload.result) {
      const ok = state.raw === 0 && state.decorated > 0
      if (!ok) failures++
      console.log(`${ok ? '✓' : '✗'} 滚到 ${String(state.position).padStart(6)}：` +
        `视口 ${state.rows} 行，原始标记 ${state.raw} 行，有装饰 ${state.decorated} 行，` +
        `等了 ${state.waited}ms，首行「${state.first}」`)
    }
  } finally {
    // 按标记（工作目录路径）回收，不按 pid：脚本自己被强杀时，按 pid 的那条路
    // 根本不会跑到，进程就留在机器上了（见 verify-workdir.mjs）。
    stopVerifyApp(WORK)
    await sleep(300)
  }

  if (failures) {
    console.log(`\n✗ ${failures} 个滚动位置没渲染（视口里还是原始 markdown）`)
    process.exitCode = 1
  } else {
    console.log(`\n✓ ${POSITIONS.length} 个滚动位置都是渲染过的`)
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 2
})
