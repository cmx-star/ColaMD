// 验收脚本的前置检查：产物必须比源码新。
//
// 忘了构建就会拿旧产物去验，红的全是假的，能白白耗掉一轮排查（2026-10-03 上游就这么
// 被骗过一次：刚合并的改动没进 dist，链接套件红了，查了半天壳）。
//
// 与上游（colamd `scripts/build-freshness.mjs`，a44c83f）的差别只有一个：**要判两样**。
// 那边是 Electron，产物就是 `dist/main/index.js` 一个；我们这边渲染层由 vite 打进
// `dist-tauri/renderer`，应用本体是 Rust 编出来的二进制，两样分别由
// `npm run build` 与 `npx tauri build --no-bundle` 产出。只判其中一样会漏掉另一半：
// 改了渲染层却只编了 Rust，或反过来，都还是拿旧的东西在验。
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function newestMtime(dir, newest = 0) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = newestMtime(path, newest)
    else newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

/** 源码目录里最新的一笔改动。渲染层与外壳各有一份，两边都要比。 */
function sourceMtime() {
  return Math.max(
    newestMtime(join(ROOT, 'src', 'renderer')),
    newestMtime(join(ROOT, 'src-tauri', 'src'))
  )
}

/** 一个产物文件：不存在、或比源码旧，就给出该跑哪条命令。 */
function assertArtifact(label, path, rebuiltBy, since) {
  let builtAt = 0
  try {
    builtAt = statSync(path).mtimeMs
  } catch {
    throw new Error(`没有${label}（${path}），先跑 ${rebuiltBy}`)
  }
  if (since > builtAt) {
    throw new Error(`${label}比源码旧，先跑 ${rebuiltBy}（否则验的是旧产物）`)
  }
}

/**
 * 拿不到产物、或产物比源码旧就直接停下，别让脚本去验一个旧产物。
 *
 * `only` 用于只依赖一半产物的脚本：纯 Node 的验收（verify:markdown、verify:links）不需要
 * 二进制，要求它先编一个 release 只是白白挡住人。
 */
export function assertBuildFresh(only = 'both') {
  const since = sourceMtime()
  if (only !== 'binary') {
    assertArtifact('渲染层产物', join(ROOT, 'dist-tauri', 'renderer', 'index.html'), 'npm run build', since)
  }
  if (only !== 'renderer') {
    assertArtifact('应用二进制', join(ROOT, 'src-tauri', 'target', 'release', 'loomark'), 'npm run build && npx tauri build --no-bundle', since)
  }
}
