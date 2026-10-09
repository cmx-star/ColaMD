// The Tauri side of `window.electronAPI`.
//
// The renderer was written against one object: `ElectronAPI`, declared in
// src/preload/index.ts and handed to the page by the preload script. This file
// builds the same shape on top of Tauri, so every other renderer file stays as it
// is (docs/tauri-migration-plan.md, decision D1). main.ts installs it only when
// `window.electronAPI` is absent, which is exactly the case under Tauri: the
// Electron build keeps working through the preload bridge, unchanged.
//
// P1 scope: the shell boots and paints. Language, the file manager's name, the
// clipboard and external links are real; everything that touches a document is a
// logged stub, and P2 replaces them with Rust commands (file IO, the watcher,
// atomic saves) and P3 finishes the window, tab and theme surface. The stubs
// return the same shapes the renderer already handles for "nothing happened", so
// the UI can be compared against the Electron build without pretending an edit
// would be saved.

import type {
  ElectronAPI,
  FileOpenedData,
  FileManagerName,
  ImageExportPreset,
  ImageExportSnapshot,
  SiblingFile
} from '../preload/index'

/** Names already reported, so one stub does not fill the console. */
const reported = new Set<string>()

function notYet(name: string): void {
  if (reported.has(name)) return
  reported.add(name)
  console.info(`[tauri-api] not implemented yet (P2/P3/P4): ${name}`)
}

/** An event subscription that has no sender yet. */
function unwiredEvent(name: string): void {
  notYet(name)
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

export function createTauriApi(): ElectronAPI {
  const api: ElectronAPI = {
    // --- Opening and reading documents (P2) -------------------------------
    openFile: async () => {
      notYet('openFile')
      return null
    },
    openFilePath: async () => {
      notYet('openFilePath')
      return null
    },
    openSibling: async () => {
      notYet('openSibling')
      return false
    },
    activateFile: async () => {
      notYet('activateFile')
      return null
    },
    listSiblings: async () => {
      notYet('listSiblings')
      return null
    },
    listDirectory: async () => {
      notYet('listDirectory')
      return null
    },
    fileUrl: async () => {
      notYet('fileUrl')
      return null
    },
    setTabFiles: () => {
      notYet('setTabFiles')
    },

    // --- Writing documents (P2) ------------------------------------------
    saveFile: async () => {
      notYet('saveFile')
      return null
    },
    saveFileAs: async () => {
      notYet('saveFileAs')
      return null
    },
    reportDirty: () => {
      notYet('reportDirty')
    },
    reportExternalConflict: async (content: string) => {
      void content
      notYet('reportExternalConflict')
    },

    // --- Shell chrome and system integration (P3/P4) ----------------------
    getFileManagerName: async () => detectFileManager(),
    revealFile: async () => {
      notYet('revealFile')
      return false
    },
    revealPath: async (target: string) => {
      void target
      notYet('revealPath')
      return false
    },
    showEntryContextMenu: async () => {
      notYet('showEntryContextMenu')
    },
    showTabContextMenu: async () => {
      notYet('showTabContextMenu')
    },
    popupAppMenu: async () => {
      notYet('popupAppMenu')
    },
    closeWindow: async () => {
      notYet('closeWindow')
    },
    setSlideshowFullscreen: async () => {
      notYet('setSlideshowFullscreen')
      return false
    },
    reportTitlebarColors: async () => {
      notYet('reportTitlebarColors')
    },
    reportRendererReady: () => {
      notYet('reportRendererReady')
    },
    logRendererError: async (message: string) => {
      console.error(`[renderer] ${message}`)
    },
    getPathForFile: () => {
      notYet('getPathForFile')
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

    // --- Language and theme (P3 for custom themes) ------------------------
    getLanguage: async () => detectLanguage(),
    loadCustomTheme: async () => {
      notYet('loadCustomTheme')
      return null
    },
    loadThemeCSS: async () => {
      notYet('loadThemeCSS')
      return null
    },
    reportTheme: async () => {
      notYet('reportTheme')
    },
    setEditorFont: async () => {
      notYet('setEditorFont')
    },
    listSystemFonts: async () => {
      notYet('listSystemFonts')
      return []
    },

    // --- Export (P5) ------------------------------------------------------
    exportPDF: async () => {
      notYet('exportPDF')
      return false
    },
    exportHTML: async (snapshot: { content: string; document: string; html: string; styles: string; bodyClass: string }) => {
      void snapshot
      notYet('exportHTML')
      return false
    },
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

    // --- Update flow (P4) -------------------------------------------------
    downloadUpdate: async () => {
      notYet('downloadUpdate')
    },
    installUpdate: async () => {
      notYet('installUpdate')
    },

    // --- Save/close handshake with the shell (P2) -------------------------
    respondDocumentState: (requestId: string) => {
      void requestId
      notYet('respondDocumentState')
    },

    // --- Events from the shell and the menu (P2 through P4) ---------------
    onTabMenuAction: () => unwiredEvent('onTabMenuAction'),
    onFocusFile: () => unwiredEvent('onFocusFile'),
    onOpenInNewTab: () => unwiredEvent('onOpenInNewTab'),
    onFileChanged: () => unwiredEvent('onFileChanged'),
    onNewFile: () => unwiredEvent('onNewFile'),
    onFileOpened: (callback: (data: FileOpenedData) => void) => {
      void callback
      unwiredEvent('onFileOpened')
    },
    onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => {
      void callback
      unwiredEvent('onSiblingsChanged')
    },
    onLanguageChanged: () => unwiredEvent('onLanguageChanged'),
    onFullscreenChange: () => unwiredEvent('onFullscreenChange'),
    onExternalConflictResult: () => unwiredEvent('onExternalConflictResult'),
    onUpdateAvailable: () => unwiredEvent('onUpdateAvailable'),
    onUpdateDownloaded: () => unwiredEvent('onUpdateDownloaded'),
    onUpdateProgress: () => unwiredEvent('onUpdateProgress'),
    onUpdateError: () => unwiredEvent('onUpdateError'),
    onRequestDocumentState: () => unwiredEvent('onRequestDocumentState'),
    onMenuOpen: () => unwiredEvent('onMenuOpen'),
    onMenuSave: () => unwiredEvent('onMenuSave'),
    onMenuSaveAs: () => unwiredEvent('onMenuSaveAs'),
    onMenuNewTab: () => unwiredEvent('onMenuNewTab'),
    onMenuCloseTab: () => unwiredEvent('onMenuCloseTab'),
    onMenuExportPDF: () => unwiredEvent('onMenuExportPDF'),
    onMenuExportHTML: () => unwiredEvent('onMenuExportHTML'),
    onMenuExportDOCX: () => unwiredEvent('onMenuExportDOCX'),
    onMenuExportImage: () => unwiredEvent('onMenuExportImage'),
    onMenuPlaySlideshow: () => unwiredEvent('onMenuPlaySlideshow'),
    onMenuImportTheme: () => unwiredEvent('onMenuImportTheme'),
    onSetTheme: () => unwiredEvent('onSetTheme'),
    onSetCustomCSS: () => unwiredEvent('onSetCustomCSS'),
    onSetPanelSide: () => unwiredEvent('onSetPanelSide'),
    reportPanelSide: async () => {
      notYet('reportPanelSide')
    },
    onSetPageWidth: () => unwiredEvent('onSetPageWidth'),
    reportPageWidth: async () => {
      notYet('reportPageWidth')
    },
    onSearch: () => unwiredEvent('onSearch'),
    onFormatCommand: () => unwiredEvent('onFormatCommand'),
    onToggleFilePanel: () => unwiredEvent('onToggleFilePanel'),
    onToggleSourceMode: () => unwiredEvent('onToggleSourceMode'),
    onEditorFontChanged: () => unwiredEvent('onEditorFontChanged'),
    onOpenFontSettings: () => unwiredEvent('onOpenFontSettings')
  }

  return api
}
