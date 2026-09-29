import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search"
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete"
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  LanguageDescription,
  type LanguageSupport,
} from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { editorTheme, syntaxTheme } from "./theme"
import { gitGutter } from "./gitGutter"
import { inlineBlame } from "./blame"
import { agentFlashField } from "./agentFlash"

export const languageCompartment = new Compartment()
export const readOnlyCompartment = new Compartment()
export const wrapCompartment = new Compartment()

const GLOBAL_KEYS = new Set(["Mod-l", "Mod-Alt-g", "Mod-Shift-l"])

function withoutGlobalKeys<T extends { key?: string }>(bindings: readonly T[]): T[] {
  return bindings.filter((b) => !b.key || !GLOBAL_KEYS.has(b.key))
}

export function detectIndent(text: string): string {
  const lines = text.split("\n", 400)
  let tabs = 0
  const spaces = new Map<number, number>()
  let prev = 0
  for (const line of lines) {
    if (!line.trim()) continue
    if (line.startsWith("\t")) {
      tabs++
      continue
    }
    const n = line.length - line.trimStart().length
    const diff = Math.abs(n - prev)
    if (diff >= 2 && diff <= 8) spaces.set(diff, (spaces.get(diff) ?? 0) + 1)
    prev = n
  }
  const bestSpaces = [...spaces.entries()].sort((a, b) => b[1] - a[1])[0]
  if (tabs > (bestSpaces?.[1] ?? 0)) return "\t"
  return " ".repeat(bestSpaces?.[0] ?? 2)
}

export function baseExtensions(opts: { indent: string; readOnly?: boolean; extra?: Extension[] }): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ openText: "▾", closedText: "▸" }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxTheme,
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    indentUnit.of(opts.indent),
    EditorState.tabSize.of(opts.indent === "\t" ? 4 : opts.indent.length),
    keymap.of([
      ...withoutGlobalKeys(closeBracketsKeymap),
      ...withoutGlobalKeys(defaultKeymap),
      ...withoutGlobalKeys(searchKeymap),
      ...withoutGlobalKeys(historyKeymap),
      ...withoutGlobalKeys(foldKeymap),
      ...withoutGlobalKeys(completionKeymap),
      indentWithTab,
    ]),
    languageCompartment.of([]),
    readOnlyCompartment.of(EditorState.readOnly.of(opts.readOnly ?? false)),
    wrapCompartment.of([]),
    editorTheme,
    gitGutter(),
    inlineBlame(),
    agentFlashField,
    ...(opts.extra ?? []),
  ]
}

const languageCache = new Map<string, Promise<LanguageSupport | null>>()

export function languageFor(path: string): { name: string; load: () => Promise<LanguageSupport | null> } | null {
  const desc = LanguageDescription.matchFilename(languages, path.split(/[\\/]/).pop() ?? path)
  if (!desc) return null
  return {
    name: desc.name,
    load: () => {
      let p = languageCache.get(desc.name)
      if (!p) {
        p = desc.load().catch(() => null)
        languageCache.set(desc.name, p)
      }
      return p
    },
  }
}

export function applyLanguage(view: EditorView, path: string): void {
  const lang = languageFor(path)
  if (!lang) return
  void lang.load().then((support) => {
    if (support) view.dispatch({ effects: languageCompartment.reconfigure(support) })
  })
}

export function wrapExtension(on: boolean): Extension {
  return on ? EditorView.lineWrapping : []
}
