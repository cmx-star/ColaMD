# 上游同步计划（2.7.2 → 2.7.6）

- 状态：执行中（2026-10-09）
- 执行分支：`main`（v2.8.0，Tauri 版）
- 上游基线：`marswaveai/colamd`，分叉点 `5e0f3c3`（v2.7.2，也是本文的合并基点）
- 目标上游：`upstream/main` `1e9b481`（v2.7.6），共 41 个提交
- 相关文档：[editor-architecture.md](editor-architecture.md)、[tauri-migration-plan.md](tauri-migration-plan.md)

## 0. 执行记录

| 项 | 状态 | 提交 |
| --- | --- | --- |
| E1 深色主题选区、E2 主题选择器 | 已完成 | `4a57a40` |
| E3 按标记回收进程、E4 外部链接走 opener | 已完成 | `2d168e6` |
| E5 时间戳不再被当 emoji、E6 取消选中高亮 | 已完成 | `da7a67b` |
| E7 有序列表重编号（含 `<ol start>`） | 已完成 | `ef78123` |
| E9 属性区收起、点进块、面板列（六件事） | 已完成 | `408d86f` |
| E10 渲染模式不露源码、字号、复制空行、字体拆类 | 已完成 | `fb08657` |
| E8 本地链接跳转（渲染层 + Tauri 命令） | 已完成 | `9d3300e` |
| E12 固定工作目录、E13 构建新鲜度、E14 模板 | 已完成 | `2d168e6`、`61c9df2` |
| E15 约定与 changelog | 已完成 | `61c9df2` |
| E11 `verify:themes` | 进行中 | — |
| 三个 Electron 脚本迁移 | 未开始（见第 9 节） | — |

### 执行中发现的偏差

1. **E9 里 `ff93410` 删掉的「面板让位」是上游自己的错误**，不能照搬。它删掉三条让 `#editor` 避开面板的规则，理由是「面板是 shell 行里的兄弟、自己占位」，但面板一直是 `position: fixed`（不占布局）。上游 5 天后在 `2cf43b6`（#143）改回来了。本次采纳的是**修正后的形态**：一对 `--panel-inset-*` 变量同时喂给两种模式，让位用 padding 而不是 margin（滚动条因此停在面板边缘而不是藏在底下）。
2. **E7 里 `<ol start>` 来自被推翻的 `7ad5639`**，不是 `0bafc7c`。那个提交含两件独立的事：屏幕重排（被推翻，不落）与导出保留起始号（被继承，要落）。本次只取后者。
3. **E13 需要判两样产物**。上游只判 `dist/main/index.js`；这里渲染层由 vite 产出、应用由 cargo 产出，只判一样会让另一样悄悄过期。`assertBuildFresh()` 因此接受一个 `only` 参数，纯 Node 的验收（`verify:markdown`、`verify:links`）不要求先编二进制。
4. **`verify:markdown`、`verify:links` 直接消费 TS 源码**（esbuild 现打包），不依赖任何构建产物，因此不加构建新鲜度门禁。

## 1. 为什么现在同步

`main` 是「上游 2.7.2 + Tauri 迁移」压成的一笔提交（v2.8.0）。上游此后发的 v2.7.3～v2.7.6 全部集中在同一件事上：**补回 2.7 换 CodeMirror 内核时漏掉的阅读体验**。我们换内核的时间点与上游一致，所以这些缺陷在我们这里同样存在，而且上游已经把根因和修法都验证过了。

同步的价值不在「跟版本」，在于：上游修掉的四个用户可见缺陷，我们现在也带着；上游新加的两项能力（本地链接跳转、列表自动接号）我们没有。

改动分布对 Tauri 版很有利：

| 层 | 规模 | 对 Tauri 版的影响 |
| --- | --- | --- |
| 渲染层（编辑器内核、主题、链接逻辑） | 约 750 行 | 可直接移植，无 Electron 依赖 |
| Electron 主进程 / preload | 仅 85 行 | 我们已删除该目录，需改写成 Tauri 命令 |

## 2. 已确认的现存缺陷

以下四条在 `main` 上逐条核实过，不是推测。

| # | 缺陷 | 证据 | 上游修复 |
| --- | --- | --- | --- |
| D1 | 深色主题选中文字看不清 | [source-theme.ts](../src/renderer/editor/source-theme.ts#L59) 仍是两个类的选择器，压不住 baseTheme 的四个类；nord / solarized-dark 都出现在主题菜单里 | `eea4f66` |
| D2 | 12 份主题文件选择器全部失效 | `themes/*.css` 共 61 处 `.ProseMirror` 选择器，新内核不产出这些元素 | `a2b2df2` |
| D3 | 验收脚本按 pid 杀进程，脚本被强杀时留下进程 | `scripts/verify-scroll-render.mjs` 等仍是 `process.kill(-child.pid)` | `b74185c` + `fa87e86` |
| D4 | 外部链接用 `window.open` | [tauri-api.ts](../src/renderer/tauri-api.ts#L136)，Tauri 的 WebView 里本机外链打不开 | 无（上游走 Electron shell） |

`verify-scroll-render.mjs` 已经迁到 `COLAMD_VERIFY` 通道（WebView 没有 CDP，这条路是对的），本计划沿用该通道，不引入第二套驱动方式。

## 3. 同步范围

### 3.1 采纳

按风险从低到高，分三阶段。

**阶段一：现存缺陷（先修，与上游功能无关）**

| 项 | 上游提交 | 说明 |
| --- | --- | --- |
| E1 深色主题选区对比度 | `eea4f66` | 改 `source-theme.ts` + `editor-preview.css`，**两个文件必须同批**，否则等于没改 |
| E2 主题选择器换成真实类名 | `a2b2df2` | 10 个 `themes/*.css`，`.ProseMirror X` → `.cm-content .cm-md-X`；引用块与代码块是每行一个 div，纵向内边距要改形状 |
| E3 按标记回收进程 | `b74185c` `fa87e86` | 改 `pkill -f <marker>`，开跑前也清一次；标记之间不能互为前缀 |
| E4 外部链接走 opener | `6442...`（无对应上游） | `tauri-api.ts` 的 `openExternal` 改调 Tauri 的 `opener:open_url`；`opener:default` 已在 capability 里 |

**阶段二：新功能与内核修复**

| 项 | 上游提交 | 说明 |
| --- | --- | --- |
| E5 时间戳不再被当 emoji | `e82df8c` | 自建基准语法（CommonMark + GFM），去掉 Subscript/Superscript/Emoji。零冲突 |
| E6 取消「选中即高亮全文同项」 | `10c8731` | 删 `highlightSelectionMatches()`。**产品取舍，见第 6 节 Q1** |
| E7 有序列表自动接号 | `0bafc7c` | 238 行新文件 `list-renumber.ts`。**只落这一个，不要落被它推翻的 `7ad5639`** |
| E8 本地 Markdown 链接跳转 | `b5bbfad` `660ad63` | 渲染层三处修复 + 路径解析；外壳层改写成 Tauri 命令 |
| E9 文首属性区收起 + 点击进块 | `ff93410` | 六件事捆在一起，拆开落；**前两件必须同批** |
| E10 渲染模式不露源码 + 字号 | `5842789` | 四件事捆在一起；字号那条需在 Tauri 菜单补事件 |

**阶段三：验证体系与约定**

| 项 | 上游提交 | 说明 |
| --- | --- | --- |
| E11 主题规则命中检查 | `3aee219` | 330 行，接进 `checks.ts`；需先解决视口问题（Q2） |
| E12 固定工作目录 | `1c94cea` | 每脚本一个稳定目录，开跑前清理，退出时清理 |
| E13 构建新鲜度断言 | `a44c83f` | 上游只判 `dist/main/index.js`，我们需判 renderer 产物**和** Tauri 二进制两样 |
| E14 主题模板 | `d214f90` | 新增 `themes/template.css`，顺带删 README 里已不存在的 VS Code 宣传 |
| E15 约定更新 | 多个 | `AGENT.md` 两处；`resources/demo/changelog.md` 追加 2.7.3～2.7.6 |

### 3.2 不采纳

| 项 | 理由 |
| --- | --- |
| `offscreen-window.cjs` | 整个是 Electron 主进程 API，Tauri 用不上。**但结论必须照抄**：屏外可见，不要隐藏——`1e9b481` 修的正是「隐藏窗口等不到 paint」这个自伤回归 |
| `7ad5639`（列表重编号早期版） | 已被 `0bafc7c` 推翻（屏幕上好看、文件里不对） |
| VS Code 扩展删除 | 我们仍保留 `vscode-extension/`，独立决策 |
| 上游 Linux/Electron 打包相关 | 与 Tauri 打包无关 |
| `package.json` 依赖调整 | 上游删 Milkdown、加 remark-gfm 等；我们依赖已不同，按需单独处理 |

## 4. 执行顺序

每条独立提交，便于回退与定位。

1. **E1 + E2**（主题两项，同属一个主题文件族，一起验证）
2. **E3 + E4**（验收环境与外壳各一处小修）
3. **E5 + E6**（两个零冲突的小内核改动）
4. **E14 + E15**（文档与模板，不改行为）
5. **E7**（列表重编号，中风险，单独提交）
6. **E9**（拆成 6 笔：属性区收起 / 光标落点 / 点击进块 / 表格单元格 / 大纲不吃代码块 / 待办常驻）
7. **E10**（拆成 4 笔：标记不露源码 / 复制不多空行 / 字号 / 字体拆类）
8. **E8**（链接跳转，渲染层 + Tauri 命令）
9. **E11 + E12 + E13**（验证体系）

E9 与 E10 有语义连锁：`ff93410` 靠 `isActiveRange` 实现「点进块」，而 `5842789` 把它打成恒 `false`。**E9 必须先落并回归「点表格/公式能进源码」，再落 E10。**

## 5. 验收

每条落地后跑对应检查，阶段结束跑全量。

| 阶段 | 验收方式 |
| --- | --- |
| 主题（E1/E2/E11） | `npm run verify:themes`（E11 完成后）；未完成前用 `npm run check:theme-colors` + 手工切 nord / solarized-dark 看选中文字 |
| 内核（E5～E10） | `npm run verify:scroll-render`、`npm run verify:features` |
| 链接（E8） | 新增 `npm run verify:links`（沿用 `COLAMD_VERIFY` 通道） |
| 全量 | 上述全部 + `npm run build` + `npx tauri build --no-bundle` |

判定原则照 [PRINCIPLES.md](../PRINCIPLES.md)：先测量再优化；红了先怀疑探针，再怀疑产品。

## 6. 待决问题

**Q1：E6 是否采纳？** 上游删掉「选中一个字，全文同字画框」，判定它是负资产（看起来像渲染故障）。若我们有用户依赖这个行为，需要单独保留。**默认采纳上游判断。**

**Q2：`verify-themes` 的视口问题怎么解？** 上游靠 CDP 的 `setDeviceMetricsOverride` 把视口拉到 2600px 高（夹具比一屏长，视口不够高时下半段不渲染，会误判主题失效）。`COLAMD_VERIFY` 通道没有这个能力。两个选项：

- A：壳在 `COLAMD_VERIFY` 模式下把验证窗口开高（改动小，语义最接近上游）
- B：检查项在渲染层自己分段滚动+测量（不动壳，但慢且更容易假红）

**倾向 A。**

**Q3：`resolveMarkdownLink` 放渲染层还是 Rust？** 上游放主进程，理由是「相对文档路径解析，不能相对 renderer 的 URL」。Tauri 的 `asset://` 同样不能解析相对路径，但 `currentFilePath` 已在渲染层。放渲染层少写一段 Rust，代价是与上游结构错开、后续 cherry-pick 要多改一处。**倾向渲染层。**

## 7. 风险

| 风险 | 应对 |
| --- | --- |
| 上游改动与我们的 Tauri 改名冲突（`electronAPI` → `loomark`） | 逐条手工 reapply，不整体 merge；判据：hunk 含 `electronAPI`/`colamd` 字样的必须人工核对 |
| 只改 TS 不改 CSS 导致静默失效 | E1、E10 的字体拆类都有这个陷阱，CSS 与 TS 必须同批提交 |
| 重编号功能漏 `userEvent: 'input'` | E7 涉及 5 处 `dispatch`，漏一处功能静默失效；落地后必须实测删除中间项 |
| `1e9b481` 的隐藏窗口教训在 Tauri 重演 | 移窗口配置时保持「屏外可见」，不要用 `.visible(false)` |

## 8. 完成定义

- 第 3.1 节三阶段全部落地，每条独立提交
- 第 5 节验收全绿，含新脚本 `verify:links`、`verify:themes`
- 第 2 节四条现存缺陷逐条复验消失
- `AGENT.md` 补两处约定，`resources/demo/changelog.md` 追加 2.7.3～2.7.6

## 9. 遗留：三个脚本仍指向已删除的 Electron

`verify:features`（663 行，50 条断言）、`verify:export-pdf`（169 行）、`verify:image-export`（283 行）仍在 `spawn('npx', ['electron', ...])`，而全仓已无 Electron 依赖（不在 `package.json`、不在 `node_modules`）。**这三条命令当前必然失败。**

它们不能照搬上游，也不能直接改成 `COLAMD_VERIFY`：

| 依赖 | 现状 | Tauri 下的等价物 |
| --- | --- | --- |
| `Runtime.evaluate` 跑 DOM 探针 | 50 条断言全走这条路 | 检查项写进 `src/renderer/verify/checks.ts`，随包编译（CSP 禁止 eval） |
| `Page.captureScreenshot` / `capturePage` | 图片与 PDF 导出验收 | 需要新的导出实现，见 [export-pdf-image-plan.md](export-pdf-image-plan.md) |
| `Emulation.setDeviceMetricsOverride` | 把视口撑到一屏以上 | 让壳在 `COLAMD_VERIFY` 时把窗口开高（`verify:themes` 采用同一方案） |
| Electron 的 `nativeImage` 读 PNG 尺寸 | `verify:image-export` | 纯 Node 的 PNG 头解析，或改用导出的产物尺寸断言 |

评估：这三条与导出方案强相关（PDF 走 `WebviewWindow::print()`、图片要写三平台截图桥），**建议跟随导出功能一起迁移，而不是单独做**。在导出方案落地前，`AGENT.md` 里已把「跑不起来」记为已知缺口。
