# 导出 PDF 与图片的方案

## Context

Electron 版的 PDF 走 `webContents.printToPDF`，图片走隐藏窗口 `capturePage`。搬到 Tauri 后这两条路都没了，[tauri-migration-plan.md](tauri-migration-plan.md) 的 R1 记的是「PDF 降级为打印对话框」，R3 记的是「图片没有 `capturePage` 等价能力，要写三平台原生截图桥」。

写这份文档是因为动手前需要把三件事定下来：

1. **PDF 不需要降级成两步**。`WebviewWindow::print()` 已经在 tauri 2.12.1 里，三个平台都有实现，不引任何新依赖。R1 的前提不成立。
2. **图片导出的关键实现还在 git 里**。`e64ea36` 删掉 Electron 的 `src/main/image-export.ts` 时，那份代码完整保留在 `e64ea36^`。分页判据、16384px 上限、超时兜底、验证手法都在里面，是重新实现的起点，不必从零设计。
3. 用户的判断是 PDF 与图片**同等重要**，所以不能只通 PDF。

本文只记方案与结论，不含实现。实施按 [PRINCIPLES.md](../PRINCIPLES.md) 第 7 条：先更新 `design.md` 的导出规范，再动代码。

## 已核实的事实

以下结论都是在本机读源码得来的，不是查资料得来的。

### PDF：wry 三平台都有 print

| 平台 | 实现位置 | 行为 |
| --- | --- | --- |
| macOS | `wry-0.57.0/src/wkwebview/mod.rs:879` | `printOperationWithPrintInfo:`，用 `NSPrintInfo`，可设四边页边距 |
| Windows | `wry-0.57.0/src/webview2/mod.rs:1796` | `eval("window.print()")` |
| Linux | `wry-0.57.0/src/webkitgtk/mod.rs:771` | `webkit2gtk::PrintOperation::run_dialog` |

调用入口是 `tauri-2.12.1/src/webview/mod.rs:1626` 的 `Webview::print()`。

**注意 tauri 的文档注释是错的**：它写「Currently only supported on macOS on `wry`. `window.print()` works on all platforms.」——上半句与 wry 0.57.0 的源码不符，三平台都有原生实现。这句注释会让读者以为只有 mac 能用，从而去走不必要的 `window.print()` 兜底。

两者都不返回 PDF 字节，都弹系统对话框，「存储为 PDF」由用户点。这就是 R1 说的两步。**要一步到位（选完路径直接落盘、无对话框）必须自带渲染引擎**，见后文方案 C。

### 图片：wry 没有暴露任何截图能力

在 wry 0.57.0 全仓搜 `CapturePreview` / `takeSnapshot`，只命中 iOS 的 `WKWebView.rs`（`takeSnapshotWithConfiguration:completionHandler:`），桌面三平台的截图接口都没暴露。

也就是说 R3 的判断成立：**图片导出是这三个方案里唯一真正缺的能力**，且没有上游 API 可用。要么自己写原生桥，要么绕开 webview。

### 字体：主题用的是系统字体栈，没有 webfont

查过 `themes/*.css` 与 `src/renderer/themes/*.css`：全是 `font-family` 列表（`-apple-system`、`PingFang SC`、`Songti SC`、`SF Mono` 等），**没有一处 `@font-face`**。

这条事实很重要：R3 说「兜底前端 SVG 转 canvas（字体内嵌代价大，应急用）」——在 Electron 版那个判断下成立的前提是字体要内联。既然全走系统字体，canvas 路线的字体代价基本不存在，兜底方案的可行性比原判断高得多。需要验证的是**目标机器上是否装了列表里第一个字体**，字体回退会让导出与屏幕显示不一致。

## 三个方案

### A. 系统打印对话框（PDF 能通，图片不能）

用 `WebviewWindow::print()` 打当前窗口，用户在系统对话框里选「存储为 PDF」。

渲染侧的准备已经做好了，不用新写：`src/renderer/print-layout.ts` 的 `enterPrintLayout` / `exitPrintLayout` 会把整篇渲染出来（CodeMirror 只为视口建 DOM，不摊平就只导出一屏，这是 2026-09-26 报过的「长文档只渲染了前面」），[main.ts:1676](src/renderer/main.ts) 的 `window.__loomarkPrintExport.enter/exit` 负责在打印前把光标、选区、当前行源码从纸上拿掉。

Electron 版还有一段 print CSS 值得照搬（`e64ea36^:src/main/index.ts`，`@media print` 块起于 1236 行）：

- `@page { margin: 20mm 18mm; background: <主题背景色> }`——页边距归页面所有才会每页重复；背景色必须给，否则温暖或深色主题每一页都套一圈纸白
- 隐藏 `.cm-cursor` / `.cm-selectionLayer`
- `th, td { overflow-wrap: anywhere }`——表格里一个不断行的长串（JSON、URL）会把表格撑得比纸宽，最后一列被切掉（#108）

**代价**：用户在系统对话框里自己选「存储为 PDF」。自动化验收脚本点不了系统对话框，`scripts/verify-export-pdf.mjs` 需要改造成检查「导出前的布局是否正确」（整篇已渲染、光标已隐藏、print CSS 已注入），而不是检查产出的 PDF 文件。

**新增依赖**：零。`print()` 已在 tauri 2.12.1 里。

### B. SVG `foreignObject` → canvas → PNG（图片，零原生代码）

把导出的 HTML 塞进 `<svg><foreignObject>`，画到 canvas，`toBlob` 出 PNG。纯渲染侧，不碰 Rust。

这条路能绕开 R3 的原生桥，字体代价（前面已核实）不存在。风险集中在两点，都需要先用最小原型验证再承诺：

- **`foreignObject` 的渲染完整性**：canvas 画 `foreignObject` 时不支持外部资源加载，图片必须已内联为 data URL（HTML 导出里 `<img src="file://...">` 要转成 base64）；CSS 必须全部内联进 `<style>`。主题 CSS 体积不小，需要确认没有 `@import`。
- **中文与 emoji 的字体回退**：canvas 里 `foreignObject` 的字体解析与网页不完全一致。

另一个已知约束来自 Electron 版：捕获表面**单边上限 16384 设备像素**（实测 16384 有图、16800 返回空）。canvas 也受同类限制，超长文档仍要走编号分页。原文的判据要换算成设备像素，不能拿 CSS 像素直接比——2 倍屏上直接的后果是允许到 32768，先白等两次超时再退回分页。

**代价**：字号、行高、表格边框的渲染精度需要逐个主题比对，可能反复调。**新增依赖**：零。

### C. Rust 侧接渲染引擎（PDF 与图片都一步到位，但要背体积）

引 `headless_chrome` 之类的 crate，或打包一个浏览器渲染进程，由 Rust 直接产出 PDF/PNG。

- 唯一能恢复「选完路径直接落盘、无对话框」的方案，能精确控制页边距、页码、分页
- 图片质量最好，字体内联不再是问题
- **代价与产品定位直接冲突**：[packaging.md](packaging.md) 的体积目标与迁移计划第 8 节的基线（macOS ≤ 15 MB、Windows ≤ 10 MB）是这个项目迁移到 Tauri 的主要收益。Chrome/Chromium 分发动辄上百 MB，等于把收益吐回去。

## 建议

**分两步，先 A 后 B，C 不采用。**

1. **PDF 走方案 A**。零依赖、今天就能落地、渲染侧钩子已经写好。R1 要改成「PDF 用系统打印对话框，三平台原生支持」，并把删掉的那段 print CSS 搬回来。
2. **图片走方案 B，但先做原型再承诺**。先花半天验证 `foreignObject` → canvas 这条路在**一个真实文档 + 一个含表格和图表的文档**上的产出，与屏幕截图逐像素比对。原型通过就用它，不通过再考虑方案 B′（原生桥）。
3. **C 不采用**，理由是与体积目标冲突。除非将来产品定位变化，PDF 一定要一步到位。

如果方案 B 的原型失败，兜底是方案 B′：三平台各写一小段原生截图桥（mac `WKWebView.takeSnapshot`、win `WebView2.CapturePreview`、linux WebKitGTK snapshot）。这是 R3 原本的计划，写在本文档里是为了**在原型失败时不必重新推导一遍**，而不是首选。

### 取舍对照

| | PDF 一步到位 | 图片 | 新增依赖 | 与体积目标冲突 | 验收脚本能否自动跑 |
| --- | --- | --- | --- | --- | --- |
| A 打印对话框 | 否 | 不支持 | 无 | 否 | 只能验布局，验不了产物 |
| B SVG→canvas | 否 | 支持 | 无 | 否 | 可以，产出 PNG 可读回比对 |
| B′ 原生桥 | 否 | 支持（质量最好） | 三平台各一段 | 否 | 可以 |
| C 自带渲染引擎 | **是** | 支持 | Chromium 级 | **是** | 可以 |

## 从 Electron 版搬过来的经验

这几条是 `e64ea36^:src/main/image-export.ts` 里的结论，踩过的坑，重新实现时照搬，不必重新踩。

**捕获前必须等布局稳定**，且有超时。原文标的 15000ms（布局）/ 20000ms（捕获）。不等的情况是「用户没有窗口、没有文件、没有提示」，正是 #88 在 Windows 上报的现象。超时是让失败可见，而不是让等待无限。

**等的东西写全**：`document.fonts.ready`、所有 `<img>` 的 load/error、两次 `requestAnimationFrame`。

**超长文档走编号分页，不是失败**。分页时**用 `transform: translateY(-offset)`，不要用 `scrollTop`**：`scrollTop` 在文末会 clamp，这个错位就是之前整片内容错位、丢行的原因。

**输出分辨率取 `devicePixelRatio`，不要在它之上再乘 2**。旧的调试协议路线在显示器自身的 2 倍之上又要求 scale 2，等于每个导出都过采样、文件体积翻倍。

**隐藏窗口也要出帧**，否则每次捕获都在等一张永远不画的图（Electron 里是 `backgroundThrottling: false`）。Tauri 侧对应的问题需要单独验证。

## 验收

两个脚本已经存在于 `package.json`，改造后要全绿：

- `npm run verify:export-pdf`
- `npm run verify:image-export`

Electron 版 `verify-image-export.mjs` 的手法值得保留：**让文档的每一行携带一个编码了行号的颜色**，导出后逐行读回颜色，丢失、重复、压扁的行都能被数值化地抓到，而不是靠肉眼看图。

## 待确认

- 方案 B 原型：`foreignObject` 在含 mermaid 图表、表格、行内公式的文档上是否完整渲染
- Windows / Linux 上 `WebviewWindow::print()` 的实际表现（macOS 本机可验，另两个平台要 CI 或虚拟机）
- 三平台隐藏窗口出帧的等价做法
- 幻灯片 PDF（`exportSlidesPDF`）走 16:9 自定义纸张，与 A4 是两条路径，Electron 版用 `preferCSSPageSize` + `pageSize: {width, height}` 实现；Tauri 下 `print()` 不接受纸张参数，这条要单独想办法
