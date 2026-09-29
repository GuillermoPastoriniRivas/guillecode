import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EditorView } from "@codemirror/view"
import { unifiedMergeView, getChunks, goToNextChunk, goToPreviousChunk } from "@codemirror/merge"
import type { Message } from "@opencode-ai/sdk"
import { client } from "../lib/opencode"
import { deletePaths, readFile, writeFile } from "../lib/fs"
import { reconstructSides } from "../lib/diff"
import { isRasterImage } from "../lib/files"
import { fileImageDataUrl } from "../lib/imageData"
import { basename, dirname, joinPath, relativePath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { useProject } from "../state/project"
import { useAgent, addContext, focusComposer } from "../state/agent"
import { openFile } from "../state/editors"
import { useLayout } from "../state/layout"
import { notify } from "../state/toasts"
import { docText, isDirty, reloadDocument } from "./documents"
import { viewerExtensions } from "./cm/readonly"
import { languageFor } from "./cm/setup"
import { setCustomSaver } from "./bridge"
import { confirmAction } from "../components/Dialog"
import { ImageDiff } from "../components/ImageDiff"
import { FileIcon, Icon, IconButton, Spinner, EmptyState } from "../components/ui"

type RoundDiff = { file: string; patch?: string; additions: number; deletions: number; status?: "added" | "deleted" | "modified" }

type FileReview = {
  rel: string
  abs: string
  patches: string[]
  firstStatus?: "added" | "deleted" | "modified"
  lastStatus?: "added" | "deleted" | "modified"
  additions: number
  deletions: number
}

function collect(messages: Array<{ info: Message }>, root: string): FileReview[] {
  const byFile = new Map<string, FileReview>()
  for (const m of messages) {
    const summary = (m.info as Message & { summary?: { diffs?: RoundDiff[] } }).summary
    if (m.info.role !== "user" || !summary?.diffs) continue
    for (const d of summary.diffs) {
      if (!d.file) continue
      const existing = byFile.get(d.file)
      if (existing) {
        if (d.patch) existing.patches.push(d.patch)
        existing.lastStatus = d.status
        existing.additions += d.additions
        existing.deletions += d.deletions
      } else {
        byFile.set(d.file, {
          rel: d.file,
          abs: joinPath(root, d.file),
          patches: d.patch ? [d.patch] : [],
          firstStatus: d.status,
          lastStatus: d.status,
          additions: d.additions,
          deletions: d.deletions,
        })
      }
    }
  }
  return [...byFile.values()].sort((a, b) => a.rel.localeCompare(b.rel))
}

type Sides = { before: string; after: string; exact: boolean; eol: "\n" | "\r\n"; bom: boolean; exists: boolean }

async function loadSides(file: FileReview): Promise<Sides | null> {
  let current: string | null = null
  let eol: "\n" | "\r\n" = "\n"
  let bom = false
  let exists = true
  const dirtyText = isDirty(file.abs) ? docText(file.abs) : null
  if (dirtyText !== null) current = dirtyText
  else {
    try {
      const f = await readFile(file.abs)
      eol = f.content.includes("\r\n") ? "\r\n" : "\n"
      bom = f.bom
      current = f.content.replace(/\r\n/g, "\n")
    } catch {
      exists = false
      current = null
    }
  }
  const sides = reconstructSides(
    file.patches.map((p) => p.replace(/\r\n/g, "\n")),
    current,
    file.firstStatus,
    exists ? file.lastStatus === "deleted" ? "modified" : file.lastStatus : "deleted",
  )
  if (!sides) return null
  return { ...sides, eol, bom, exists }
}

function ReviewFile({ file, onReviewed, reviewed }: { file: FileReview; onReviewed: (v: boolean) => void; reviewed: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [sides, setSides] = useState<Sides | null | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [remaining, setRemaining] = useState(0)
  const savedRef = useRef("")
  const raster = isRasterImage(file.abs)
  const [img, setImg] = useState<string | null | undefined>(undefined)

  const reload = useCallback(() => {
    if (raster) return
    setSides(undefined)
    void loadSides(file).then(setSides)
  }, [file, raster])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (!raster) return
    setImg(undefined)
    void fileImageDataUrl(file.abs, file.rel).then(setImg)
  }, [raster, file.abs, file.rel])

  useEffect(() => {
    const el = host.current
    if (!el || !sides || raster) return
    let disposed = false
    savedRef.current = sides.after
    setDirty(false)
    const lang = languageFor(file.abs)
    void (lang ? lang.load() : Promise.resolve(null)).then((language) => {
      if (disposed) return
      const view = new EditorView({
        parent: el,
        doc: sides.after,
        extensions: [
          ...viewerExtensions({ editable: true, language }),
          unifiedMergeView({
            original: sides.before,
            mergeControls: true,
            highlightChanges: true,
            gutter: true,
            syntaxHighlightDeletions: true,
            collapseUnchanged: { margin: 4, minSize: 8 },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== savedRef.current)
            setRemaining(getChunks(u.state)?.chunks.length ?? 0)
          }),
        ],
      })
      viewRef.current = view
      setRemaining(getChunks(view.state)?.chunks.length ?? 0)
    })
    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
      el.innerHTML = ""
    }
  }, [sides, file.abs, raster])

  const save = useCallback(async () => {
    const view = viewRef.current
    if (!view || !sides) return
    const text = view.state.doc.toString()
    try {
      if (!text && sides.before === "" && file.firstStatus === "added") {
        const ok = await confirmAction("Eliminar archivo", `${file.rel} lo creó el agente. Rechazarlo entero lo borra (va a la papelera).`, "Eliminar", true)
        if (!ok) return
        await deletePaths([file.abs])
      } else {
        await writeFile(file.abs, sides.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text, sides.bom)
      }
      savedRef.current = text
      setDirty(false)
      await reloadDocument(file.abs, { flash: true })
      notify.success(`Guardado ${basename(file.rel)}`)
    } catch (e) {
      notify.error("No se pudo guardar", errorMessage(e))
    }
  }, [sides, file])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const focus = () => setCustomSaver(() => save())
    view.contentDOM.addEventListener("focus", focus)
    return () => {
      view.contentDOM.removeEventListener("focus", focus)
      setCustomSaver(null)
    }
  })

  const rejectAll = () => {
    const view = viewRef.current
    if (!view || !sides) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sides.before } })
  }

  const ask = () => {
    addContext({ kind: "file", path: file.abs })
    useLayout.getState().toggleAgent(true)
    focusComposer(`Sobre los cambios que hiciste en ${file.rel}: `)
  }

  return (
    <div className="review-file">
      <div className="review-file-toolbar">
        <FileIcon path={file.rel} />
        <span className="review-file-name">{basename(file.rel)}</span>
        <span className="review-file-dir">{dirname(file.rel) === file.rel ? "" : dirname(file.rel)}</span>
        {sides && !sides.exact && <span className="warn-pill" title="No se pudo reconstruir exacto el estado previo">aprox.</span>}
        <span className="toolbar-spacer" />
        {!raster && (
          <>
            <span className="toolbar-note">{remaining} cambio{remaining === 1 ? "" : "s"} pendiente{remaining === 1 ? "" : "s"}</span>
            <IconButton icon="arrow-up" title="Cambio anterior" onClick={() => viewRef.current && goToPreviousChunk(viewRef.current)} />
            <IconButton icon="arrow-down" title="Cambio siguiente" onClick={() => viewRef.current && goToNextChunk(viewRef.current)} />
          </>
        )}
        <button type="button" className="btn btn-xs" onClick={ask}>
          <Icon name="comment-discussion" /> Preguntar
        </button>
        <button type="button" className="btn btn-xs" onClick={() => openFile(file.abs)}>
          <Icon name="go-to-file" /> Abrir
        </button>
        {!raster && (
          <>
            <button type="button" className="btn btn-xs btn-ghost-danger" onClick={rejectAll} disabled={!sides}>
              <Icon name="discard" /> Rechazar todo
            </button>
            <button type="button" className={`btn btn-xs${dirty ? " btn-primary" : ""}`} disabled={!dirty} onClick={() => void save()}>
              <Icon name="save" /> Guardar
            </button>
          </>
        )}
        <button
          type="button"
          className={`btn btn-xs${reviewed ? " btn-success" : ""}`}
          onClick={() => onReviewed(!reviewed)}
          title="Marcar como revisado"
        >
          <Icon name={reviewed ? "pass-filled" : "circle-large-outline"} /> {reviewed ? "Revisado" : "Aprobar"}
        </button>
      </div>
      {!raster && (
        <div className="review-hint">
          Cada bloque tiene <strong>Accept</strong> / <strong>Reject</strong>. Rechazar vuelve ese bloque a como estaba antes del agente; después guardá.
        </div>
      )}
      <div className="review-file-body">
        {raster ? (
          img === undefined ? (
            <div className="editor-overlay">
              <Spinner />
            </div>
          ) : (
            <ImageDiff
              path={file.rel}
              before={null}
              after={img}
              labelA="Antes del agente"
              labelB="Ahora"
              noteA="El diff del agente no guarda la imagen previa; usá el historial de git para compararla."
              noteB="No se encontró la imagen en disco."
            />
          )
        ) : (
          <>
            {sides === undefined && (
              <div className="editor-overlay">
                <Spinner />
              </div>
            )}
            {sides === null && (
              <div className="editor-message center">
                No pude reconstruir el estado previo de este archivo (cambió mucho después del agente).
              </div>
            )}
            <div ref={host} className="merge-host unified" />
          </>
        )}
      </div>
    </div>
  )
}

export function ReviewEditor({ sessionId }: { sessionId: string }) {
  const root = useProject((s) => s.root)
  const session = useAgent((s) => s.sessions.find((x) => x.id === sessionId))
  const status = useAgent((s) => s.statuses[sessionId]?.type ?? "idle")
  const connected = useAgent((s) => s.connected)
  const [files, setFiles] = useState<FileReview[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<Record<string, boolean>>(() => loadJson(`review.${sessionId}`, {}))

  const load = useCallback(async () => {
    if (!root) return
    try {
      const res = await client.session.messages({ path: { id: sessionId }, throwOnError: true })
      const list = collect((res.data ?? []) as Array<{ info: Message }>, root)
      setError(null)
      setFiles(list)
      setSelected((cur) => (cur && list.some((f) => f.rel === cur) ? cur : (list[0]?.rel ?? null)))
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [root, sessionId])

  useEffect(() => {
    if (connected && status === "idle") void load()
  }, [load, status, connected])

  const markReviewed = (rel: string, value: boolean) => {
    setReviewed((prev) => {
      const next = { ...prev, [rel]: value }
      saveJson(`review.${sessionId}`, next)
      return next
    })
    if (value && files) {
      const index = files.findIndex((f) => f.rel === rel)
      const nextFile = files.slice(index + 1).find((f) => !reviewed[f.rel]) ?? files.find((f) => !reviewed[f.rel] && f.rel !== rel)
      if (nextFile) setSelected(nextFile.rel)
    }
  }

  const current = useMemo(() => files?.find((f) => f.rel === selected) ?? null, [files, selected])
  const done = files ? files.filter((f) => reviewed[f.rel]).length : 0

  if (error)
    return (
      <EmptyState
        icon="debug-disconnect"
        title="No se pudo leer la sesión"
        action={
          <button type="button" className="btn btn-primary" onClick={() => void load()}>
            Reintentar
          </button>
        }
      >
        {connected ? error : "Esperando a opencode… se reintenta solo al reconectar."}
      </EmptyState>
    )
  if (!files)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )
  if (files.length === 0)
    return (
      <EmptyState icon="diff-multiple" title="Esta sesión todavía no cambió archivos">
        Cuando el agente edite algo, acá lo revisás hunk por hunk.
      </EmptyState>
    )

  return (
    <div className="review-editor">
      <aside className="review-sidebar">
        <div className="review-sidebar-head">
          <div className="review-session" title={session?.title}>
            <Icon name="hubot" /> {session?.title || "Sesión"}
          </div>
          <div className="review-progress">
            <span className="review-progress-bar" style={{ width: `${(done / files.length) * 100}%` }} />
          </div>
          <div className="review-progress-label">
            {done}/{files.length} revisados
            {status === "busy" && (
              <span className="review-live">
                <Spinner size={10} /> el agente sigue trabajando
              </span>
            )}
          </div>
        </div>
        <div className="review-files">
          {files.map((f) => (
            <button
              key={f.rel}
              type="button"
              className={`review-file-row${f.rel === selected ? " selected" : ""}${reviewed[f.rel] ? " reviewed" : ""}`}
              onClick={() => setSelected(f.rel)}
              title={root ? relativePath(root, f.abs) : f.rel}
            >
              <Icon name={reviewed[f.rel] ? "pass-filled" : "circle-large-outline"} className="review-check" />
              <FileIcon path={f.rel} />
              <span className="review-file-label">
                <span>{basename(f.rel)}</span>
                <em>{dirname(f.rel) === f.rel ? "" : dirname(f.rel)}</em>
              </span>
              <span className={`review-status ${f.firstStatus === "added" ? "added" : f.lastStatus === "deleted" ? "deleted" : "modified"}`}>
                {f.firstStatus === "added" ? "A" : f.lastStatus === "deleted" ? "D" : "M"}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="review-main">
        {current ? (
          <ReviewFile key={current.rel} file={current} reviewed={!!reviewed[current.rel]} onReviewed={(v) => markReviewed(current.rel, v)} />
        ) : (
          <EmptyState icon="diff" title="Elegí un archivo" />
        )}
      </section>
    </div>
  )
}
