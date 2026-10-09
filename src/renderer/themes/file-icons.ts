// Colour file icons for the file panel, taken from Material Icon Theme.
//
// Scope is deliberate: folders and Markdown. loomark's panel is a Markdown file
// list, so those two are what a reader actually scans for; every other type falls
// back to the plain file icon, which keeps this module to two icons instead of the
// 1251 the upstream theme ships.
//
// Upstream: https://github.com/material-extensions/vscode-material-icon-theme
// MIT licensed, Copyright (c) 2025 Material Extensions. Full licence text in
// resources/licenses/material-icon-theme.txt.
//
// These carry their own fill, so nothing in base.css may force `fill: none` or a
// stroke on them, which would hollow them out. The colour is fixed rather than
// themed, the way VS Code keeps its file icons fixed.

const FOLDER_ICON = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232" fill="#4a9eff" /></svg>`

const MARKDOWN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#42a5f5" d="m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z"/></svg>`

const PLAIN_FILE_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'

/// Extensions that have a Markdown icon. `.mdx` rides along: it is Markdown with a
/// component layer, and the panel is where that is worth seeing at a glance.
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

/// The icon for a file name: the Markdown mark for Markdown, the plain outline for
/// everything else. A dotfile with no extension is content, not Markdown, so it
/// takes the outline too.
///
/// `plain` is the caller's cue that this icon is an outlined shape in the panel's
/// own ink; the coloured two draw themselves and must not be restyled.
export function fileIconFor(name: string): { svg: string; plain: boolean } {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    if (MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) {
      return { svg: MARKDOWN_ICON, plain: false }
    }
  }
  return { svg: PLAIN_FILE_ICON, plain: true }
}

/// The folder icon: one shape for every folder, so the column does not shuffle.
export function folderIcon(): string {
  return FOLDER_ICON
}
