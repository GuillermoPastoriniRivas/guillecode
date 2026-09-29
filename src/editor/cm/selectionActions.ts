import { StateField, type EditorState } from "@codemirror/state"
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view"

export type SelectionAction = { label: string; hint?: string; icon: string; run: (view: EditorView) => void }

const MIN_SELECTION = 2

function buildTooltip(state: EditorState, actions: SelectionAction[]): Tooltip | null {
  const sel = state.selection.main
  if (sel.empty || sel.to - sel.from < MIN_SELECTION || state.selection.ranges.length > 1) return null
  return {
    pos: sel.head,
    above: sel.head === sel.from,
    strictSide: false,
    arrow: false,
    create: (view) => {
      const dom = document.createElement("div")
      dom.className = "cm-selection-actions"
      for (const action of actions) {
        const button = document.createElement("button")
        button.type = "button"
        button.innerHTML = `<i class="codicon codicon-${action.icon}"></i><span>${action.label}</span>${
          action.hint ? `<kbd>${action.hint}</kbd>` : ""
        }`
        button.addEventListener("mousedown", (e) => {
          e.preventDefault()
          e.stopPropagation()
          action.run(view)
        })
        dom.appendChild(button)
      }
      return { dom, offset: { x: 0, y: 6 } }
    },
  }
}

export function selectionActions(actions: SelectionAction[]) {
  return StateField.define<Tooltip | null>({
    create: (state) => buildTooltip(state, actions),
    update(tooltip, tr) {
      if (!tr.docChanged && !tr.selection) return tooltip
      return buildTooltip(tr.state, actions)
    },
    provide: (f) => showTooltip.from(f),
  })
}

export function selectionInfo(view: EditorView): { text: string; startLine: number; endLine: number } | null {
  const sel = view.state.selection.main
  if (sel.empty) return null
  const doc = view.state.doc
  const startLine = doc.lineAt(sel.from).number
  const endLine = doc.lineAt(sel.to === doc.lineAt(sel.to).from && sel.to > sel.from ? sel.to - 1 : sel.to).number
  return { text: view.state.sliceDoc(sel.from, sel.to), startLine, endLine }
}
