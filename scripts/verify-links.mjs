#!/usr/bin/env node
// 本地 Markdown 链接的解析验收：`[方案](doc/方案A.md#设计目标)` 要变成哪个绝对路径、
// 要跳到哪一行/哪个标题，全部用纯断言判定。
//
// 为什么需要它：链接跳转的失败方式是**安静**的——路径解析错了就只是「点了没反应」，
// 不会崩、不会报错。而它要处理的东西恰好都是容易错的那种：中文与空格文件名、`#` 与 `%`
// 被百分号编码过的文件名、`file://` URL、Windows 盘符（长得像 scheme 但不是）、
// 以及 `:147` 这种行号后缀（必须在解码**之前**剥掉，否则 `part%3A147.md` 里编码过的
// 冒号会被当成行号）。
//
// 全程纯 Node，不开窗口、不启动应用，因此随时可跑。
//
// 用法: node scripts/verify-links.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = mkdtempSync(join(tmpdir(), 'loomark-verify-links-'))
const require = createRequire(import.meta.url)

let passed = 0
let failures = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`)
  }
}

/** 用 esbuild 把两个模块打成 CJS，直接在 node 里 require。 */
async function load() {
  mkdirSync(join(WORK, 'notes'), { recursive: true })
  for (const [name, entry] of [
    ['paths', 'src/renderer/editor/markdown-link.ts'],
    ['headings', 'src/renderer/editor/heading-anchor.ts'],
  ]) {
    await build({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: join(WORK, `${name}.cjs`), logLevel: 'silent' })
  }
  return {
    resolveMarkdownLink: require(join(WORK, 'paths.cjs')).resolveMarkdownLink,
    headingAnchorLine: require(join(WORK, 'headings.cjs')).headingAnchorLine,
  }
}

async function main() {
  const { resolveMarkdownLink, headingAnchorLine } = await load()
  const source = join(WORK, 'notes', 'source.md')

  // --- 相对路径按「当前文档所在目录」解析，不是按 cwd ---
  for (const [href, expected] of [
    ['01-索引.md', join(WORK, 'notes', '01-索引.md')],
    ['./中文%20空格.md', join(WORK, 'notes', '中文 空格.md')],
    ['../parent.MD', join(WORK, 'parent.MD')],
    ['child/next.markdown', join(WORK, 'notes', 'child', 'next.markdown')],
    ['hash%23percent%25.md', join(WORK, 'notes', 'hash#percent%.md')],
    [pathToFileURL(join(WORK, '中文 空格.md')).href, join(WORK, '中文 空格.md')],
    [join(WORK, 'absolute.md'), join(WORK, 'absolute.md')],
  ]) {
    check(`解析 ${href}`, () => assert.equal(resolveMarkdownLink(href, source).path, expected))
  }

  check('片段不混进路径', () => assert.equal(resolveMarkdownLink('next.md#中文', source).fragment, '中文'))

  // --- 行号后缀：四种写法都要认出 147 ---
  for (const href of ['next.md:147', './中文%20空格.md:147', `${pathToFileURL(join(WORK, 'next.md')).href}:147`, `${join(WORK, 'next.md')}:147`]) {
    check(`源码行 ${href}`, () => {
      const link = resolveMarkdownLink(href, source)
      assert.equal(link.line, 147)
      assert.ok(link.path.endsWith('.md'))
    })
  }
  check('行号和标题可以同时出现', () => {
    const link = resolveMarkdownLink('next.md:147#heading', source)
    assert.equal(link.line, 147)
    assert.equal(link.fragment, 'heading')
  })
  check('编码过的冒号不算行号', () => assert.equal(resolveMarkdownLink('part%3A147.md', source).line, undefined))

  for (const href of ['next.md:0', 'next.md:9007199254740992', 'next.md:-1', 'next.md:abc']) {
    check(`行号非法 ${href}`, () => assert.equal(resolveMarkdownLink(href, source), null))
  }

  // --- 不是本地 Markdown 的一律不接：交给外壳当网址处理 ---
  for (const href of ['#local', 'https://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'run.exe']) {
    check(`拒绝 ${href}`, () => assert.equal(resolveMarkdownLink(href, source), null))
  }
  check('未命名文档里的相对链接不解析', () => assert.equal(resolveMarkdownLink('next.md', null), null))

  // --- 标题锚点：视口外也要找得到，代码块里的 # 不算标题 ---
  const md = '# **中文 标题**\n\n```md\n# Fake\n```\n\n## Repeat\n\n## Repeat\n\nSetext\n======\n'
  for (const [fragment, expected] of [
    ['%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98', 0],
    ['fake', null],
    ['repeat', 6],
    ['repeat-1', 8],
    ['setext', 10],
    ['absent', null],
  ]) {
    check(`标题 ${fragment}`, () => assert.equal(headingAnchorLine(md, fragment), expected))
  }

  console.log(failures ? `\n✗ ${failures} 条不通过（${passed} 条通过）` : `\n✓ ${passed} 条全部通过`)
  if (failures) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(`✗ 验收脚本自身没跑起来：${error.message}`)
    process.exitCode = 2
  })
  .finally(() => {
    rmSync(WORK, { recursive: true, force: true })
  })
