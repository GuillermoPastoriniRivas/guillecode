import { RangeSet, StateEffect, StateField, Text, type Range } from "@codemirror/state"
import { GutterMarker, gutter } from "@codemirror/view"
import { Chunk } from "@codemirror/merge"

type ChangeKind = "added" | "modified" | "deleted"

class ChangeMarker extends GutterMarker {
  kind: ChangeKind
  constructor(kind: ChangeKind) {
    super()
    this.kind = kind
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind
  }
  toDOM() {
    const el = document.createElement("div")
    el.className = `cm-gg cm-gg-${this.kind}`
    el.title = this.kind === "added" ? "Línea nueva" : this.kind === "modified" ? "Línea modificada" : "Líneas borradas"
    return el
  }
}

const MARKERS: Record<ChangeKind, ChangeMarker> = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
}

export const setGitBase = StateEffect.define<string | null>()

type GitGutterValue = {
  base: Text | null
  chunks: readonly Chunk[]
  markers: RangeSet<GutterMarker>
}

const MAX_DIFF_CHARS = 1_500_000

function markersFor(doc: Text, chunks: readonly Chunk[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = []
  for (const chunk of chunks) {
    if (chunk.fromB === chunk.toB) {
      const pos = Math.min(chunk.fromB, doc.length)
      ranges.push(MARKERS.deleted.range(doc.lineAt(pos).from))
      continue
    }
    const marker = chunk.fromA === chunk.toA ? MARKERS.added : MARKERS.modified
    const end = Math.min(chunk.endB, doc.length)
    let pos = chunk.fromB
    while (pos <= end) {
      const line = doc.lineAt(pos)
      ranges.push(marker.range(line.from))
      if (line.to >= end) break
      pos = line.to + 1
    }
  }
  return RangeSet.of(ranges, true)
}

function build(base: Text | null, doc: Text): GitGutterValue {
  if (!base || base.length + doc.length > MAX_DIFF_CHARS) return { base, chunks: [], markers: RangeSet.empty }
  const chunks = Chunk.build(base, doc)
  return { base, chunks, markers: markersFor(doc, chunks) }
}

export const gitGutterField = StateField.define<GitGutterValue>({
  create: () => ({ base: null, chunks: [], markers: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGitBase)) {
        const base = e.value === null ? null : Text.of(e.value.replace(/\r\n/g, "\n").split("\n"))
        return build(base, tr.state.doc)
      }
    }
    if (!tr.docChanged || !value.base) return value
    if (value.base.length + tr.state.doc.length > MAX_DIFF_CHARS) return value
    const chunks = Chunk.updateB(value.chunks, value.base, tr.state.doc, tr.changes)
    return { base: value.base, chunks, markers: markersFor(tr.state.doc, chunks) }
  },
})

export function gitGutter() {
  return [
    gitGutterField,
    gutter({
      class: "cm-git-gutter",
      markers: (view) => view.state.field(gitGutterField).markers,
      initialSpacer: () => MARKERS.added,
    }),
  ]
}
