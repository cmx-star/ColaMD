# loomark

> A free, elegant Markdown editor anyone can pick up. No toolbars, no clutter, and the file on disk is always what you see.

**Language / 语言: [English](README.md) · [中文](README_CN.md)** · [Website](https://loomark.starcmx.com/)

loomark is an open-source, free, elegant Markdown editor for writing, notes, and documentation. It is built for people who just want to write: no toolbars, no status bar, nothing to configure: just your text and a file list, with a tab strip only when you open a second document.

It offers true WYSIWYG editing, 4 built-in themes with custom-theme import, rich-text copy, smart line breaks, search and replace, a document outline, PDF / HTML / Word export, and support for macOS, Windows, and Linux.

Whatever writes the file (an AI agent such as Claude Code or Codex, a script, or another editor), loomark shows the new content right away. No reopening, no manual refresh.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/release/marswaveai/loomark.svg)](https://github.com/marswaveai/loomark/releases)

[Download](#download) | [Features](#features)

---

## Screenshots

<p align="center">
  <img src="docs/images/tasks-en.png" alt="loomark showing an interactive task list" width="49%">
  <img src="docs/images/rendering-en.png" alt="loomark rendering a table and inline code" width="49%">
</p>

<p align="center"><em>Interactive task lists, and Markdown rendered as you type: headings, links, tables and inline code.</em></p>

## Themes

Four built-in themes — Light, Sepia, Solarized Dark and Nord. The [`themes/`](themes/) folder also ships more styles (Bear, Notion, iA Writer, Gruvbox, Dracula and friends) that you can import as custom themes, with a guide to [writing your own](themes/README.md).

<p align="center">
  <img src="docs/images/theme-swatches.svg" alt="loomark themes" width="92%">
</p>

## Features

- **Always in Sync**: Whenever the file changes on disk (an AI agent, a script, another editor), the editor updates immediately. No reopening, no manual refresh.
- **True WYSIWYG Editing**: Type Markdown and see rich text directly. No split-pane preview.
- **Files & Outline**: Browse Markdown files in the selected folder, or switch to a document outline for focused heading navigation.
- **Source Mode**: Switch to the raw Markdown source whenever you need to inspect or edit it directly.
- **Task Lists**: Click checkboxes to complete tasks, or use the keyboard shortcut.
- **Highlights & LaTeX**: Write `==highlighted text==` and render mathematical formulas with KaTeX.
- **Mermaid Diagrams**: Mermaid code blocks render as diagrams in an isolated hidden iframe with strict parsing; click a diagram to edit its source.
- **Search & Replace**: Find anything in the current document with ⌘/Ctrl+F, then replace the current match or all matches.
- **Smart Line Breaks**: Single newlines render as line breaks, matching how people and AI tools write Markdown.
- **Rich Text Copy**: Copy content with formatting preserved into WeChat, email, and other rich-text editors.
- **Themes**: Four built-in themes (Light, Sepia, Solarized Dark, Nord), plus custom themes you import from any CSS file.
- **Recent Files & Session Restore**: Jump back to the last 10 documents from the File menu, and reopen where you left off at launch.
- **Editor Font Settings**: Pick any installed system font and size for the editor; your choice wins over theme defaults.
- **Multiple Windows**: Independent editor windows, each with its own save queue and close protection.
- **Save Status Hint**: A quiet titlebar indicator shows unsaved/saved, then fades away.
- **Heading Anchors**: Click intra-document anchor links to jump between headings, CJK included.
- **Version Changelog**: The first launch after an update opens the built-in changelog once, so you can see what changed without repeated prompts.
- **PDF, HTML & Word Export**: Turn your Markdown document into a themed PDF, self-contained HTML, or editable Word document.
- **Image Export**: Share Markdown as one continuous PNG at the desktop or mobile reading width; longer documents continue as numbered pages.
- **Portable Image Paths**: Local images use safe `file://` URLs for display and return to relative paths when saved.
- **Minimal by Design**: No toolbar, no permanent sidebar, no distractions.
- **Cross-Platform**: Available for macOS, Windows, and Linux.

## Works with your Markdown workflow

loomark does not ask you to change your habits. It works well alongside Obsidian, Typora, VS Code, and other Markdown apps, all sharing the same `.md` files, with each tool doing what it does best.

## Download

> Check [Releases](https://github.com/marswaveai/loomark/releases) for the latest builds.

| Platform | Format |
|----------|--------|
| macOS    | `.dmg` |
| Windows  | `.exe` |
| Linux    | `.AppImage` / `.deb` |

## Roadmap

loomark will keep growing as a focused, free Markdown editor. A full history of every release, in both languages, lives in [`resources/demo/changelog.md`](resources/demo/changelog.md), which the app also opens after an update. See the [Releases](https://github.com/marswaveai/loomark/releases) page for the latest builds.

## License

[MIT](LICENSE), Free forever.


---

loomark is built by [Cola.app](https://cola.app) and maintained by [orange2ai](https://github.com/orange2ai). This fork is developed by [cmx-star](https://github.com/cmx-star). Issues, ideas and pull requests are welcome.
