# Tauri 迁移开发计划

- 状态：已批准（2026-09-30，维护者决定）
- 执行分支：`tauri-migration`（基线 `origin/main` 5e0f3c3）
- 本文取代 [feature-requests.md](feature-requests.md) 中 2026-09-13 的「System WebView shell (Tauri) migration」拒绝记录，收尾动作见 P0

## 1. 决策与依据

决定：从 Electron 迁到 Tauri 2（Rust 主进程 + 系统 WebView），目标是安装包体积。

**体检数据**（[packaging.md](packaging.md) 2026-09-12 实测）：

| 产物 | 现状 | 目标 |
| --- | --- | --- |
| macOS arm64 zip | 85.3 MB | ≤ 15 MB |
| macOS x64 zip | 90.1 MB | ≤ 15 MB |
| Windows exe | 115 MB | ≤ 10 MB（WebView2 引导式分发） |
| Linux AppImage / deb | 约 110 MB | ≤ 12 MB（另依赖系统 webkit2gt4） |

85 MB 的构成：Electron 运行时约 70 MB + dist 约 10 MB + asar 10.7 MB。asar 已经瘦身过（mermaid 曾占 83.5 MB 死重，已清），所以不换壳只剩几 MB 的空间，砍掉运行时是唯一路径。

上次拒绝的三个理由与现在的答案：

1. 「只有 macOS 划算」：现在体积是全局优先级，不是单一平台的执念。Windows 用 WebView2，Win10/11 默认带 Evergreen 运行时，LTSC 走引导下载加提示页。
2. 「没有可靠的系统 WebView」：macOS WKWebView、Windows WebView2、Linux WebKitGTK 都是事实标准，可控。Linux 份额低，用兜底提示页管理，不阻塞 mac/win。
3. 「主进程重写不值」：重写范围实测见第 4 节，main 2978 行加 preload 274 行；renderer 6724 行 TS 零改动平移，收益（约 70 MB）与成本（约 4 周单人）现在看是划算的。

## 2. 目标与非目标

目标：

- G1 体积达标（第 1 节目标表），产物结构与现版一致（dmg/zip、exe/zip、AppImage/deb）
- G2 核心编辑体验原样：所见即所得、文件热同步、原子保存、多标签、多窗口、大纲、搜索、主题、最近文件、幻灯片放映
- G3 用户数据保护语义不变（[PRINCIPLES.md](../PRINCIPLES.md) 第 2 条：原子保存、冲突先问用户、丢弃前写 recovered 副本）
- G4 安全模型不弱化：renderer 不直接碰文件系统，全部走 IPC，capability 按最小范围授予
- G5 验证脚本在新壳全绿：`verify:markdown`、`verify:image-export`、`verify:scroll-render`、`verify:features`、`verify:export-pdf`
- G6 性能不劣化（第 8 节测量表）

非目标：

- NG1 不做 UI 重写。renderer 是 DOM/TS 资产，原样平移
- NG2 不引入插件系统，维持现有功能边界
- NG3 不动 iOS app、VS Code 扩展、web playground

## 3. 迁移策略：三层结构

```
ColaMD.app
├── Rust 主进程（src-tauri/）        文件 IO、watcher、菜单、更新、原生桥接
├── WebView 前端资产                 src/renderer 原样（6724 行 TS + 2385 行 CSS）
└── 适配层 src/renderer/tauri-api.ts 与 ElectronAPI 同形状，底层换 @tauri-apps/api
```

关键决策：

- D1 适配层保持接口形状：`tauri-api.ts` 实现与 `ElectronAPI`（[src/preload/index.ts](../src/preload/index.ts)，77 个成员）相同的对象，`main.ts` 启动时挂到 `window.electronAPI`。renderer 其余文件零改动，事件订阅由适配层从 `ipcRenderer.on` 换成 `event.listen`。
- D2 构建链：electron-vite 退场，用 vite 打 renderer（[vite.web.config.ts](../vite.web.config.ts) 已有先例），`tauri.conf.json` 的 `frontendDist` 指向 `dist/renderer`。
- D3 主进程按域拆 Rust 模块，不做单文件堆砌（吸取 Electron 版 2553 行单文件的教训）。
- D4 文件监听与保存语义逐条对齐第 2 条原则：写临时文件加 rename 的原子保存、mtime 冲突检测、watcher 自愈、recovered 副本。这些已有 Electron 实现作参照，逐个对照移植。
- D5 迁移期双轨：Electron 构建配置保留，直到 Tauri 版发布后的一个大版本才删。bugfix 仍进 main，新功能只进 tauri-migration（防 R7）。

## 4. 代码资产映射

| 资产 | 行数 | 去向 |
| --- | --- | --- |
| src/renderer（TS） | 6724 | 原样平移 |
| src/renderer/themes（CSS） | 2385 | 原样平移 |
| src/main/index.ts | 2553 | 重写为 src-tauri 下按域的 Rust 模块 |
| src/main/image-export.ts | 239 | 原生截图桥接（Rust 加平台 API，见 P5） |
| src/main/docx-export.ts | 189 | 移到 renderer 侧生成，plugin-dialog 保存（纯 TS 逻辑，docx 库与平台无关） |
| src/preload/index.ts | 274（77 成员） | 适配层加 Rust commands |
| mobile/ios | Swift | 不动 |
| vscode-extension | JS | 不动 |
| src/web | TS | 不动 |
| scripts/verify-* 等 6 个 | 约 1700 | 适配驱动方式（P7，见 R8） |
| electron-builder.yml | | 换成 src-tauri/tauri.conf.json 的 bundle 段 |
| .github/workflows/release.yml | | 重写（P6） |

## 5. 阶段计划

每个阶段独立提交，验收不过即停。工作日按单人估算。

### P0 决策记录与基线（0.5 天）

- feature-requests.md 追加取代 2026-09-13 拒绝记录的条目，指向本文
- 本计划入库；分支 tauri-migration 已建于 origin/main（5e0f3c3）
- 验收：文档提交完成，工作树干净

### P1 工具链与最小壳（1 天）

- 装 rustup（本机实测 static.rust-lang.org 通，cargo 走已配置的中科大镜像）；`npm install`
- 搭 src-tauri 骨架：vite 打 renderer（`vite.tauri.config.ts`），frontendDist 指向 `dist-tauri/renderer`。与 Electron 的 `dist/renderer` 分开，两套壳在迁移期可以各自构建互不覆盖
- 窗口按 design.md（标题栏拖拽区、Overlay 标题栏、chrome 行高）
- 验收：Tauri 窗口跑起现有界面，与现版截图一致；先量一次产物体积作对照
- 实测（2026-10-09）：release 打包 `ColaMD.app` 6.4 MiB（对照 Electron 未压缩 215 MB、arm64 zip 85.3 MB），真机窗口渲染与编辑正常

### P2 文件 IO 地基（3 天）

- Rust commands：openFile / openFilePath / activateFile / listSiblings / listDirectory / revealFile / saveFile / saveFileAs / getFileManagerName
- 保存语义照搬现有实现：**普通写入，不是临时文件加 rename**（原先这里写错了）。Electron 版本就是普通 writeFile，而「原子保存」指的是**检测**外部写入者用 rename 替换文件：所以 watcher 盯父目录，而不是绑在文件的 inode 上
- mtime 冲突检测、watcher（100ms 防抖、300ms 抑制 FSEvents 历史、自愈、rename 检测、兄弟文件 300ms 刷新、比对内容跳过自写回声）、recovered 副本逻辑
- 验收：外部改写 1 秒内刷新；`save(open(x)) === x`；冲突路径与现版一致（先问用户，副本落 `~/.colamd/recovered`，写不成功不丢弃）

**进度（2026-10-09）**：文件 IO、watcher、关闭保护、冲突流程、最近文件、菜单、主题、系统字体、HTML 导出已完成；`cargo test` 22 项通过；实测外部改写 1 秒内到达渲染层。手工验收清单见 [tauri-test-plan.md](tauri-test-plan.md)。

### P3 适配层与窗口、标签（3 天）

- tauri-api.ts 覆盖 77 个成员；多窗口；标签数据与切换；最近文件（recent.json 迁到 app data dir，用 tauri path API）
- 验收：README 功能清单逐条过；关闭保护、会话恢复策略不变；P2 的验收在新路径复测

### P4 菜单、系统集成、更新、签名（2 天）

- buildMenu 355 行移植为 Rust menu（含 i18n 现文案、主题勾选态、快捷键）；popupAppMenu
- 文件关联（bundle.fileAssociations）；tauri-plugin-updater 加 GitHub Releases endpoint 加密钥对；macOS 公证（Apple API key）
- 验收：菜单项与快捷键逐条对；更新流在预发布环境验一次；Windows 先免签名跑通，签名证书预算确认后再上（R9）

### P5 导出（3 天）

- PDF：改 print CSS 加系统打印对话框（导出规范先更新 design.md，per PRINCIPLES 第 7 条）
- 图片导出：原生截图桥接，mac 用 WKWebView takeSnapshot、win 用 WebView2 CapturePreview、linux 用 WebKitGTK snapshot；16384px 分页逻辑保留；兜底是前端 SVG 转 canvas 方案（字体内联代价大，仅作应急）
- docx：renderer 侧生成加 plugin-dialog 保存
- 验收：verify:image-export、verify:export-pdf、verify:markdown 适配后全绿

### P6 打包与 CI（2 天）

- bundle 目标：mac dmg 加 zip（双架构，不 universal）、win nsis 加 zip、linux AppImage 加 deb
- release.yml 重写：ubuntu job 装 webkit2gt4 依赖，mac 用 Xcode CLT，win 装 WebView2 引导策略
- 验收：三平台产物出齐，体积达标（第 1 节表）

### P7 验证、回归、发布演练（3 天）

- 6 个验证脚本适配为 Tauri 驱动（候选方案见 R8）
- 中文 IME 场景回归（P1 起每个阶段持续跑）
- README 功能清单全量走查，打包安装实测
- 验收：产出可发布候选版，测量结果回写 packaging.md

合计约 17.5 个工作日，加 20% buffer 约 4 周（单人）。

## 6. 环境前提（本机 2026-09-30 实测）

| 项 | 状态 |
| --- | --- |
| Node / npm | v22.22.0 / 10.9.4，通 |
| rustup / cargo | 未安装，装（static.rust-lang.org 返回 200） |
| crates.io | 直连 403，本机 ~/.cargo/config.toml 已配中科大镜像（200），cargo 可用 |
| npm registry | 200 |
| GitHub | 200 |
| Xcode CLT | 有 |
| 磁盘 | 剩 38 GB |

Windows 的 WebView2 与 Linux 的 webkit2gt4 在 CI 目标平台安装。

## 7. 风险登记册

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | PDF 从一键导出降级为打印对话框两步 | 产品决策，已接受；print CSS 调好分页与主题配色，design.md 先立规范 |
| R2 | macOS WKWebView 的中文 IME 组合行为未测 | P1 起每个阶段跑中文输入冒烟：全拼、候选上屏、组合中回车 |
| R3 | 图片导出没有 capturePage 等价能力 | 原生截图桥接；兜底前端 SVG 转 canvas（字体内嵌代价大，应急用） |
| R4 | Windows WebView2 缺失（LTSC 等） | 引导式下载加提示页，安装说明写清 |
| R5 | 自动更新链路变更 | tauri-plugin-updater 加 latest.json（公开仓库可直接用 GitHub Releases），密钥进 CI secrets |
| R6 | Linux WebKitGTK 渲染差异 | check-theme-colors 加截图比对；兜底 Linux 暂缓发布，不阻塞 mac/win |
| R7 | 迁移期 Electron 版并行发版 | 冻结 feature 进 tauri-migration，bugfix 仍进 main，合并前 rebase |
| R8 | 验证脚本依赖 CDP 远程调试 | 候选 A：dev 构建开放 CDP 端口；候选 B：应用内验证页。P7 先试 A |
| R9 | Windows 代码签名证书成本 | 先免签名内测，证书预算确认后再签 |
| R10 | renderer 里 Electron 假设泄漏（getPathForFile、contextIsolation 等） | P3 全量 grep electronAPI 使用点，逐一映射，不靠记忆 |

## 8. 测量基线（先测量，再优化）

| 指标 | 基线（Electron 2.7.2） | 验收 |
| --- | --- | --- |
| macOS arm64 zip | 85.3 MB | ≤ 15 MB |
| Windows nsis / zip | 115 MB | ≤ 10 MB |
| 冷启动（COLAMD_STARTUP_TRACE，同机同条件） | 迁移前记录一次 | 劣化 ≤ 20% |
| 常驻内存 | 迁移前记录一次 | 劣化 ≤ 20% |
| 1 MB markdown 打开耗时 | 迁移前记录一次 | 劣化 ≤ 20% |

结果连同方法写回 [packaging.md](packaging.md)。

## 9. 回滚与中止

- 每阶段独立提交，验收不过即停，不带病进下一阶段
- tauri-migration 不合并回 main，直到候选版全绿；Electron 构建保留至 Tauri 版发布后一个大版本
- 中止条件：R2 或 R3 无法解决到产品可接受。中止则回到 Electron 加免费瘦身路线（删 milkdown 死依赖、KaTeX 懒加载、字数统计按需、mermaid iframe 复用），该路线不因迁移而废弃，可先做

## 10. 执行纪律

- 每阶段：`npm run build`、三份 tsconfig typecheck、`npx tauri dev` 真机点验；UI 改动必须真机真窗口（PRINCIPLES 第 9 节）
- 提交前逐个确认文件清单；commit 风格沿用仓库现状（`fix(scope): ...`、`chore(release): ...`）
- 与 design.md 或 PRINCIPLES.md 冲突的方案，先改规范再动代码

## 相关文档

- [PRINCIPLES.md](../PRINCIPLES.md)：稳定性优先、用户数据不可丢、先测量再优化、决策留痕
- [packaging.md](packaging.md)：体积与打包实测记录
- [editor-architecture.md](editor-architecture.md)：编辑器文本优先架构（引擎无关，迁移的最大资产）
- [feature-requests.md](feature-requests.md)：需求裁决记录，本文取代其中 2026-09-13 的 Tauri 拒绝条目
