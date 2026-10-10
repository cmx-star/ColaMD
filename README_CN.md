<br />

> 一款免费、优雅、谁都能上手的 Markdown 编辑器。没有工具栏，没有多余的东西，而且文件永远是最新的。

**Language / 语言:** **[English](README.md)** **·** **[中文](README_CN.md)** · [官网](https://loomark.starcmx.com/)

loomark 是一款开源、免费、优雅的 Markdown 编辑器，用于写作、记录和文档。它为「只想好好写字」的人而做：没有工具栏、没有状态栏、不需要任何配置；你的文字和文件列表就是全部，标签栏只在你开第二个文档时才出现。

它支持所见即所得、4 个内置主题（可导入自定义主题）、富文本复制、智能换行、查找替换、文档大纲、PDF / HTML / Word 导出，并支持 macOS、Windows 和 Linux。

无论是什么在写这个文件（Claude Code、Codex 这类 AI Agent，一个脚本，或另一个编辑器），loomark 都会立刻显示最新内容，不用重开文件，也不用手动刷新。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/release/marswaveai/loomark.svg)](https://github.com/marswaveai/loomark/releases)

[下载](#下载) | [功能](#功能)

***

## 截图

<p align="center">
  <img src="docs/images/tasks-zh.png" alt="loomark 打开的待办列表演示文档" width="49%">
  <img src="docs/images/rendering-zh.png" alt="loomark 渲染的表格与行内代码" width="49%">
</p>

<p align="center"><em>交互式待办列表，以及边写边渲染的标题、链接、表格与行内代码。</em></p>

## 主题

4 个内置主题——浅色、羊皮纸、夜航、极地。`themes/` 目录里还附带更多样式（Bear、Notion、iA Writer、Gruvbox、Dracula 等），可以导入为自定义主题，另有[自己写主题的说明](themes/README.md)。

<p align="center">
  <img src="docs/images/theme-swatches.svg" alt="loomark 主题" width="92%">
</p>

## 功能

* **文件实时同步**: 无论是 AI Agent、脚本还是另一个编辑器改了文件，内容都会立刻出现在编辑器中，不用重开、不用刷新。

* **真正的所见即所得**: 输入 Markdown，直接看到富文本，无需分屏预览。

* **文件与大纲**: 浏览所选目录中的 Markdown 文件，或切换为文档大纲，专注在标题之间导航。

* **源码模式**: 需要查看或直接修改原始 Markdown 时，一键切换源码编辑。

* **待办列表**: 直接点击复选框完成任务，也支持快捷键。

* **高亮与 LaTeX**: 使用 `==高亮文本==`，并通过 KaTeX 渲染数学公式。

* **Mermaid 图表**: Mermaid 代码块在独立隐藏 iframe 中渲染为图表；点击图表即可编辑源码。

* **查找与替换**: 使用 ⌘/Ctrl+F 快速查找内容，支持替换当前匹配项或全部替换。

* **智能换行**: 单个换行直接渲染为换行，符合人类和 AI 工具写 Markdown 的习惯。

* **富文本复制**: 复制后粘贴到公众号、微信、邮件等富文本编辑器，格式完整保留。

* **主题**: 4 个内置主题（浅色、羊皮纸、夜航、极地），也可从任意 CSS 文件导入自定义主题。

* **最近文件与会话还原**: 「文件 → 最近打开」直达最近 10 篇文档，启动时自动恢复上次编辑位置。

* **编辑器字体设置**: 为编辑器选择任意已安装的系统字体与字号，用户设置优先于主题默认。

* **多窗口**: 独立的编辑器窗口，各自维护保存状态与关闭保护。

* **保存状态提示**: 标题栏安静地显示未保存/已保存状态，随后自动淡出。

* **标题锚点跳转**: 点击文档内锚点链接即可跳转到对应标题，中文标题同样支持。

* **版本更新说明**: 每次更新后的首次启动自动打开内置 changelog，了解变化后不会重复打扰。

* **PDF、HTML 与 Word 导出**: 将 Markdown 文档导出为带主题背景的 PDF、独立 HTML 或可编辑的 Word 文档。

* **图片导出**: 按电脑或手机的阅读宽度，把整篇导出为一张连续 PNG 长图；超长文档自动续为编号页面。

* **图片路径可移植保存**: 本地图片显示使用安全的 `file://` URL，保存时恢复为相对路径。

* **极简设计**: 没有工具栏，没有永久侧边栏，专注于内容本身。

* **跨平台**: 支持 macOS、Windows 和 Linux。

## 与现有 Markdown 工作流配合

loomark 不要求你改变现有习惯，也适合与 Obsidian、Typora、VS Code 等 Markdown 软件配合使用。它们共享同一套 `.md` 文件，你可以用不同工具完成不同任务。

## 下载

> 查看 [Releases](https://github.com/marswaveai/loomark/releases) 获取最新构建。

| 平台      | 格式                   |
| ------- | -------------------- |
| macOS   | `.dmg`               |
| Windows | `.exe`               |
| Linux   | `.AppImage` / `.deb` |

## 路线图

loomark 会继续把「免费、优雅、专注」这件事做好。每个版本的完整历史（中英双语）都在 [`resources/demo/changelog.md`](resources/demo/changelog.md)，应用更新后也会自动打开它。最新构建见 [Releases](https://github.com/marswaveai/loomark/releases)。

## 开源协议

[MIT](LICENSE)，永久免费。

***

loomark 由 [Cola.app](https://cola.app) 开发，作者 [orange2ai](https://github.com/orange2ai)。本 fork 由 [cmx-star](https://github.com/cmx-star) 二开。欢迎提交 Issue、想法和 Pull Request。
