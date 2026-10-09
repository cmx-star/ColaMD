// 有序列表的序号：跟着编辑走，写回文件。
//
// markdown 里只有列表**第一项**的数字有用（CommonMark 拿它当 `<ol start>`），后面的数字
// 谁渲染谁重排。但**文件里的数就是屏幕上的数**：只改渲染的话，屏幕上 1、2、3，复制出去
// 还是 1、3、4，在 Obsidian 里打开也是 1、3、4，这就把「文件是唯一真相」卖掉了
// （2026-10-06 定的）。所以增删列表项时，把序号按顺序写回去，序号和正文一起进撤销栈。
//
// 什么时候动手，两条：
//   · 列表项的数量变了：删掉一项、回车加一项、Tab 改层级、粘贴一整段
//   · 改动碰到了序号本身：改起始编号
//
// 只改文字不动序号。有人在列表里敲字，不该把 `1. 1. 1.` 那种写法（为了 diff 干净）
// 抹平成 1、2、3，Typora 这么干还被人专门开 issue 骂过（typora-issues#1188）。
// 打开文件、外部写入、导出这些程序化改动一概不碰，「用户没碰过的字节不许变」照旧。
//
// 为什么要自己解析一遍：State 的语法树是按视口惰性推进的，刚改完那一块不保证已经解析
// （装饰层的 parseRefresh 就是为这个存在）。这里只切出改动所在的一段来解析，
// 段小、便宜，也不用猜整篇的状态。

import { ChangeSet, EditorState, Transaction, type Text } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'
import { markdownParser } from './state'

/** 列表项那一行：缩进 + `-`/`*`/`+` 或 `1.`/`1)` + 空白。 */
const LIST_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/
/** 缩进着的内容：可能是列表项的续行，也可能是嵌套列表。 */
const INDENTED = /^[ \t]/
/** 往后扫的上限，防止在没有空行的大文档里一路扫到底。 */
const MAX_SCAN_LINES = 5000

interface Mark {
  from: number
  to: number
}

interface ListInfo {
  from: number
  to: number
  /** 每项 ListMark（`1.` 那两个字符）的位置，相对传进来那一段的起点。 */
  marks: Mark[]
}

/**
 * 一次用户编辑之后，把受影响的列表序号排一遍。
 *
 * 排在同一次更新里（返回 `[tr, 补丁]`），所以撤销一次就回到编辑前，不会留下
 * 一个「撤销了删除、序号却没回去」的中间态。
 */
/** 防重入：补丁那一笔事务会再过一遍这个过滤器，不能让它无限套娃。 */
let patching = false

export const renumberLists = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr
  const event = tr.annotation(Transaction.userEvent)
  // 只认用户自己动手的改动。撤销/重做也放过：那时候要还原的是历史，不是重排。
  if (!event || event.startsWith('undo') || event.startsWith('redo')) return tr

  const before = syntaxTree(tr.startState)
  if (!touchesOrderedList(before, tr.changes)) return tr

  const range = affectedRange(tr, before)
  const slice = tr.newDoc.sliceString(range.from, range.to)
  const changes: { from: number; to: number; insert: string }[] = []

  for (const list of orderedLists(markdownParser.parse(slice))) {
    if (!needsRenumbering(list, before, tr.changes, range.from)) continue
    const start = Number.parseInt(slice.slice(list.marks[0].from, list.marks[0].to), 10)
    if (!Number.isFinite(start)) continue
    list.marks.forEach((mark, index) => {
      const now = slice.slice(mark.from, mark.to)
      const want = `${start + index}${now.endsWith(')') ? ')' : '.'}`
      if (now !== want) changes.push({ from: range.from + mark.from, to: range.from + mark.to, insert: want })
    })
  }

  if (changes.length === 0) return tr
  if (patching) return tr

  // 补丁必须和用户那一笔改动**合成一笔**，理由有两条，都是实测撞出来的：
  //   · 返回 `[tr, { changes }]` 不行。过滤器返回数组时，CodeMirror 把两段规格都按
  //     `tr.startState` 的坐标解析并合并（state 包 resolveTransaction 的 `state` 就是
  //     startState），于是删掉的行会让补丁整体错位：`1. 甲 / 3. 乙 / 4. 丙` 删掉中间那项，
  //     落成了 `2.3. 丙`。
  //   · 返回一笔从 `tr.state` 出发的事务也不行。那样文档确实对，但视图会拒收：
  //     `Trying to update state with a transaction that doesn't start from the previous
  //     state`——视图要求每一笔事务都从它当前的状态出发。
  // 所以这里把补丁按新文档算好，用 `compose` 接到用户那笔改动后面，交回一笔从
  // `tr.startState` 出发的事务：文档对，视图认，撤销一步回到改前。
  const patch = ChangeSet.of(changes, tr.newDoc.length)
  patching = true
  try {
    return tr.startState.update({
      changes: tr.changes.compose(patch),
      selection: tr.selection ? tr.selection.map(patch) : undefined,
      effects: tr.effects,
      // `Transaction.annotations` 不是公开字段，这里只把 userEvent 传下去：
      // 撤销分组和「这是一次编辑」的语义都靠它
      userEvent: event,
      scrollIntoView: tr.scrollIntoView,
    })
  } finally {
    patching = false
  }
})

/** 树里的有序列表，各取自己每项 ListMark 的位置。 */
function orderedLists(tree: Tree): ListInfo[] {
  const lists: ListInfo[] = []
  tree.iterate({
    enter(node) {
      if (node.name !== 'OrderedList') return
      const marks: Mark[] = []
      for (let item = node.node.firstChild; item; item = item.nextSibling) {
        if (item.name !== 'ListItem') continue
        const mark = item.getChild('ListMark')
        if (mark) marks.push({ from: mark.from, to: mark.to })
      }
      if (marks.length > 0) lists.push({ from: node.from, to: node.to, marks })
    },
  })
  return lists
}

/** 改动有没有落到有序列表上。只看改动前那棵树：够准，而且不用解析。 */
function touchesOrderedList(tree: Tree, changes: ChangeSet): boolean {
  let hit = false
  changes.iterChangedRanges((fromA, toA) => {
    if (hit) return
    const last = Math.max(fromA, toA - 1)
    for (const [pos, side] of [[fromA, -1], [fromA, 1], [last, -1], [last, 1]] as const) {
      if (enclosingOrderedList(tree, pos, side)) {
        hit = true
        return
      }
    }
  })
  return hit
}

function enclosingOrderedList(tree: Tree, pos: number, side: -1 | 1): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(Math.min(Math.max(pos, 0), tree.length), side)
  while (node) {
    if (node.name === 'OrderedList') return node
    node = node.parent
  }
  return null
}

/**
 * 要去重排的那段文本。
 *
 * 起点取改动所在**最外层块**的第一行：列表的边界就在这一层，从块的边界切，
 * 不会把一个列表从中间切断。终点往后扫到列表确定结束为止（见 listClusterEnd）。
 */
function affectedRange(tr: Transaction, before: Tree): { from: number; to: number } {
  let first = -1
  tr.changes.iterChangedRanges((fromA) => {
    if (first < 0) first = fromA
  })
  if (first < 0) return { from: 0, to: tr.newDoc.length }

  let block: SyntaxNode | null = before.resolveInner(first, 1)
  while (block && block.parent && block.parent.name !== 'Document') block = block.parent
  const mapped = block ? tr.changes.mapPos(block.from, -1) : first
  const from = tr.newDoc.lineAt(Math.min(Math.max(mapped, 0), tr.newDoc.length)).from
  return { from, to: listClusterEnd(tr.newDoc, from) }
}

/**
 * 列表往后铺到哪儿为止。
 *
 * 空行不是结束：松列表里空行是允许的（`1. 甲`、空行、`2. 乙` 仍是一个列表）。
 * 空行之后跟的第一行既不是列表项、也不是缩进内容，那个列表才算真的结束。
 * 宁可多切一点：多切只会多解析几行，少切会把列表从中间截断，序号就会排错。
 */
function listClusterEnd(doc: Text, from: number): number {
  const first = doc.lineAt(from)
  let end = first.to
  let blank = false
  const stop = Math.min(doc.lines, first.number + MAX_SCAN_LINES)
  for (let number = first.number + 1; number <= stop; number++) {
    const line = doc.line(number)
    if (line.text.trim() === '') {
      blank = true
      end = line.to
      continue
    }
    if (blank && !LIST_LINE.test(line.text) && !INDENTED.test(line.text)) break
    blank = false
    end = line.to
  }
  return end
}

/**
 * 这个列表要不要重排。
 *
 * 数量变了（增删项、改层级）要重排；改动碰到序号本身（改起始编号）也要。
 * 其它情况一律放过：在列表里打普通文字不该动序号。
 */
function needsRenumbering(list: ListInfo, before: Tree, changes: ChangeSet, offset: number): boolean {
  const old = enclosingOrderedList(before, changes.mapPos(offset + list.from, -1), 1)
  // 改动前这里还不是列表（比如刚敲出一个 `1.`）：当新列表处理
  if (old === null) return true
  if (countItems(old) !== list.marks.length) return true
  return touchedMark(changes, old)
}

function countItems(list: SyntaxNode): number {
  let count = 0
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.name === 'ListItem') count++
  }
  return count
}

/** 改动有没有碰到这个列表里某个序号。位置都是**改动前**的坐标。 */
function touchedMark(changes: ChangeSet, list: SyntaxNode): boolean {
  let hit = false
  changes.iterChangedRanges((fromA, toA) => {
    if (hit) return
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue
      const mark = item.getChild('ListMark')
      if (!mark) continue
      if (fromA <= mark.from && toA >= mark.from) {
        hit = true
        return
      }
      if (fromA < mark.to && toA > mark.from) {
        hit = true
        return
      }
    }
  })
  return hit
}
