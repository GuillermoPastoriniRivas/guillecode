import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, highlightSpecialChars, lineNumbers, drawSelection, keymap } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search"
import { editorTheme, syntaxTheme } from "./theme"

export function viewerExtensions(opts: { editable: boolean; language?: Extension | null }): Extension[] {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    syntaxTheme,
    editorTheme,
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...defaultKeymap.filter((k) => k.key !== "Mod-l"), ...searchKeymap.filter((k) => k.key !== "Mod-Alt-g")]),
    ...(opts.editable ? [history(), keymap.of(historyKeymap)] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
    opts.language ?? [],
  ]
}
