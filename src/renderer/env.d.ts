declare module 'katex/dist/katex.min.css?inline' {
  const css: string
  export default css
}

interface Window {
  loomark: import('./platform-api').LoomarkApi
  /** 主进程在 printToPDF 前后叫它，把光标与当前行的源码从纸上拿掉。 */
  __loomarkPrintExport?: { enter: () => void; exit: () => void }
  __loomarkExportDocumentHTML?: () => string
  /**
   * 待验收的主题文件（`themes/*.css` 的原文，键是文件名）。页面读不到磁盘，也没有
   * 能下文件的协议，所以由壳在 COLAMD_VERIFY=themes 时从启动参数里的 `themesDir`
   * 读进来。见 src/renderer/main.ts 与 src/renderer/verify/checks.ts。
   */
  __loomarkVerifyThemes?: Record<string, string>
}
