import { useEffect, useRef, useState, type ReactNode } from "react"
import { EditorView, GutterMarker, gutter } from "@codemirror/view"
import { EditorState, RangeSet, type Extension } from "@codemirror/state"
import {
  MergeView,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  mergeViewSiblings,
  unifiedMergeView,
  type Chunk,
} from "@codemirror/merge"
import { viewerExtensions } from "./cm/readonly"
import { languageFor } from "./cm/setup"
import { setCustomSaver } from "./bridge"
import { loadJson, saveJson } from "../lib/persist"
import { Icon, IconButton, Spinner } from "../components/ui"
import { Segmented } from "../components/fields"

export type DiffMode = "split" | "unified"

export type HunkInfo = {
  fromLineA: number
  toLineA: number
  fromLineB: number
  toLineB: number
  linesA: string[]
  linesB: string[]
}

export function hunkFromChunk(chunk: Chunk, a: EditorState, b: EditorState): HunkInfo {
  const docA = a.doc
  const docB = b.doc
  const hasA = chunk.fromA < chunk.toA
  const hasB = chunk.fromB < chunk.toB
  const fromLineA = docA.lineAt(Math.min(chunk.fromA, docA.length)).number
  const toLineA = hasA ? docA.lineAt(Math.min(chunk.endA, docA.length)).number : fromLineA - 1
  const fromLineB = docB.lineAt(Math.min(chunk.fromB, docB.length)).number
  const toLineB = hasB ? docB.lineAt(Math.min(chunk.endB, docB.length)).number : fromLineB - 1
  const linesA: string[] = []
  const linesB: string[] = []
  for (let l = fromLineA; hasA && l <= toLineA; l++) linesA.push(docA.line(l).text)
  for (let l = fromLineB; hasB && l <= toLineB; l++) linesB.push(docB.line(l).text)
  return { fromLineA, toLineA, fromLineB, toLineB, linesA, linesB }
}

export function hunkPatch(path: string, hunk: HunkInfo): string {
  const countA = hunk.linesA.length
  const countB = hunk.linesB.length
  const startA = countA === 0 ? hunk.fromLineA - 1 : hunk.fromLineA
  const startB = countB === 0 ? hunk.fromLineB - 1 : hunk.fromLineB
  const body = [...hunk.linesA.map((l) => `-${l}`), ...hunk.linesB.map((l) => `+${l}`)].join("\n")
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${startA},${countA} +${startB},${countB} @@\n${body}\n`
}

class StageMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("div")
    el.className = "cm-stage-hunk"
    el.title = "Pasar este cambio al stage"
    el.innerHTML = '<i class="codicon codicon-add"></i>'
    return el
  }
}

const STAGE_MARKER = new StageMarker()

function chunkLineStart(state: EditorState, chunk: Chunk): number {
  return state.doc.lineAt(Math.min(chunk.fromB, state.doc.length)).from
}

function stageGutter(onStage: (hunk: HunkInfo) => void): Extension {
  return gutter({
    class: "cm-stage-gutter",
    markers: (view) => {
      const info = getChunks(view.state)
      if (!info) return RangeSet.empty
      return RangeSet.of(
        info.chunks.map((c) => STAGE_MARKER.range(chunkLineStart(view.state, c))),
        true,
      )
    },
    domEventHandlers: {
      mousedown(view, line) {
        const info = getChunks(view.state)
        const siblings = mergeViewSiblings(view)
        if (!info || !siblings) return false
        const chunk = info.chunks.find((c) => chunkLineStart(view.state, c) === line.from)
        if (!chunk) return false
        onStage(hunkFromChunk(chunk, siblings.a.state, siblings.b.state))
        return true
      },
    },
  })
}

type Props = {
  path: string
  original: string
  modified: string
  editable: boolean
  header: ReactNode
  onSave?: (text: string) => Promise<void>
  onStageHunk?: (hunk: HunkInfo) => Promise<void>
  labelA: string
  labelB: string
}

function languageExtension(path: string): Promise<Extension | null> {
  const lang = languageFor(path)
  return lang ? lang.load() : Promise.resolve(null)
}

export function DiffView({ path, original, modified, editable, header, onSave, onStageHunk, labelA, labelB }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<DiffMode>(() => loadJson<DiffMode>("diff.mode", "split"))
  const [dirty, setDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const [chunks, setChunks] = useState<readonly Chunk[]>([])
  const viewRef = useRef<{ b: EditorView; a: EditorView | null; merge: MergeView | null } | null>(null)
  const savedText = useRef(modified)
  const stageRef = useRef(onStageHunk)
  stageRef.current = onStageHunk

  useEffect(() => {
    let disposed = false
    const el = host.current
    if (!el) return
    savedText.current = modified
    setDirty(false)
    setReady(false)
    const changeListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) setDirty(u.state.doc.toString() !== savedText.current)
      if (u.docChanged || u.viewportChanged) {
        const merge = viewRef.current?.merge
        if (merge) setChunks(merge.chunks)
      }
    })
    void languageExtension(path).then((language) => {
      if (disposed) return
      if (mode === "split") {
        const merge = new MergeView({
          a: { doc: original, extensions: viewerExtensions({ editable: false, language }) },
          b: {
            doc: modified,
            extensions: [
              ...viewerExtensions({ editable, language }),
              changeListener,
              stageRef.current ? stageGutter((hunk) => void stageRef.current?.(hunk)) : [],
            ],
          },
          parent: el,
          collapseUnchanged: { margin: 3, minSize: 6 },
          highlightChanges: true,
          gutter: true,
          revertControls: editable ? "a-to-b" : undefined,
        })
        viewRef.current = { a: merge.a, b: merge.b, merge }
        setChunks(merge.chunks)
      } else {
        const b = new EditorView({
          parent: el,
          doc: modified,
          extensions: [
            ...viewerExtensions({ editable, language }),
            changeListener,
            unifiedMergeView({
              original,
              highlightChanges: true,
              gutter: true,
              mergeControls: editable,
              collapseUnchanged: { margin: 3, minSize: 6 },
              syntaxHighlightDeletions: true,
            }),
          ],
        })
        viewRef.current = { a: null, b, merge: null }
      }
      setReady(true)
    })
    return () => {
      disposed = true
      viewRef.current?.merge?.destroy()
      if (!viewRef.current?.merge) viewRef.current?.b.destroy()
      viewRef.current = null
      el.innerHTML = ""
    }
  }, [path, original, modified, editable, mode])

  const save = async () => {
    const b = viewRef.current?.b
    if (!b || !onSave) return
    const text = b.state.doc.toString()
    await onSave(text)
    savedText.current = text
    setDirty(false)
  }

  useEffect(() => {
    const b = viewRef.current?.b
    if (!b || !editable || !onSave) return
    const focus = () => setCustomSaver(() => save())
    const blur = () => setCustomSaver(null)
    b.contentDOM.addEventListener("focus", focus)
    b.contentDOM.addEventListener("blur", blur)
    return () => {
      b.contentDOM.removeEventListener("focus", focus)
      b.contentDOM.removeEventListener("blur", blur)
      setCustomSaver(null)
    }
  })

  const nav = (dir: 1 | -1) => {
    const b = viewRef.current?.b
    if (!b) return
    ;(dir === 1 ? goToNextChunk : goToPreviousChunk)(b)
    b.focus()
  }

  const changeMode = (next: DiffMode) => {
    setMode(next)
    saveJson("diff.mode", next)
  }

  return (
    <div className="diff-editor">
      <div className="diff-editor-toolbar">
        {header}
        <span className="toolbar-spacer" />
        {chunks.length > 0 && <span className="toolbar-note">{chunks.length} cambio{chunks.length === 1 ? "" : "s"}</span>}
        {dirty && <span className="dirty-pill">sin guardar</span>}
        {editable && onSave && (
          <button type="button" className="btn btn-xs btn-primary" disabled={!dirty} onClick={() => void save()}>
            <Icon name="save" /> Guardar
          </button>
        )}
        <IconButton icon="arrow-up" title="Cambio anterior" onClick={() => nav(-1)} />
        <IconButton icon="arrow-down" title="Cambio siguiente" onClick={() => nav(1)} />
        <Segmented<DiffMode>
          iconOnly
          value={mode}
          options={[
            { value: "split", label: "Lado a lado", icon: "split-horizontal" },
            { value: "unified", label: "Todo en uno", icon: "diff-single" },
          ]}
          onChange={changeMode}
        />
      </div>
      {mode === "split" && (
        <div className="diff-labels">
          <span>{labelA}</span>
          <span>{labelB}</span>
        </div>
      )}
      <div className="diff-editor-body">
        {!ready && (
          <div className="editor-overlay">
            <Spinner />
          </div>
        )}
        <div ref={host} className={`merge-host ${mode}`} />
      </div>
    </div>
  )
}
