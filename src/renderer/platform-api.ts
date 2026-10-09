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
export type FileOpenedData = { path: string | null; content: string; fileUrl: string | null }
export type ImageExportPreset = 'desktop' | 'mobile'
export type ImageExportSnapshot = { html: string; styles: string; bodyClass: string; background: string }
export type FileManagerName = 'finder' | 'explorer' | 'file-manager'

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
  activateFile: (path: string | null) => Promise<{ content: string; fileUrl: string; mtime: number } | null>
  setTabFiles: (paths: string[]) => void
  fileUrl: (path: string) => Promise<string | null>
  onFocusFile: (callback: (path: string) => void) => void
  onOpenInNewTab: (callback: (path: string) => void) => void
  /** A local Markdown link: open it in a tab and land on the fragment or line. */
  openMarkdownLink: (path: string, fragment: string, line?: number) => Promise<boolean>
  onOpenMarkdownLink: (callback: (request: { path: string; fragment?: string; line?: number }) => void) => void
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => Promise<string | null>
  saveFileAs: (content: string, expectedPath?: string) => Promise<string | null>
  exportPDF: () => Promise<boolean>
  exportHTML: (snapshot: { content: string; document: string; html: string; styles: string; bodyClass: string }) => Promise<boolean>
  exportDOCX: (payload: { content: string; images: Record<string, string> }) => Promise<boolean>
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => Promise<boolean>
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
