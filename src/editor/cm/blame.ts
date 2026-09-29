import { Facet, RangeSet, RangeValue, StateEffect, StateField, type EditorState, type Range } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import type { BlameLine } from "../../lib/git"
import { UNCOMMITTED_HASH } from "../../lib/git"
import { timeAgo, formatDateTime } from "../../lib/time"

class BlameValue extends RangeValue {
  line: BlameLine
  constructor(line: BlameLine) {
    super()
    this.line = line
  }
  eq(other: RangeValue): boolean {
    return other instanceof BlameValue && other.line.hash === this.line.hash
  }
}

export const setBlame = StateEffect.define<BlameLine[] | null>()
export const toggleInlineBlame = StateEffect.define<boolean>()

type BlameState = { set: RangeSet<BlameValue>; loaded: boolean; enabled: boolean }

export const blameField = StateField.define<BlameState>({
  create: () => ({ set: RangeSet.empty, loaded: false, enabled: true }),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(setBlame)) {
        if (!e.value) {
          next = { ...next, set: RangeSet.empty, loaded: false }
          continue
        }
        const doc = tr.state.doc
        const ranges: Range<BlameValue>[] = []
        for (const b of e.value) {
          if (b.line < 1 || b.line > doc.lines) continue
          ranges.push(new BlameValue(b).range(doc.line(b.line).from))
        }
        next = { ...next, set: RangeSet.of(ranges, true), loaded: true }
      }
      if (e.is(toggleInlineBlame)) next = { ...next, enabled: e.value }
    }
    if (tr.docChanged && next === value) return { ...value, set: value.set.map(tr.changes) }
    if (tr.docChanged) return { ...next, set: next.set.map(tr.changes) }
    return next
  },
})

export function blameAtLine(state: EditorState, lineNumber: number): BlameLine | null {
  const field = state.field(blameField, false)
  if (!field || !field.loaded) return null
  const line = state.doc.line(lineNumber)
  let found: BlameLine | null = null
  field.set.between(line.from, line.from, (from, _to, value) => {
    if (from === line.from) {
      found = value.line
      return false
    }
    return undefined
  })
  return found
}

export const blameClickHandler = Facet.define<(hash: string) => void, ((hash: string) => void) | null>({
  combine: (values) => values[0] ?? null,
})

class BlameWidget extends WidgetType {
  info: BlameLine | null
  onClick: ((hash: string) => void) | null
  constructor(info: BlameLine | null, onClick: ((hash: string) => void) | null) {
    super()
    this.info = info
    this.onClick = onClick
  }
  eq(other: BlameWidget): boolean {
    return other.info?.hash === this.info?.hash && other.info?.line === this.info?.line
  }
  toDOM() {
    const span = document.createElement("span")
    span.className = "cm-inline-blame"
    const info = this.info
    if (!info || UNCOMMITTED_HASH.test(info.hash)) {
      span.textContent = "Vos · sin commitear"
      return span
    }
    const who = info.author || "desconocido"
    span.textContent = `${who}, ${timeAgo(info.time * 1000)} · ${info.subject}`
    span.title = `${info.subject}\n\n${who}${info.email ? ` <${info.email}>` : ""}\n${formatDateTime(info.time * 1000)}\n${info.hash.slice(0, 10)}\n\nClic para ver el commit`
    if (this.onClick) {
      span.classList.add("clickable")
      const click = this.onClick
      span.addEventListener("mousedown", (e) => {
        e.preventDefault()
        e.stopPropagation()
        click(info.hash)
      })
    }
    return span
  }
  ignoreEvent() {
    return false
  }
}

function buildInline(view: EditorView): DecorationSet {
  const field = view.state.field(blameField, false)
  if (!field || !field.enabled || !field.loaded) return Decoration.none
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  if (view.state.doc.lineAt(sel.anchor).number !== line.number) return Decoration.none
  const info = blameAtLine(view.state, line.number)
  const widget = Decoration.widget({
    widget: new BlameWidget(info, view.state.facet(blameClickHandler)),
    side: 1,
  })
  return Decoration.set([widget.range(line.to)])
}

const inlineBlamePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildInline(view)
    }
    update(update: ViewUpdate) {
      if (
        update.selectionSet ||
        update.docChanged ||
        update.startState.field(blameField, false) !== update.state.field(blameField, false)
      ) {
        this.decorations = buildInline(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

export function inlineBlame() {
  return [blameField, inlineBlamePlugin]
}
