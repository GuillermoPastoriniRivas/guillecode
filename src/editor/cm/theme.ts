import { EditorView } from "@codemirror/view"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"

export const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--editor-fg)",
      backgroundColor: "var(--editor-bg)",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      lineHeight: "1.6",
    },
    ".cm-content": { caretColor: "var(--accent-strong)", padding: "6px 0 40vh" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent-strong)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(110, 140, 255, 0.28) !important",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.035)" },
    ".cm-gutters": {
      backgroundColor: "var(--editor-bg)",
      color: "var(--fg-faint)",
      border: "none",
      paddingRight: "4px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "44px" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--fg-faint)", cursor: "pointer" },
    ".cm-matchingBracket": { backgroundColor: "rgba(110, 140, 255, 0.22)", outline: "1px solid rgba(110,140,255,0.5)" },
    ".cm-searchMatch": { backgroundColor: "rgba(234, 179, 8, 0.25)", outline: "1px solid rgba(234,179,8,0.45)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(234, 179, 8, 0.5)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(110, 140, 255, 0.14)" },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-overlay)",
      border: "1px solid var(--border-strong)",
      borderRadius: "8px",
      boxShadow: "var(--shadow-lg)",
      color: "var(--fg)",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-bg)", color: "var(--fg)" },
    ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--fg)", borderColor: "var(--border)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
    ".cm-panel.cm-search": { padding: "8px 10px", fontFamily: "var(--font)", fontSize: "12px" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { fontSize: "12px" },
    ".cm-textfield": {
      backgroundColor: "var(--bg-input)",
      border: "1px solid var(--border-strong)",
      borderRadius: "5px",
      color: "var(--fg)",
      padding: "3px 6px",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--bg-hover)",
      border: "1px solid var(--border-strong)",
      borderRadius: "5px",
      color: "var(--fg)",
      padding: "2px 8px",
    },
    ".cm-foldPlaceholder": { backgroundColor: "var(--bg-hover)", border: "none", color: "var(--fg-dim)", padding: "0 6px" },
  },
  { dark: true },
)

export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#c792ea" },
  { tag: [t.definitionKeyword, t.modifier], color: "#82aaff" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "#d6deeb" },
  { tag: [t.propertyName], color: "#9cdcfe" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "#dcdcaa" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#4fc1ff" },
  { tag: [t.definition(t.name), t.separator], color: "#d6deeb" },
  { tag: [t.typeName, t.className, t.namespace], color: "#4ec9b0" },
  { tag: [t.number, t.changed, t.annotation, t.self], color: "#b5cea8" },
  { tag: [t.bool, t.null, t.atom], color: "#569cd6" },
  { tag: [t.operator, t.escape, t.url, t.link], color: "#89ddff" },
  { tag: [t.regexp, t.special(t.string)], color: "#d16969" },
  { tag: [t.meta, t.comment], color: "#6a7d8f", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "#82aaff" },
  { tag: [t.string, t.inserted], color: "#ce9178" },
  { tag: [t.attributeName], color: "#9cdcfe" },
  { tag: [t.tagName], color: "#4ec9b0" },
  { tag: [t.variableName], color: "#d6deeb" },
  { tag: t.invalid, color: "#f44747" },
])

export const syntaxTheme = syntaxHighlighting(highlightStyle, { fallback: true })
