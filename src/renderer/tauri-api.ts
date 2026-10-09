// The Tauri side of `window.loomark`.
//
// The renderer talks to one object, whose shape is declared in platform-api.ts. This
// file builds that object on top of the Tauri commands, so the editor, the panels and
// the exports stay as they were.

import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import type {
  LoomarkApi,
  FileOpenedData,
  FileManagerName,
  ImageExportPreset,
  ImageExportSnapshot,
  SiblingFile
} from './platform-api'

/** Names already reported, so one stub does not fill the console. */
const reported = new Set<string>()

function notYet(name: string): void {
  if (reported.has(name)) return
  reported.add(name)
  console.info(`[tauri-api] not implemented yet (P3/P4/P5): ${name}`)
}

/** Subscribe to a shell event. The renderer's API is synchronous, so the promise is
 *  settled in the background and a failure is reported once. */
function on<T>(event: string, callback: (payload: T) => void): void {
  void listen<T>(event, (message) => callback(message.payload)).catch((error) => {
    // A window that cannot subscribe is deaf to every menu command, which looks
    // exactly like the feature not existing. Say so loudly.
    if (reported.has(event)) return
    reported.add(event)
    console.error(`[tauri-api] could not subscribe to ${event}:`, error)
  })
}

function isMac(): boolean {
  return /^Mac/i.test(navigator.platform)
}

function isWindows(): boolean {
  return /Windows/i.test(navigator.userAgent)
}

function detectLanguage(): 'zh' | 'en' {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function detectFileManager(): FileManagerName {
  if (isMac()) return 'finder'
  return isWindows() ? 'explorer' : 'file-manager'
}

/** Local files reach the webview through Tauri's asset protocol, which is what
 *  `file://` did in the Electron build (relative images in a document). */
function documentUrl(path: string | null): string | null {
  return path ? convertFileSrc(path) : null
}

export function createTauriApi(): LoomarkApi {
  const api: LoomarkApi = {
    // --- Opening and reading documents ------------------------------------
    openFile: async () => {
      const opened = await invoke<{ path: string | null; content: string } | null>('open_file')
      return opened?.path ? { path: opened.path, content: opened.content } : null
    },
    openFilePath: async (path: string) => {
      const opened = await invoke<{ path: string | null; content: string } | null>('open_file_path', { filePath: path })
      return opened?.path ? { path: opened.path, content: opened.content } : null
    },
    openSibling: async (path: string) => invoke<boolean>('open_sibling', { filePath: path }),
    activateFile: async (path: string | null) => {
      const active = await invoke<{ content: string; mtime: number } | null>('activate_file', { filePath: path })
      if (!active) return null
      return { content: active.content, fileUrl: documentUrl(path) ?? '', mtime: active.mtime }
    },
    listSiblings: async () => invoke<SiblingFile[] | null>('list_siblings'),
    listDirectory: async (path: string) => invoke<SiblingFile[] | null>('list_directory', { dirPath: path }),
    fileUrl: async (path: string) => documentUrl(path),
    setTabFiles: (paths: string[]) => {
      void invoke('set_tab_files', { paths }).catch(() => undefined)
    },

    // --- Writing documents ------------------------------------------------
    saveFile: async (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) =>
      invoke<string | null>('save_file', { content, expectedPath, rebuildMenu, autosave }),
    saveFileAs: async (content: string, expectedPath?: string) =>
      invoke<string | null>('save_file_as', { content, expectedPath }),
    confirmDiscardTab: async (message: string) => invoke<boolean>('confirm_discard_tab', { message }),
    onVerifyRun: (callback: (source: string) => void) => on<string>('verify-run', callback),
    verifyReport: async (payload: string) => {
      await invoke('verify_report', { payload })
    },
    reportDirty: (isDirty: boolean) => {
      void invoke('report_dirty', { isDirty }).catch(() => undefined)
    },
    reportExternalConflict: async (content: string) => {
      await invoke('report_external_conflict', { localContent: content })
    },

    // --- Shell chrome and system integration ------------------------------
    getFileManagerName: async () => detectFileManager(),
    revealFile: async () => invoke<boolean>('reveal_file'),
    revealPath: async (target: string) => invoke<boolean>('reveal_path', { target }),
    showEntryContextMenu: async (path: string, kind: 'file' | 'directory') => {
      await invoke('show_entry_context_menu', { path, kind })
    },
    showTabContextMenu: async (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => {
      await invoke('show_tab_context_menu', { payload })
    },
    popupAppMenu: async () => {
      await invoke('popup_app_menu')
    },
    closeWindow: async () => {
      await invoke('request_close_window')
    },
    setSlideshowFullscreen: async (on: boolean) => invoke<boolean>('set_slideshow_fullscreen', { on }),
    reportTitlebarColors: async (colors: { background: string; symbol: string }) => {
      await invoke('report_titlebar_colors', { colors })
    },
    reportRendererReady: () => {
      void invoke('renderer_ready').catch(() => undefined)
    },
    logRendererError: async (message: string) => {
      await invoke('log_renderer_error', { message }).catch(() => undefined)
    },
    getPathForFile: () => {
      // The webview has no path for a File object; dropped files arrive through the
      // drag-drop event wired at the bottom of this file instead.
      return ''
    },
    openExternal: (url: string) => {
      window.open(url, '_blank', 'noopener')
    },
    readClipboardText: async () => {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return ''
      }
    },

    // --- Language and theme -------------------------------------------------
    getLanguage: async () => detectLanguage(),
    loadCustomTheme: async () =>
      invoke<{ name: string; css: string } | null>('load_custom_theme'),
    loadThemeCSS: async (fileName: string) => invoke<string | null>('load_theme_css', { fileName }),
    reportTheme: async (theme: string) => {
      await invoke('report_theme', { theme })
    },
    setEditorFont: async (prefs: { family: string; size: number }) => {
      await invoke('set_editor_font', { prefs })
    },
    listSystemFonts: async () => invoke<string[]>('list_system_fonts'),

    // --- Export ------------------------------------------------------------
    exportPDF: async () => {
      notYet('exportPDF')
      return false
    },
    exportHTML: async (snapshot: { content: string; document: string; html: string; styles: string; bodyClass: string }) =>
      invoke<boolean>('export_html', { snapshot }),
    exportDOCX: async (payload: { content: string; images: Record<string, string> }) => {
      void payload
      notYet('exportDOCX')
      return false
    },
    exportImage: async (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => {
      void snapshot
      void preset
      notYet('exportImage')
      return false
    },

    // --- Update flow --------------------------------------------------------
    downloadUpdate: async () => {
      notYet('downloadUpdate')
    },
    installUpdate: async () => {
      notYet('installUpdate')
    },

    // --- Save/close handshake ----------------------------------------------
    respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => {
      void invoke('document_state_response', { requestId, snapshot }).catch(() => undefined)
    },

    // --- Events from the shell ---------------------------------------------
    onFileOpened: (callback: (data: FileOpenedData) => void) => {
      on<{ path: string | null; content: string }>('file-opened', (payload) => {
        callback({ path: payload.path, content: payload.content, fileUrl: documentUrl(payload.path) })
      })
    },
    onFileChanged: (callback: (content: string) => void) => on<string>('file-changed', callback),
    onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => on<SiblingFile[]>('siblings-changed', callback),
    onOpenInNewTab: (callback: (path: string) => void) => on<string>('open-in-new-tab', callback),
    onFocusFile: (callback: (path: string) => void) => on<string>('focus-file', callback),
    onExternalConflictResult: (callback) => on('external-conflict-result', callback),
    onRequestDocumentState: (callback: (requestId: string) => void) => on<string>('request-document-state', callback),
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) => on<boolean>('fullscreen-changed', callback),

    // --- Menu, theme and view events ---------------------------------------
    onTabMenuAction: (callback) => on('tab-menu-action', callback),
    onNewFile: (callback) => on<void>('new-file', () => callback()),
    onLanguageChanged: (callback) => on<'zh' | 'en'>('language-changed', callback),
    onMenuOpen: (callback) => on<void>('menu-open', () => callback()),
    onMenuSave: (callback) => on<void>('menu-save', () => callback()),
    onMenuSaveAs: (callback) => on<void>('menu-save-as', () => callback()),
    onMenuNewTab: (callback) => on<void>('menu-new-tab', () => callback()),
    onMenuCloseTab: (callback) => on<void>('menu-close-tab', () => callback()),
    onMenuExportPDF: (callback) => on<void>('menu-export-pdf', () => callback()),
    onMenuExportHTML: (callback) => on<void>('menu-export-html', () => callback()),
    onMenuExportDOCX: (callback) => on<void>('menu-export-docx', () => callback()),
    onMenuExportImage: (callback) => on<ImageExportPreset>('menu-export-image', callback),
    onMenuPlaySlideshow: (callback) => on<void>('menu-play-slideshow', () => callback()),
    onMenuImportTheme: (callback) => on<void>('menu-import-theme', () => callback()),
    onUpdateAvailable: () => notYet('onUpdateAvailable'),
    onUpdateDownloaded: () => notYet('onUpdateDownloaded'),
    onUpdateProgress: () => notYet('onUpdateProgress'),
    onUpdateError: () => notYet('onUpdateError'),
    onSetTheme: (callback) => on<string>('set-theme', callback),
    onSetCustomCSS: (callback) => on<string>('set-custom-css', callback),
    onSetPanelSide: (callback) => on<string>('set-panel-side', callback),
    reportPanelSide: async (side: string) => {
      await invoke('report_panel_side', { side })
    },
    onSetPageWidth: (callback) => on<string>('set-page-width', callback),
    reportPageWidth: async (width: string) => {
      await invoke('report_page_width', { width })
    },
    onSearch: (callback) => on<void>('editor:search', () => callback()),
    onFormatCommand: (callback) => on<string>('editor:format', callback),
    onToggleFilePanel: (callback) => on<void>('toggle-file-panel', () => callback()),
    onToggleSourceMode: (callback) => on<void>('toggle-source-mode', () => callback()),
    onEditorFontChanged: (callback) => on<{ family: string; size: number }>('editor-font-changed', callback),
    onOpenFontSettings: (callback) => on<void>('open-font-settings', () => callback())
  }

  // A file dropped on the window opens like any other document. The webview has no
  // path for a File object, so this comes from Tauri's own drag-drop event.
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return
      for (const path of event.payload.paths) {
        void invoke('open_file_path', { filePath: path }).catch(() => undefined)
      }
    })
    .catch(() => undefined)

  return api
}
