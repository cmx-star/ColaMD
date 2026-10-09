declare module 'katex/dist/katex.min.css?inline' {
  const css: string
  export default css
}

interface Window {
  loomark: import('./platform-api').LoomarkApi
  /** 主进程在 printToPDF 前后叫它，把光标与当前行的源码从纸上拿掉。 */
  __loomarkPrintExport?: { enter: () => void; exit: () => void }
  __loomarkExportDocumentHTML?: () => string
}
