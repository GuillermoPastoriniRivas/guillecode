import { StateEffect, StateField, type Range, type Text } from "@codemirror/state"
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view"
import { Chunk } from "@codemirror/merge"

export const flashRanges = StateEffect.define<Array<{ from: number; to: number }>>()
export const clearFlash = StateEffect.define<null>()

const flashLine = Decoration.line({ class: "cm-agent-flash" })

export const agentFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value
    for (const e of tr.effects) {
      if (e.is(clearFlash)) next = Decoration.none
      if (e.is(flashRanges)) {
        const doc = tr.state.doc
        const lines: Range<Decoration>[] = []
        for (const r of e.value) {
          let pos = Math.min(r.from, doc.length)
          const end = Math.min(r.to, doc.length)
          while (pos <= end) {
            const line = doc.lineAt(pos)
            lines.push(flashLine.range(line.from))
            if (line.to >= end) break
            pos = line.to + 1
          }
        }
        next = Decoration.set(lines, true)
      }
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

export function changedRangesInB(before: Text, after: Text): Array<{ from: number; to: number }> {
  return Chunk.build(before, after)
    .filter((c) => c.fromB !== c.toB)
    .map((c) => ({ from: c.fromB, to: Math.max(c.fromB, c.endB) }))
}
