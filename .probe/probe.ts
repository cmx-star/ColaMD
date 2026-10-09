import { createEditor, setMarkdown } from '../src/renderer/editor/editor'
import { applyTheme } from '../src/renderer/themes/theme-manager'
import '../src/renderer/themes/base.css'
import '../src/renderer/themes/premium.css'

const DOC = [
  '前面一段文字。',
  '',
  '| 列甲 | 列乙 |',
  '| --- | --- |',
  '| 甲一 | 乙一 |',
  '| 甲二 | 乙二 |',
  '',
  '后面一段文字。',
  '',
].join('\n')

createEditor(document.getElementById('editor') as HTMLElement)
setMarkdown(DOC)
applyTheme('light')
;(window as any).__probeReady = true
