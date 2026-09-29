import type { EditorView } from "@codemirror/view"
import { EditorSelection } from "@codemirror/state"
import { addContext, focusComposer } from "../state/agent"
import { useLayout } from "../state/layout"
import { openEditor } from "../state/editors"
import { repoForPath } from "../state/git"
import { notify } from "../state/toasts"
import { selectionInfo } from "./cm/selectionActions"

type ActiveCode = { path: string; view: EditorView } | null

let active: ActiveCode = null
let saver: (() => Promise<void> | void) | null = null

export function setCustomSaver(fn: (() => Promise<void> | void) | null): void {
  saver = fn
}

export function customSaver(): (() => Promise<void> | void) | null {
  return saver
}

export function setActiveCode(path: string | null, view: EditorView | null): void {
  active = path && view ? { path, view } : null
}

export function activeCode(): ActiveCode {
  return active
}

export function addSelectionToChat(view: EditorView, path: string, draft?: string): boolean {
  const info = selectionInfo(view)
  if (info) addContext({ kind: "selection", path, startLine: info.startLine, endLine: info.endLine, text: info.text })
  else addContext({ kind: "file", path })
  useLayout.getState().toggleAgent(true)
  focusComposer(draft)
  return true
}

export function addActiveSelectionToChat(draft?: string): void {
  if (active) addSelectionToChat(active.view, active.path, draft)
  else {
    useLayout.getState().toggleAgent(true)
    focusComposer(draft)
  }
}

export function openCommitFromBlame(path: string, hash: string): void {
  const repo = repoForPath(path)
  if (!repo) {
    notify.warning("El archivo no está en un repo git")
    return
  }
  openEditor({ kind: "commit", repo, hash })
}

export function goToLine(view: EditorView, line: number, column = 1, endLine?: number, endColumn?: number): void {
  const doc = view.state.doc
  const l = doc.line(Math.max(1, Math.min(doc.lines, line)))
  const from = Math.min(l.to, l.from + Math.max(0, column - 1))
  let to = from
  if (endLine !== undefined) {
    const el = doc.line(Math.max(1, Math.min(doc.lines, endLine)))
    to = endColumn !== undefined ? Math.min(el.to, el.from + Math.max(0, endColumn - 1)) : el.to
  }
  view.dispatch({
    selection: EditorSelection.single(from, to),
    scrollIntoView: true,
    effects: [],
  })
  const coords = view.coordsAtPos(from)
  if (coords) {
    const rect = view.scrollDOM.getBoundingClientRect()
    const offset = coords.top - rect.top - rect.height / 3
    view.scrollDOM.scrollTop += offset
  }
  view.focus()
}
