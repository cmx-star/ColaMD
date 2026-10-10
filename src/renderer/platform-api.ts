// The contract between the renderer and the shell it runs in.
//
// It used to live in src/preload/index.ts, because the Electron build handed the page
// an object through contextBridge. The renderer still talks to one object with this
// shape; only the name changed when the Electron half was removed (2026-10-09), so a
// reader is not told the app runs on Electron when it does not.

export interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

// These shape the payloads on the shell API, so they belong to the contract rather
// than to the adapter that happens to implement it.
export type FileOpenedData = { path: string | null; content: string }
export type ImageExportPreset = 'desktop' | 'mobile'
export type FileManagerName = 'finder' | 'explorer' | 'file-manager'

/**
 * 交给外壳落盘的产物。
 *
 * base64 而不是原始字节：外壳用 Tauri 的 raw payload 通道时整个请求体就是字节，命令
 * 只能有一个参数，建议文件名就没地方放。导出是低频操作，33% 的膨胀无关紧要。
 */
export interface ExportedFile {
  /** 建议的基础文件名，不带扩展名。 */
  baseName: string
  /** base64 编码的产物字节。 */
  base64: string
}

/**
 * 多张图片一次导出。超长文档一张长图放不下时按阅读页切开，这时是多个文件，
 * 文件名依次加 `-1`、`-2` 后缀（沿用 Electron 版的编号方式）。
 */
export interface ExportedImages {
  baseName: string
  files: string[]
}

export interface LoomarkApi {
  openFile: () => Promise<{ path: string; content: string } | null>
  openFilePath: (path: string) => Promise<{ path: string; content: string } | null>
  getFileManagerName: () => Promise<FileManagerName>
  revealFile: () => Promise<boolean>
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => Promise<void>
  showTabContextMenu: (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => Promise<void>
  onTabMenuAction: (callback: (payload: { action: string; tabId: string }) => void) => void
  listSiblings: () => Promise<SiblingFile[] | null>
  listDirectory: (path: string) => Promise<SiblingFile[] | null>
  openSibling: (path: string) => Promise<boolean>
  activateFile: (path: string | null) => Promise<{ content: string; mtime: number } | null>
  setTabFiles: (paths: string[]) => void
  /**
   * 绝对路径 → WebView 能加载的地址（Tauri 的 asset 协议）。
   *
   * 同步的：图片装饰在画的那一刻就要拿到地址。网页版不碰本地文件，没有这个能力，
   * 所以是可选的——拿不到时图片按文件里写的那串字符原样渲染。
   */
  assetUrl?: (path: string) => string
  onFocusFile: (callback: (path: string) => void) => void
  onOpenInNewTab: (callback: (path: string) => void) => void
  /** A local Markdown link: open it in a tab and land on the fragment or line. */
  resolveWikiLink?: (target: string, dir?: string) => Promise<string | null>
  openMarkdownLink: (path: string, fragment: string, line?: number) => Promise<boolean>
  onOpenMarkdownLink: (callback: (request: { path: string; fragment?: string; line?: number }) => void) => void
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => Promise<string | null>
  saveFileAs: (content: string, expectedPath?: string) => Promise<string | null>
  // 三条导出都是同一个形状：渲染侧把文档画成字节，外壳弹保存框再写盘。
  //
  // 分工的边界在「谁懂排版、谁有文件系统」：文档的排版知识在渲染侧（主题、公式、
  // 图表都在那儿），系统对话框与写文件归外壳。PDF 与图片交位图，Word 交 Markdown
  // 解析出来的 .docx —— 三种都是「字节」，所以共用一种载荷。
  exportPDF: (file: ExportedFile) => Promise<boolean>
  exportHTML: (snapshot: { content: string; document: string; html: string; styles: string; bodyClass: string }) => Promise<boolean>
  exportDOCX: (file: ExportedFile) => Promise<boolean>
  exportImage: (images: ExportedImages, preset: ImageExportPreset) => Promise<boolean>
  /**
   * 渲染侧的导出失败要让人看见。
   *
   * 排版、字体、画布都发生在渲染侧；那里出错时外壳只会看到命令没被调用，用户看到的
   * 是「点了没反应」。所以渲染侧捕获后叫这个名字，由外壳弹一次框。
   */
  reportExportFailure: (title: string, detail: string) => Promise<void>
  getLanguage: () => Promise<'zh' | 'en'>
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => void
  loadCustomTheme: () => Promise<{ name: string; css: string } | null>
  loadThemeCSS: (fileName: string) => Promise<string | null>
  reportTheme: (theme: string) => Promise<void>
  reportTitlebarColors: (colors: { background: string; symbol: string }) => Promise<void>
  popupAppMenu: () => Promise<void>
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => void
  getPathForFile: (file: File) => string
  openExternal: (url: string) => void
  onFileChanged: (callback: (content: string) => void) => void
  onNewFile: (callback: () => void) => void
  onFileOpened: (callback: (data: FileOpenedData) => void) => void
  onMenuOpen: (callback: () => void) => void
  onMenuSave: (callback: () => void) => void
  onMenuSaveAs: (callback: () => void) => void
  onMenuNewTab: (callback: () => void) => void
  onMenuCloseTab: (callback: () => void) => void
  onMenuExportPDF: (callback: () => void) => void
  onMenuExportHTML: (callback: () => void) => void
  onMenuExportDOCX: (callback: () => void) => void
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => void
  onMenuPlaySlideshow: (callback: () => void) => void
  setSlideshowFullscreen: (on: boolean) => Promise<boolean>
  onSetTheme: (callback: (theme: string) => void) => void
  onSetPanelSide: (callback: (side: string) => void) => void
  reportPanelSide: (side: string) => Promise<void>
  onSetPageWidth: (callback: (width: string) => void) => void
  reportPageWidth: (width: string) => Promise<void>
  onSetCustomCSS: (callback: (css: string) => void) => void
  onMenuImportTheme: (callback: () => void) => void
  onSearch: (callback: () => void) => void
  onFormatCommand: (callback: (id: string) => void) => void
  /** ⌘+ / ⌘- / ⌘0: 1, -1, or 0 for "back to the theme's default size". */
  onStepFont: (callback: (delta: number) => void) => void
  readClipboardText: () => Promise<string>
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => void
  onToggleFilePanel: (callback: () => void) => void
  onToggleSourceMode: (callback: () => void) => void
  setEditorFont: (prefs: { family: string; size: number }) => Promise<void>
  listSystemFonts: () => Promise<string[]>
  onEditorFontChanged: (callback: (prefs: { family: string; size: number }) => void) => void
  onOpenFontSettings: (callback: () => void) => void
  reportExternalConflict: (content: string) => Promise<void>
  onExternalConflictResult: (callback: (result: { action: 'keep' | 'load'; content?: string; recoveryPath?: string }) => void) => void
  revealPath: (target: string) => Promise<boolean>
  onUpdateAvailable: (callback: (version: string) => void) => void
  onUpdateDownloaded: (callback: (version: string) => void) => void
  onUpdateProgress: (callback: (percent: number) => void) => void
  onUpdateError: (callback: () => void) => void
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  /** Ask the shell to check GitHub; resolves with update info or null when
   *  this build is current. Rejects on network failure. */
  checkForUpdates: () => Promise<{ version: string; url: string; path: string; downloaded: boolean } | null>
  /** Menu → 帮助 → 检查更新: the shell relays the click; the renderer drives
   *  the same flow the update banner uses. */
  onMenuCheckUpdates: (callback: () => void) => void
  reportDirty: (isDirty: boolean) => void
  /** Verification channel: run the named check in the page and report the result.
   *  It exists because the acceptance scripts used to drive the app over the Chrome
   *  DevTools protocol, which no system WebView offers.
   *
   *  `params` is the check's own startup data, JSON-encoded by the shell; a check
   *  that needs nothing gets null. The theme check uses it to receive the
   *  `themes/*.css` sources, which a page cannot read off the disk itself. */
  onVerifyRun: (callback: (name: string, params: string | null) => void) => void
  verifyReport: (payload: string) => Promise<void>
  /** A real confirmation for discarding unsaved content. `window.confirm` is not
   *  available in every shell, and the shell that lacks it answers "yes". */
  confirmDiscardTab: (message: string) => Promise<boolean>
  reportRendererReady: () => void
  closeWindow: () => Promise<void>
  logRendererError: (message: string) => Promise<void>
  onRequestDocumentState: (callback: (requestId: string) => void) => void
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => void
}
