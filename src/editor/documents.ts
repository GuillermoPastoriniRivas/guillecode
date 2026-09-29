import { create } from "zustand"
import { ChangeSet, EditorState, Text, Transaction, type TransactionSpec } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { diff as textDiff } from "@codemirror/merge"
import { BINARY_FILE_ERROR, readFile, stat, writeFile } from "../lib/fs"
import { gitBlame, gitShowFile } from "../lib/git"
import { normalizePath, relativePath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { repoForPath, statusEntryFor } from "../state/git"
import { notify } from "../state/toasts"
import { lintGutter } from "@codemirror/lint"
import { baseExtensions, detectIndent, languageCompartment, languageFor } from "./cm/setup"
import { setGitBase } from "./cm/gitGutter"
import { blameClickHandler, setBlame } from "./cm/blame"
import { selectionActions } from "./cm/selectionActions"
import { addSelectionToChat, openCommitFromBlame } from "./bridge"
import { changedRangesInB, clearFlash, flashRanges } from "./cm/agentFlash"

export type Eol = "\n" | "\r\n"

type DocEntry = {
  path: string
  state: EditorState
  saved: Text
  eol: Eol
  bom: boolean
  mtime: number
  indent: string
  language: string
  view: EditorView | null
}

export type DocMeta = { eol: Eol; bom: boolean; indent: string; language: string }
export type CursorInfo = { line: number; column: number; selected: number; selections: number }

type DocsUi = {
  dirty: Record<string, true>
  conflicts: Record<string, true>
  meta: Record<string, DocMeta>
  cursor: CursorInfo | null
}

export const useDocs = create<DocsUi>(() => ({ dirty: {}, conflicts: {}, meta: {}, cursor: null }))

export class BinaryFileError extends Error {
  constructor() {
    super("Archivo binario")
  }
}

const docs = new Map<string, DocEntry>()
const loading = new Map<string, Promise<DocEntry>>()
const FLASH_MS = 2600

export const docKey = (path: string) => normalizePath(path).toLowerCase()

function setFlag(field: "dirty" | "conflicts", key: string, on: boolean) {
  const current = useDocs.getState()[field]
  if (!!current[key] === on) return
  const next = { ...current }
  if (on) next[key] = true
  else delete next[key]
  useDocs.setState({ [field]: next } as Partial<DocsUi>)
}

function publishMeta(entry: DocEntry) {
  const key = docKey(entry.path)
  useDocs.setState((s) => ({
    meta: { ...s.meta, [key]: { eol: entry.eol, bom: entry.bom, indent: entry.indent, language: entry.language } },
  }))
}

function normalizeContent(raw: string): { text: string; eol: Eol } {
  const eol: Eol = raw.includes("\r\n") ? "\r\n" : "\n"
  return { text: eol === "\r\n" ? raw.replace(/\r\n/g, "\n") : raw, eol }
}

export function getDoc(path: string): DocEntry | undefined {
  return docs.get(docKey(path))
}

export function isDirty(path: string): boolean {
  return !!useDocs.getState().dirty[docKey(path)]
}

export function dirtyPaths(): string[] {
  return [...docs.values()].filter((d) => useDocs.getState().dirty[docKey(d.path)]).map((d) => d.path)
}

export async function loadDocument(path: string): Promise<DocEntry> {
  const key = docKey(path)
  const existing = docs.get(key)
  if (existing) return existing
  const pending = loading.get(key)
  if (pending) return pending
  const promise = (async () => {
    let file
    try {
      file = await readFile(path)
    } catch (e) {
      if (errorMessage(e) === BINARY_FILE_ERROR) throw new BinaryFileError()
      throw e
    }
    const { text, eol } = normalizeContent(file.content)
    const indent = detectIndent(text)
    const lang = languageFor(path)
    const docPath = normalizePath(path)
    const state = EditorState.create({
      doc: text,
      extensions: baseExtensions({
        indent,
        extra: [
          lintGutter(),
          blameClickHandler.of((hash) => openCommitFromBlame(docPath, hash)),
          selectionActions([
            { label: "Agregar al chat", hint: "Ctrl+L", icon: "sparkle", run: (view) => addSelectionToChat(view, docPath) },
            {
              label: "Explicar",
              icon: "comment-discussion",
              run: (view) => addSelectionToChat(view, docPath, "Explicame qué hace este código y si ves algún problema."),
            },
          ]),
        ],
      }),
    })
    const entry: DocEntry = {
      path: docPath,
      state,
      saved: state.doc,
      eol,
      bom: file.bom,
      mtime: file.mtime,
      indent,
      language: lang?.name ?? "Texto plano",
      view: null,
    }
    docs.set(key, entry)
    publishMeta(entry)
    if (lang) {
      void lang.load().then((support) => {
        if (support) dispatchToDoc(entry.path, { effects: languageCompartment.reconfigure(support) })
      })
    }
    void loadGitDecorations(entry.path)
    return entry
  })()
  loading.set(key, promise)
  try {
    return await promise
  } finally {
    loading.delete(key)
  }
}

export function dispatchToDoc(path: string, spec: TransactionSpec): void {
  const entry = docs.get(docKey(path))
  if (!entry) return
  if (entry.view && entry.view.state === entry.state) {
    entry.view.dispatch(spec)
    return
  }
  entry.state = entry.state.update(spec).state
  refreshDirty(entry)
}

function refreshDirty(entry: DocEntry) {
  setFlag("dirty", docKey(entry.path), !entry.state.doc.eq(entry.saved))
}

export function attachView(path: string, view: EditorView): EditorState | null {
  const entry = docs.get(docKey(path))
  if (!entry) return null
  for (const other of docs.values()) if (other.view === view) other.view = null
  entry.view = view
  return entry.state
}

export function detachView(view: EditorView): void {
  for (const entry of docs.values()) if (entry.view === view) entry.view = null
}

export function onViewTransaction(path: string, state: EditorState, docChanged: boolean): void {
  const entry = docs.get(docKey(path))
  if (!entry) return
  entry.state = state
  if (docChanged) refreshDirty(entry)
}

export async function saveDocument(path: string): Promise<boolean> {
  const entry = docs.get(docKey(path))
  if (!entry) return false
  const content = entry.state.doc.toString()
  const onDisk = entry.eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content
  try {
    entry.mtime = await writeFile(entry.path, onDisk, entry.bom)
    entry.saved = entry.state.doc
    refreshDirty(entry)
    setFlag("conflicts", docKey(entry.path), false)
    void loadBlame(entry.path)
    return true
  } catch (e) {
    notify.error(`No se pudo guardar ${relativePathSafe(entry.path)}`, errorMessage(e))
    return false
  }
}

function relativePathSafe(path: string): string {
  return path.split("/").slice(-2).join("/")
}

export async function saveAll(): Promise<number> {
  let saved = 0
  for (const entry of docs.values()) {
    if (useDocs.getState().dirty[docKey(entry.path)] && (await saveDocument(entry.path))) saved++
  }
  return saved
}

function minimalChanges(from: Text, to: string): ChangeSet {
  const current = from.toString()
  const changes = textDiff(current, to).map((c) => ({ from: c.fromA, to: c.toA, insert: to.slice(c.fromB, c.toB) }))
  return ChangeSet.of(changes, from.length)
}

export async function reloadDocument(path: string, opts: { flash?: boolean; force?: boolean } = {}): Promise<void> {
  const entry = docs.get(docKey(path))
  if (!entry) return
  let file
  try {
    file = await readFile(entry.path)
  } catch {
    return
  }
  const { text, eol } = normalizeContent(file.content)
  entry.eol = eol
  entry.bom = file.bom
  entry.mtime = file.mtime
  publishMeta(entry)
  const key = docKey(entry.path)
  const dirty = !!useDocs.getState().dirty[key]
  if (dirty && !opts.force) {
    if (entry.state.doc.toString() === text) {
      entry.saved = entry.state.doc
      refreshDirty(entry)
      return
    }
    setFlag("conflicts", key, true)
    return
  }
  const before = entry.state.doc
  if (before.toString() === text) {
    entry.saved = before
    refreshDirty(entry)
    return
  }
  const changes = minimalChanges(before, text)
  dispatchToDoc(entry.path, {
    changes,
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  })
  const updated = docs.get(key)
  if (!updated) return
  updated.saved = updated.state.doc
  refreshDirty(updated)
  setFlag("conflicts", key, false)
  if (opts.flash) {
    dispatchToDoc(updated.path, { effects: flashRanges.of(changedRangesInB(before, updated.state.doc)) })
    setTimeout(() => dispatchToDoc(updated.path, { effects: clearFlash.of(null) }), FLASH_MS)
  }
  void loadBlame(updated.path)
}

export async function handleExternalChange(path: string): Promise<void> {
  const entry = docs.get(docKey(path))
  if (!entry) return
  const info = await stat(entry.path).catch(() => null)
  if (!info) return
  if (!info.exists) {
    setFlag("conflicts", docKey(entry.path), false)
    return
  }
  if (info.mtime === entry.mtime) return
  await reloadDocument(entry.path, { flash: true })
}

export function discardAndReload(path: string): Promise<void> {
  return reloadDocument(path, { force: true, flash: true })
}

export function keepMine(path: string): void {
  setFlag("conflicts", docKey(path), false)
}

export function closeDocument(path: string): void {
  const key = docKey(path)
  docs.delete(key)
  setFlag("dirty", key, false)
  setFlag("conflicts", key, false)
  useDocs.setState((s) => {
    if (!(key in s.meta)) return {}
    const meta = { ...s.meta }
    delete meta[key]
    return { meta }
  })
}

export function renameDocument(from: string, to: string): void {
  const entry = docs.get(docKey(from))
  if (!entry) return
  docs.delete(docKey(from))
  entry.path = normalizePath(to)
  docs.set(docKey(to), entry)
  publishMeta(entry)
}

export async function loadGitDecorations(path: string): Promise<void> {
  await Promise.all([loadGitBase(path), loadBlame(path)])
}

async function loadGitBase(path: string): Promise<void> {
  const repo = repoForPath(path)
  if (!repo) return
  const status = statusEntryFor(path)
  if (status && status.entry.index === "?" && status.entry.worktree === "?") {
    dispatchToDoc(path, { effects: setGitBase.of(null) })
    return
  }
  try {
    const base = await gitShowFile(repo, "HEAD", relativePath(repo, path))
    dispatchToDoc(path, { effects: setGitBase.of(base) })
  } catch {
    dispatchToDoc(path, { effects: setGitBase.of(null) })
  }
}

async function loadBlame(path: string): Promise<void> {
  const repo = repoForPath(path)
  const entry = docs.get(docKey(path))
  if (!repo || !entry) return
  const status = statusEntryFor(path)
  if (status && status.entry.index === "?" && status.entry.worktree === "?") {
    dispatchToDoc(path, { effects: setBlame.of(null) })
    return
  }
  try {
    const dirty = !!useDocs.getState().dirty[docKey(path)]
    const contents = dirty ? entry.state.doc.toString() : undefined
    const lines = await gitBlame(repo, relativePath(repo, path), contents)
    dispatchToDoc(path, { effects: setBlame.of(lines) })
  } catch {
    dispatchToDoc(path, { effects: setBlame.of(null) })
  }
}

export function refreshAllGitDecorations(): void {
  for (const entry of docs.values()) void loadGitDecorations(entry.path)
}

export function openDocumentPaths(): string[] {
  return [...docs.values()].map((d) => d.path)
}

export function docText(path: string): string | null {
  return docs.get(docKey(path))?.state.doc.toString() ?? null
}
