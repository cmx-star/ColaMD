// 编辑器状态层：文本优先核心中不依赖 DOM 的那一半。
//
// 为什么要把这一半单独拿出来：验收脚本（scripts/verify-markdown.mjs）要在纯 Node 里
// 证明「打开一份文件、不做修改、保存，字节不变」。要证的是**字节**，而字节的真相在
// EditorState 里，不在 EditorView 里——view 管的是排版、光标、滚动，全都要真实布局
// 测量，在 Node 里既造不出来、也与保真无关。
//
// 所以状态层的边界是：**能进 harness 的都必须无 DOM**。
// 装饰层（live-preview）不在这里，它是画的事；它只画不写，装不装都不影响字节。

import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { GFM, InlineContext, type MarkdownParser } from '@lezer/markdown'
import { languages } from '@codemirror/language-data'
import { indentOnInput, bracketMatching, syntaxHighlighting, Language } from '@codemirror/language'
import { keymap } from '@codemirror/view'
import { markdownHighlightStyle } from './source-theme'
import { frontmatterRange } from './math-scan'
import { renumberLists } from './list-renumber'

/** 可编辑性放在一个 compartment 里，方便运行时切换而不重建编辑器。 */
export const editableCompartment = new Compartment()

/**
 * 基准语法：CommonMark 加 GFM，就这些。
 *
 * 为什么不用 `@codemirror/lang-markdown` 直接给的 `markdownLanguage`：它比 GFM 还多
 * 带三个扩展（Subscript、Superscript、Emoji），而这三个节点这个软件一个都不渲染，
 * 多出来的只有副作用。Emoji 最典型：它把「冒号 + 数字 + 冒号」也当短代码，于是时间
 * 轴里的 `00:00:17` 中间那段被语法着色当成字符字面量，而 character 是 string 的子
 * 标签，正好命中代码块里那条 string 着色规则，于是时间戳中间绿了一段。
 *
 * 保留 GFM，因为表格、删除线、任务列表、裸链接都是要渲染的。
 */
const markdownParser: MarkdownParser = (commonmarkLanguage.parser as MarkdownParser).configure([
  GFM,
  {
    defineNodes: [{ name: 'WikiLink' }, { name: 'WikiLinkMark' }],
    parseInline: [
      {
        name: 'WikiLink',
        parse(cx: InlineContext, next: number, pos: number): number {
          // `[[` 开头才可能是双链；单个 `[` 交给现有的 Link 解析器。
          if (next !== 91 /* '[' */ || cx.char(pos + 1) !== 91) return -1
          // 从 pos 起找闭合的 `]]`，中途换行或到段尾就放弃。
          let end = -1
          for (let i = pos + 2; i < cx.end; i++) {
            const c = cx.char(i)
            if (c === 10 /* '\n' */) return -1
            if (c === 93 /* ']' */ && cx.char(i + 1) === 93) {
              end = i + 2
              break
            }
          }
          if (end < 0) return -1
          // `[[ ]]`、`[[#标题]]`（目标为空）都不是双链。
          const inner = cx.slice(pos + 2, end - 2).trim()
          if (!inner || inner.startsWith('#')) return -1
          const hash = inner.indexOf('#')
          const target = hash < 0 ? inner : inner.slice(0, hash).trim()
          if (!target) return -1
          const targetFrom = pos + 2
          const targetTo = hash < 0 ? end - 2 : targetFrom + target.length
          // 节点结构：WikiLink( WikiLinkMark "[" "[" , URL 目标, WikiLinkMark "]" "]" )。
          // URL 子节点让 live-preview 里的 data-href 提取和现有的 Link 走同一套认法。
          return cx.addElement(
            cx.elt('WikiLink', pos, end, [
              cx.elt('WikiLinkMark', pos, pos + 2),
              cx.elt('URL', targetFrom, targetTo),
              cx.elt('WikiLinkMark', end - 2, end),
            ]),
          )
        },
      },
    ],
  },
])

const markdownBase = new Language(
  commonmarkLanguage.data,
  // `Language` 只把 parser 当 CodeMirror 自己的 Parser 接口看，不带 configure；
  // 实际对象是 @lezer/markdown 的 MarkdownParser，上一层扩展要在这里换掉。
  markdownParser,
  [],
  'markdown'
)

/** 这份 parser 也拿给 list-renumber 用：它要单独解析改动所在的那一段。 */
export { markdownParser }

/**
 * 状态层的扩展集合：语言解析、语法高亮、撤销栈、缩进、快捷键。
 *
 * 这里的解析「只用于决定怎么画」，不参与决定写什么——文件写回去的是缓冲区里的原始
 * 字节，跟解析结果无关。这就是为什么解析器可以随便换、解析错了也不会伤到文件。
 */
export function stateExtensions(): Extension {
  return [
    history(),
    indentOnInput(),
    bracketMatching(),
    // 不挂 highlightSelectionMatches()（#144）：选中一个字，全文同字都被框，
    // 看着像渲染故障。查找替换的高亮是 search 扩展自己的，不在这里。
    // 增删有序列表项时把序号排一遍（见 list-renumber.ts）。它是**写文件**的一层，
    // 所以只认用户自己的编辑，打开文件、外部写入、导出都不碰。
    renumberLists,
    // markdown 语言支持 + 语法高亮（颜色走 CSS 变量，深浅主题自动跟随）
    markdown({ base: markdownBase, codeLanguages: languages, addKeymap: false }),
    syntaxHighlighting(markdownHighlightStyle),
    // 这里**不装** `searchKeymap`：它会绑 Cmd+F 打开 CodeMirror 自带的那块检索面板，
    // 那块面板只有英文、也不跟主题走，和我们自己的检索面板（有中英文、按主题上色）撞在
    // 一起。查找是应用级功能，入口在菜单的「查找」上（Cmd+F 由菜单的快捷键发
    // `editor:search`），面板在 editor/search-panel.ts。
    // `defaultKeymap` 里有两条和本应用的快捷键冲突，先摘掉：
    //   Mod-i → selectParentSyntax（选中父级语法节点），吞掉「斜体」
    //   Mod-/ → toggleComment（插入 HTML 注释），吞掉「切换 Markdown 源码」
    // 两个键的应用级入口都在菜单里，菜单没接住时由渲染层兜底（main.ts 里的
    // appShortcutFallback）。同一个键不能有两个主人，否则「切两次等于没切」。
    keymap.of([
      ...defaultKeymap.filter((binding) => binding.key !== 'Mod-i' && binding.key !== 'Mod-/'),
      ...historyKeymap,
      indentWithTab,
    ]),
  ]
}

/** 用一份文本建一个编辑器状态。换文件（flush）时用它，撤销栈随之清空。 */
export function createState(doc: string): EditorState {
  return EditorState.create({ doc, selection: { anchor: bodyStart(doc) }, extensions: stateExtensions() })
}

/**
 * 打开一份文件时光标应该落在哪。
 *
 * 属性区是收起来的（见 live-preview 的 collectFrontmatter）。光标停在收起来的那几行里，
 * 敲下去的字会落进看不见的地方，所以有属性区时把光标放到它后面第一行。
 * 反过来说，光标任何时候被移到里面去，那一块就会露出来。
 */
export function bodyStart(doc: string): number {
  const front = frontmatterRange(doc)
  if (!front) return 0
  const lineBreak = doc.indexOf('\n', front.to)
  return lineBreak === -1 ? doc.length : lineBreak + 1
}
