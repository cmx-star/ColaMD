# loomark

## 产品定位

**Markdown as Database 的原生编辑器与模板渲染平台。**

### 解决的核心问题

HTML 难改——结构、样式、内容全混在一起，人改麻烦，Agent 改也要理解整个文件。

解法：把内容从 HTML 里剥离出来，放进 markdown。HTML 变成纯模板，markdown 变成数据库。改内容只改 markdown，完全不碰 HTML。

### 战略方向

- **内容层**：`.md` 文件，字段固定，人和 Agent 都能轻松编辑
- **模板层**：各种 HTML 模板（PPT、游戏化界面、博客、简历、产品落地页……）
- **loomark**：连接两者的工具，也是这个生态的入口

一份 markdown，多种渲染形态。未来第三方可以基于同一份 markdown 做自己的模板。

### 核心理念：Markdown as Database

Markdown 不只是文档，而是**结构化内容的数据源**。

- **Markdown = 数据**：用固定字段（frontmatter + 约定的 section 结构）承载内容，Agent 只需按字段改内容
- **HTML 模板 = 视图**：模板负责样式、动效、交互，不关心内容
- **解耦**：换模板就是换皮，换内容不影响模板
- **简单约定优先**：宁可让 markdown 字段固定一些，也不要让模板去猜语义

## 设计哲学

### 如非必要，勿增实体

这是 loomark 的第一原则。每增加一个 UI 元素、一个功能、一行代码，都要问：这是绝对必要的吗？默认答案是否。

- 不要工具栏（用户会用快捷键和 Markdown 语法）
- 不要常驻侧边栏（打开文件时显示所在目录；无文件时默认显示文稿目录，可 ⌘T 隐藏）
- 不要状态栏
- 界面只有：标题栏（拖拽用）+ 编辑器 + 文件列表面板
- 追求极致的简单，一个功能做到极致

### 核心功能优先级

1. **文件热更新**（核心卖点）— 外部 Agent 修改 .md 时自动刷新，实时看到 Agent 的工作
2. **所见即所得** — 输入 Markdown 即刻渲染为富文本
3. **文件列表面板** — 打开文件时显示所在目录的 Markdown 文件；无文件时默认显示文稿目录；支持轻量目录浏览、点击切换，Agent 新建/删除文件实时刷新
4. **双链** — `[[文件名]]` / `[[文件名#标题]]` 在渲染模式下可点击，跳到当前目录（含子目录）里的 Markdown 文件
5. **主题系统** — CSS 主题，可导入自定义主题
6. **导出** — PDF、HTML

### UI 视觉与交互规范

- **图标统一使用线性 SVG**：功能图标不使用 Unicode 字符、Emoji 或系统字体图标代替。
- **线条统一**：默认 `stroke-width: 1.3`，使用 `stroke-linecap="round"` 和 `stroke-linejoin="round"`；同一组图标的尺寸、视口和视觉重量保持一致。
- **同类控件统一**：文件、文件夹、返回上级等图标应使用同一套线性图标语言，不允许单独引入粗细或风格不同的符号。
- **图标必须可理解**：每个图标按钮都要有 hover 文字说明，同时设置 `title` 和 `aria-label`；说明文字使用简洁、自然的中文。
- **优先复用样式**：图标尺寸、间距、颜色和 hover 状态统一放在共享 CSS 中，避免在业务代码里写零散样式。
- **克制可见元素**：遵循“如非必要，勿增实体”，只在确有功能价值时增加图标、按钮或提示。

### 发布约定

- 更新是攒着发的，不每天发版：修好一段时间内的反馈后集中出一版。因此**写 changelog 前先看这一版攒了什么**：`git log <上一个 tag>..main --oneline`，别只看手上最后那几笔
- 每个大版本更新后：在 `resources/demo/changelog.md` **追加**本版更新内容，并更新对应的演示文件
- 演示目录随包发布，但**应用内不再有入口**（2026-10-09 起去掉了「新功能演示」菜单项）：用户可直接打开包内的 `demo/` 目录
- 演示页已接入菜单，打包时随 extraResources 发布
- **文案不使用破折号**（`—`）：列表项用冒号分隔（`- **功能**: 说明`），正文改用逗号、冒号或括号
- 官网在 `gh-pages` 分支，`index.html` 是唯一入口（手写双语，`data-en` / `data-zh` 属性 + 语言切换脚本）
- 官网首页的功能卡片**固定 9 张**，主题区排在功能卡片之前；完整功能列表只写在 README 里
- 产品定位讲用户价值（免费、优雅、简单、文件永远是最新的），不以「AI Agent 原生」自我定义；Agent 只作为同步功能的一个举例

### 两种查看方式

- **渲染**（默认）：一篇干净的排版，**任何一行都不露源码**，但照旧能编辑。
  曾经有过「光标所在的那一行露源码」的编辑模式。2026-10-06 取消：屏幕上不该为「偶尔改个标记」留一半噪音，要改标记就去源码模式。
- **源码**（`⌘/`，顶栏那个 `<>` 按钮）：整篇都是源码。改标记、修表格这类事情在这里做。
- 渲染模式下每个渲染块仍然可以点进去把光标放进它的源码（表格、公式、图片、HTML 等），打字会照常反映到渲染上。
- 文首的 YAML 属性区默认收起，光标进去才展开。打开文件时光标落在它之后（`bodyStart`），否则敲下去的字会落在看不见的地方。

### 不做的事情

- 不做持久化工作区和全量文件树（只提供当前目录与默认文稿目录的轻量浏览）
- 不做知识库管理、反向链接面板、图谱视图（双链只做 `[[文件名]]` 跳转，见「核心功能优先级」第 4 条）
- 不做云同步、协作编辑（专注打磨本地 Markdown 编辑手感与基础能力）
- 不做笔记组织和标签系统
- 不加不必要的 UI 元素（工具栏、状态栏等）

## 技术栈

- Tauri 2（Rust 主进程 + 系统 WebView；2026-09-30 从 Electron 迁入，理由见 [docs/tauri-migration-plan.md](docs/tauri-migration-plan.md)）
- CodeMirror 6（文本优先的编辑器内核：文件里存的是字节，渲染只是叠在字节上的一层装饰。纪律与坑见 [docs/editor-architecture.md](docs/editor-architecture.md)）
- TypeScript 严格模式
- vite（渲染层构建）+ tauri build（应用打包）

## 项目结构

```
src-tauri/src/      # Rust 外壳：文件 I/O、watcher、菜单、窗口、主题
src/renderer/       # 渲染层，原样平移自 Electron 版
├── index.html
├── main.ts         # 入口，连接编辑器与外壳
├── platform-api.ts # 外壳接口的形状（70 余个成员）
├── tauri-api.ts    # 上面那份接口的 Tauri 实现
├── editor/         # CodeMirror 6 编辑器核心
├── verify/         # 验收检查项，随包编译（CSP 禁止 eval）
└── themes/         # CSS 主题 + 主题管理器
```

## 开发规范

- TypeScript 严格模式
- 编辑器核心与 UI 解耦
- 主题 CSS 与编辑器逻辑完全分离
- 代码简洁，不过度设计
- 每个新功能先问：这是必要的吗？
- UI、图标、间距和交互规范详见 [design.md](design.md)，所有参与者提交界面改动前都应检查贡献清单。
- 产品与工程的判断标准汇总在 [PRINCIPLES.md](PRINCIPLES.md)：稳定性优先、用户数据不可丢、先测量再优化、决策留痕等。
- 本地打包验证的实测数据与规矩见 [docs/packaging.md](docs/packaging.md)：本地只打单架构 `--dir`，不在软链 `node_modules` 的 worktree 里打包。
- 验收窗口一律**移到屏幕外，不要隐藏**（`COLAMD_VERIFY` 时由外壳摆放）。隐藏的窗口永远等不到一次 paint，截图类的检查会挂到超时且不报错（上游 `1e9b481` 踩过）。`--window-position` 那种做法不要再用：它对 Electron 不生效，实测被忽略。
- 跑需要二进制的验收脚本前先 `npm run build && npx tauri build --no-bundle`。忘了构建会拿旧产物去验，红的是假的；`scripts/build-freshness.mjs` 的 `assertBuildFresh()` 会拦住这种情况（它同时判渲染层产物和二进制两样）。
- 验收脚本（改动碰到哪儿就跑哪条，拿不准就都跑）：
  - `npm run verify:markdown`：打开再保存，字节不许变（`save(open(x)) === x`）。纯 Node，直接消费 TS 源码，不需要构建
  - `npm run verify:links`：本地链接解析（中文与编码文件名、行号后缀、标题锚点）。纯 Node，同样不需要构建
  - `npm run verify:scroll-render`：滚到没解析过的地方，那几行也必须渲染过
  - `npm run verify:themes`：主题 CSS 的每条规则都要命中真实元素并改变计算样式
  - `npm run check:theme-colors`：12 套内置主题与独立主题文件的变量契约
  - 类型检查：`npx tsc --noEmit -p tsconfig.renderer.json`，外壳是 `~/.cargo/bin/cargo check`（`cargo` 不在 PATH 上）
- 验收脚本的工作目录与进程回收统一走 `scripts/verify-workdir.mjs`：每个脚本一个固定目录、开跑前后各清一次，进程按标记 `pkill` 而不是按 pid —— 脚本自己被强杀时 `finally` 根本不会跑到，进程就留在机器上了。标记之间不能互为前缀（`pkill -f` 是子串匹配）。
- **已知缺口**：`verify:export-pdf`、`verify:features`、`verify:image-export` 三个脚本仍在 spawn 已被删除的 Electron（全仓已无 Electron 依赖），目前跑不起来，待迁移到 `COLAMD_VERIFY` 通道。
