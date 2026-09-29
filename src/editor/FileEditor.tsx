import { useEffect, useMemo, useRef, useState } from "react"
import { EditorView } from "@codemirror/view"
import type { Text } from "@codemirror/state"
import { setDiagnostics, type Diagnostic } from "@codemirror/lint"
import { openPath } from "@tauri-apps/plugin-opener"
import {
  attachView,
  BinaryFileError,
  detachView,
  discardAndReload,
  docKey,
  keepMine,
  loadDocument,
  onViewTransaction,
  useDocs,
} from "./documents"
import { goToLine, setActiveCode } from "./bridge"
import { consumeReveal, openEditor, tabId, useEditors } from "../state/editors"
import { repoForPath } from "../state/git"
import { useProject } from "../state/project"
import { revealInExplorer } from "../state/explorer"
import { useLayout } from "../state/layout"
import { findingsForPath, useAiReview, type Finding } from "../state/aiReview"
import { imageDataUrl, isRasterImage } from "../lib/files"
import { readBase64 } from "../lib/fs"
import { relativePath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { Icon, Spinner } from "../components/ui"

const DIAGNOSTIC_SEVERITY: Record<Finding["severity"], Diagnostic["severity"]> = { alta: "error", media: "warning", baja: "info" }

function toDiagnostics(doc: Text, findings: Finding[]): Diagnostic[] {
  return findings
    .filter((f) => f.line !== null)
    .map((f) => {
      const line = doc.line(Math.min(Math.max(1, f.line ?? 1), doc.lines))
      return {
        from: line.from,
        to: line.to,
        severity: DIAGNOSTIC_SEVERITY[f.severity],
        source: "Revisión IA",
        message: f.detail ? `${f.title}\n\n${f.detail}` : f.title,
      }
    })
}

function publishCursor(view: EditorView) {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  useDocs.setState({
    cursor: {
      line: line.number,
      column: sel.head - line.from + 1,
      selected: view.state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0),
      selections: view.state.selection.ranges.length,
    },
  })
}

function Breadcrumbs({ path }: { path: string }) {
  const root = useProject((s) => s.root)
  const rel = root ? relativePath(root, path) : path
  const parts = rel.split("/")
  return (
    <div className="breadcrumbs">
      {parts.map((p, i) => (
        <span key={i} className="crumb">
          {i > 0 && <Icon name="chevron-right" className="crumb-sep" />}
          <button
            type="button"
            onClick={() => {
              useLayout.getState().showView("explorer", false)
              void revealInExplorer(path)
            }}
          >
            {p}
          </button>
        </span>
      ))}
    </div>
  )
}

function ImagePreview({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    readBase64(path)
      .then((b64) => !cancelled && setSrc(imageDataUrl(path, b64)))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [path])
  return (
    <div className="image-preview" onWheel={(e) => e.ctrlKey && setZoom((z) => Math.min(8, Math.max(0.1, z * (e.deltaY < 0 ? 1.1 : 0.9))))}>
      {error && <div className="editor-message">{error}</div>}
      {!src && !error && <Spinner />}
      {src && <img src={src} alt="" style={{ transform: `scale(${zoom})` }} />}
      <div className="image-zoom">{Math.round(zoom * 100)}% · Ctrl+rueda para zoom</div>
    </div>
  )
}

export function FileEditor({ groupId, path, visible }: { groupId: string; path: string | null; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const currentPath = useRef<string | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "binary" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  const focusNonce = useEditors((s) => s.focusNonce)
  const activeGroupId = useEditors((s) => s.activeGroupId)
  const reveal = useEditors((s) => s.reveal)
  const conflict = useDocs((s) => (path ? !!s.conflicts[docKey(path)] : false))
  const image = path ? isRasterImage(path) : false

  useEffect(() => {
    const view = new EditorView({
      parent: containerRef.current!,
      dispatchTransactions: (trs, v) => {
        v.update(trs)
        const p = currentPath.current
        if (!p) return
        const docChanged = trs.some((t) => t.docChanged)
        onViewTransaction(p, v.state, docChanged)
        if (docChanged || trs.some((t) => t.selection)) publishCursor(v)
      },
    })
    viewRef.current = view
    const onFocus = () => {
      setActiveCode(currentPath.current, view)
      publishCursor(view)
    }
    view.contentDOM.addEventListener("focus", onFocus)
    return () => {
      view.contentDOM.removeEventListener("focus", onFocus)
      detachView(view)
      setActiveCode(null, null)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!path || image) {
      detachView(view)
      currentPath.current = null
      setStatus("idle")
      return
    }
    let cancelled = false
    setStatus((s) => (s === "ready" && currentPath.current === path ? s : "loading"))
    loadDocument(path)
      .then(() => {
        if (cancelled || !viewRef.current) return
        const state = attachView(path, view)
        if (!state) return
        currentPath.current = path
        if (view.state !== state) view.setState(state)
        setActiveCode(path, view)
        publishCursor(view)
        setStatus("ready")
        const r = consumeReveal(tabId({ kind: "file", path }))
        if (r) requestAnimationFrame(() => goToLine(view, r.line, r.column, r.endLine, r.endColumn))
        else if (useEditors.getState().activeGroupId === groupId) requestAnimationFrame(() => view.focus())
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof BinaryFileError) setStatus("binary")
        else {
          setError(errorMessage(e))
          setStatus("error")
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, image, groupId])

  const reviewRuns = useAiReview((s) => s.runs)
  const dismissedFindings = useAiReview((s) => s.dismissed)
  const findings = useMemo(
    () => (path ? findingsForPath(reviewRuns, dismissedFindings, path) : []),
    [reviewRuns, dismissedFindings, path],
  )
  const diagnosed = useRef(new Set<string>())

  useEffect(() => {
    const view = viewRef.current
    if (!view || !path || status !== "ready") return
    const key = path.toLowerCase()
    if (findings.length === 0 && !diagnosed.current.has(key)) return
    if (findings.length > 0) diagnosed.current.add(key)
    else diagnosed.current.delete(key)
    view.dispatch(setDiagnostics(view.state, toDiagnostics(view.state.doc, findings)))
  }, [findings, path, status])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !path || status !== "ready" || !reveal) return
    if (reveal.tabId !== tabId({ kind: "file", path })) return
    const r = consumeReveal(reveal.tabId)
    if (r) requestAnimationFrame(() => goToLine(view, r.line, r.column, r.endLine, r.endColumn))
  }, [reveal, path, status])

  useEffect(() => {
    if (!visible || activeGroupId !== groupId || status !== "ready") return
    const view = viewRef.current
    if (view && !view.hasFocus) requestAnimationFrame(() => view.focus())
  }, [focusNonce, visible, activeGroupId, groupId, status])

  const repo = path ? repoForPath(path) : null
  const root = useProject((s) => s.root)

  return (
    <div className="file-editor" style={{ display: visible ? "flex" : "none" }}>
      {path && <Breadcrumbs path={path} />}
      {conflict && path && (
        <div className="editor-banner warning">
          <Icon name="warning" />
          <span>El archivo cambió en disco mientras tenías cambios sin guardar (probablemente lo editó el agente).</span>
          {repo && (
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => openEditor({ kind: "diff", repo, path: relativePath(repo, path), staged: false })}
            >
              Ver diff con git
            </button>
          )}
          <button type="button" className="btn btn-xs btn-primary" onClick={() => void discardAndReload(path)}>
            Usar la versión del disco
          </button>
          <button type="button" className="btn btn-xs" onClick={() => keepMine(path)}>
            Mantener la mía
          </button>
        </div>
      )}
      <div className="file-editor-body">
        <div ref={containerRef} className="cm-host" style={{ visibility: status === "ready" ? "visible" : "hidden" }} />
        {image && path && <ImagePreview path={path} />}
        {status === "loading" && (
          <div className="editor-overlay">
            <Spinner />
          </div>
        )}
        {status === "binary" && path && (
          <div className="editor-overlay">
            <div className="editor-message">
              <Icon name="file-binary" />
              <p>Es un archivo binario, no se puede mostrar como texto.</p>
              <button type="button" className="btn btn-sm" onClick={() => void openPath(path)}>
                Abrir con la app del sistema
              </button>
            </div>
          </div>
        )}
        {status === "error" && (
          <div className="editor-overlay">
            <div className="editor-message">
              <Icon name="error" />
              <p>{error}</p>
              {root && path && <code>{relativePath(root, path)}</code>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
