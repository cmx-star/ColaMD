# Tauri 版测试文档

这份文档给**手工验收**用：告诉你跑什么、怎么跑、期望看到什么，以及哪些是**已知未移植**（不要当 bug 报）。

背景与阶段划分见 [tauri-migration-plan.md](tauri-migration-plan.md)。当前进度：外壳（P1）、文件 IO 与监听、关闭保护、冲突流程、菜单、主题、字体、HTML 导出已完成；导出 PDF/图片/Word、自动更新、右键菜单尚未移植。

## 一、怎么跑起来

**方式 A：一条命令（最省事）**

```bash
cd /Users/cmx/Downloads/ColaMD-main
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri dev
```

它会自己起渲染层 dev server、编译 Rust、弹出窗口。改前端代码热更新，改 Rust 代码自动重编。

**方式 B：分开跑（便于抓日志，我平时用这个）**

```bash
# 终端 1：渲染层 dev server，保持运行
cd /Users/cmx/Downloads/ColaMD-main
npm run dev:tauri:renderer

# 终端 2：带追踪启动，可跟一个文件路径
cd /Users/cmx/Downloads/ColaMD-main
export PATH="$HOME/.cargo/bin:$PATH"
COLAMD_TRACE=1 ./src-tauri/target/debug/colamd /path/to/note.md
```

**打包版**（验证内嵌资源路径，和 dev 是两条不同路径）：

```bash
npm run tauri build -- --bundles app
open src-tauri/target/release/bundle/macos/ColaMD.app
```

**取证抓手**：`COLAMD_TRACE=1` 时，每个关键决策会往 stderr 打一行 `[colamd] ...`。截图加这几行日志，我就能判断是界面问题还是逻辑问题。日志样例：

```
[colamd] menu built (theme=, lang=en)
[colamd] renderer ready (fullscreen=false)
[colamd] watching /tmp/colamd-fixture.md
[colamd] opened /tmp/colamd-fixture.md (263 bytes)
[colamd] menu built (theme=elegant, lang=en)
[colamd] watcher: /tmp/colamd-fixture.md changed on disk, handing it to the renderer
```

界面语言默认跟随系统；系统不是中文时菜单是英文，这是和 Electron 版一致的行为。

## 二、测试清单

按优先级排：前五项过了，迁移的地基就算立住了。每项都写了期望结果，**截图时请把对应的 `[colamd]` 日志一起截进来**。

### T1 核心｜外部改写热更新

**为什么最重要**：这是产品第一卖点（文件永远是最新的），也是整个迁移最容易被悄悄做坏的地方。

```bash
# 先用方式 B 打开一个文件
printf '\n外部追加于 %s\n' "$(date +%T)" >> /path/to/note.md
```

| 项 | 内容 |
| --- | --- |
| 期望 | 不重开、不刷新，窗口里 1 秒内出现新内容（默认 100ms 防抖） |
| 日志 | `watcher: <路径> changed on disk, handing it to the renderer` |
| 通过标准 | 内容确实变了，且光标位置没有被顶走 |

再补一个原子保存的场景（Agent 常用「写临时文件再改名」）：

```bash
printf 'agent 原子写入的内容\n' > /tmp/atomic.tmp && mv /tmp/atomic.tmp /path/to/note.md
```

期望同样刷新；日志里**不应**出现 `watcher: own write ignored`（那是自己写盘的回声，不该误判）。

### T2 打开文件

| 步骤 | 期望 |
| --- | --- |
| 菜单 文件 → 打开…（⌘O），选一个 .md | 内容载入，标题栏显示文件名 |
| 已是打开状态时再 ⌘O 选另一个 | 新文件**在新标签页**打开，不是替换 |

日志：`opened <路径> (N bytes)`、`watching <路径>`。

### T3 保存

| 步骤 | 期望 |
| --- | --- |
| 改几个字，⌘S | 标题栏保存状态从「未保存」变「已保存」 |
| 在终端 `cat` 那个文件 | 磁盘上确实是你改后的内容 |
| **只打开不改**，⌘S | 文件**一个字节都不变**（这是仓库最老的纪律） |

日志：`saved <路径> (N bytes)`。

### T4 另存为

⌘⇧S 选新位置：内容写到新文件，窗口标题跟过去，原文件保持不动。日志同上。

### T5 关闭保护（用户数据不可丢）

| 步骤 | 期望 |
| --- | --- |
| 改内容不保存，点窗口红灯 / ⌘W 关标签 / ⌘Q | 弹三按钮对话框：保存 / 不保存 / 取消 |
| 选「取消」 | 窗口留着，内容还在 |
| 选「保存」 | 写盘后关闭 |
| 选「不保存」 | 直接关闭（内容丢弃是用户明确选的） |

日志：`close guard: unsaved changes, asking`；没有未保存内容时应是 `close allowed: nothing unsaved`。

### T6 冲突：外部改写撞上本地未保存

```bash
# 窗口里改几个字但不要保存，然后在终端改同一个文件
printf '\n别人写的内容\n' >> /path/to/note.md
```

| 项 | 内容 |
| --- | --- |
| 期望 | 弹警告对话框，两个按钮：保留我的版本 / 加载磁盘上的版本 |
| 选「保留我的」 | 编辑器内容不变，可以继续编辑 |
| 选「加载磁盘」 | 先写出恢复副本再加载；标题栏提示副本位置，点击能定位到文件 |
| 恢复副本 | `ls -lt ~/.colamd/recovered/` 里能看到 `<文档名>-<时间戳>.md` |

**关键**：如果恢复副本写不成功，**不允许**丢弃编辑器内容（会退回「保留我的版本」）。

### T7 中文输入法（迁移的重点风险）

macOS 上渲染引擎从 Chromium 换成了 WKWebView，输入法组合行为是全新未测区域。

| 步骤 | 期望 |
| --- | --- |
| 全拼连续输入，观察候选词窗口 | 候选框位置跟随光标，不闪、不飘 |
| 组合中按回车 | 上屏，不吞字、不重复 |
| 一次输入较长句子（20 字以上） | 每个字都上屏，无丢字、无乱序 |
| 中文输入后立刻 ⌘S | 保存的是完整内容 |

这条任何异常都请截图（含输入法候选框状态），它决定迁移是否继续。

### T8 标签页与文件面板

| 步骤 | 期望 |
| --- | --- |
| ⌘T 新建标签页 | 出现新标签，正文为空白文档 |
| 文件面板点同目录另一个 .md | 当前标签切过去（不是新标签） |
| ⌘W 关闭标签 | 关掉当前标签；只剩最后一个且干净时关窗口 |
| 在目录里新建/删除 .md（外部） | 文件面板 300ms 内自动刷新 |
| 面板右缘拖动 | 宽度可调（200 到 420） |

### T9 主题与外观

| 步骤 | 期望 |
| --- | --- |
| 主题菜单切换 12 个内置主题 | 立刻换肤，菜单勾选跟随 |
| 主题 → 导入主题…，选一个 .css | 导入后出现在主题菜单的自定义区，勾选可用 |
| 视图 → 正文宽度 窄/标准/宽 | 正文列宽变化，菜单勾选跟随 |
| 视图 → 文件列表位置 左/右 | 面板换边 |
| 视图 → 编辑器字体… | 字体对话框能列出系统字体（macOS 走 AppKit 查询，与 Electron 版同一份名单） |

日志：切换后应看到 `menu built (theme=<名字>, lang=...)`，说明勾选状态回报并重建了菜单。

### T10 菜单与快捷键

| 快捷键 | 期望 |
| --- | --- |
| ⌘F | 打开查找面板（不是 CodeMirror 自带那个英文面板） |
| ⌘B / ⌘I / ⌘E / ⌘K | 加粗 / 斜体 / 行内代码 / 插入链接（网址取自剪贴板） |
| ⌘⇧8 / ⌘⇧7 | 无序 / 有序列表 |
| ⌘\ | 显示/隐藏文件列表 |
| ⌘/ | 切换 Markdown 源码模式 |
| ⌘⇧P | 放映幻灯片 |
| ⌘⇧D | 新功能演示（打开内置 changelog） |
| ⌘⇧/ | Markdown 语法速查 |
| 文件 → 新建（⌘N） | 打开一个新的空白窗口 |
| 视图 → 增强/缩小/实际大小 | 缩放生效并记住 |

### T11 大文件

准备一个约 1MB 的 markdown（可 `python3 -c "print('# t\n\n' + '段落内容 '*50000)" > /tmp/big.md`）：

| 项 | 期望 |
| --- | --- |
| 打开耗时 | 可接受（对比 Electron 版，劣化不超过 20%） |
| 滚动 | 不卡顿、不留白（滚动渲染回归网：`npm run verify:scroll-render` 尚未适配 Tauri） |
| 滚动后再外部改写 | 仍然 1 秒内刷新 |

### T12 导出

| 项 | 现状 |
| --- | --- |
| 文件 → 导出 HTML… | **可用**：选路径后写出独立 HTML，并在文件管理器里定位 |
| 文件 → 导出 PDF… | 未移植（见下） |
| 文件 → 导出图片（电脑/手机） | 未移植 |
| 文件 → 导出 Word… | 未移植 |

### T13 多窗口

文件 → 新建打开第二个窗口：两个窗口各自维护文件、保存与关闭保护；在 A 窗口导入主题或在字体对话框改字体，B 窗口应同步（字体改动会广播到其它窗口）。

## 三、已知未移植（不要当 bug 报）

| 项 | 原因 |
| --- | --- |
| 导出 PDF | Electron 用 `printToPDF`，Tauri 与系统 WebView 都没有等价能力。计划改走 print CSS + 系统打印对话框（「存储为 PDF」由用户点），见迁移计划 R1 |
| 导出图片 | 原实现用隐藏窗口截图。浏览器不暴露「截取本 webview」，需要按平台写原生桥接（WKWebView takeSnapshot / WebView2 CapturePreview / WebKitGTK snapshot），见 R3 |
| 导出 Word | 生成逻辑依赖 `docx` 包与 Electron 的 nativeImage，要搬到渲染层重建 |
| 检查更新 | 菜单项置灰，等 `tauri-plugin-updater` 接入密钥与 latest.json |
| 文件面板 / 标签页右键菜单 | 尚未接 Tauri 的原生菜单弹出 |
| 窗口大小与缩放记忆 | 尚未接 `window-state.json` |
| 会话恢复策略 | Electron 版本身待重设计，未搬 |
| Windows 标题栏菜单按钮 | `popupAppMenu` 需要把按钮位置传进来才能弹菜单 |

## 四、我这边已实测通过的

| 项 | 证据 |
| --- | --- |
| Rust 单元测试 22 个 | `cargo test`：字节保真 `save(open(x)) === x`、外部改动检测（1ms 容差）、兄弟文件排序与隐藏目录、保存默认名、路径兼容、恢复副本命名 |
| 菜单构建与勾选回报 | 日志 `menu built (theme=elegant, lang=en)`，主题回报后自动重建 |
| 启动参数打开文件 | 日志 `opened /tmp/colamd-fixture.md (263 bytes)` + `watching ...` |
| 外部改写热更新 | 日志 `watcher: ... changed on disk, handing it to the renderer`，两秒内出现 |
| 打包产物 | `ColaMD.app` 6.4 MiB（对照 Electron 未压缩 215 MB、arm64 zip 85.3 MB） |
| Electron 版仍可构建 | `npm run build` 通过，双轨未破 |

## 五、结果怎么回传

每条按这个格式给我就行：

```
T5 关闭保护
现象：<你看到的>
日志：[colamd] ...（有就贴）
截图：<附上>
```

有异常的条目优先给 T1、T3、T5、T6、T7：这五条分别对应热更新、字节保真、数据不丢、冲突保护、中文输入，是这次迁移最不能出错的地方。
