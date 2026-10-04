import { useCallback, useEffect, useState } from "react"
import { DiffView, hunkPatch, type HunkInfo } from "./DiffView"
import { docText, isDirty, reloadDocument } from "./documents"
import { gitApplyPatch, gitShowFile, gitStage, gitUnstage, gitDiscard, isUntracked } from "../lib/git"
import { readFile, writeFile } from "../lib/fs"
import { isRasterImage } from "../lib/files"
import { fileImageDataUrl, gitImageDataUrl } from "../lib/imageData"
import { joinPath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { gitAction, refreshRepo, useGit } from "../state/git"
import { openFile } from "../state/editors"
import { notify } from "../state/toasts"
import { closeTab } from "./tabs"
import { confirmAction } from "../components/Dialog"
import { FileIcon, Icon, Spinner } from "../components/ui"
import { ImageDiff } from "../components/ImageDiff"

type Loaded = { original: string; modified: string; editable: boolean; bom: boolean; eol: "\n" | "\r\n" }

type ImageLoaded = { before: string | null; after: string | null; noteA: string; noteB: string }

async function showOrEmpty(repo: string, rev: string, path: string): Promise<string> {
  try {
    return await gitShowFile(repo, rev, path)
  } catch {
    return ""
  }
}

function normalize(text: string): { text: string; eol: "\n" | "\r\n" } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return { text: eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text, eol }
}

export function GitDiffEditor({ repo, path, staged, tabId }: { repo: string; path: string; staged: boolean; tabId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [image, setImage] = useState<ImageLoaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const revision = useGit((s) => s.revision)
  const entry = useGit((s) => s.byRepo[repo]?.status?.entries.find((e) => e.path === path))
  const abs = joinPath(repo, path)
  const raster = isRasterImage(path)

  const load = useCallback(async () => {
    try {
      if (raster) {
        if (staged) {
          const [before, after] = await Promise.all([gitImageDataUrl(repo, "HEAD", path), gitImageDataUrl(repo, "", path)])
          setImage({
            before,
            after,
            noteA: before ? "" : "Sin versión anterior (archivo nuevo)",
            noteB: after ? "" : "Sin versión nueva (archivo eliminado)",
          })
          return
        }
        const untracked = entry ? isUntracked(entry) : false
        const before = untracked ? null : await gitImageDataUrl(repo, "", path)
        const deleted = entry?.worktree === "D"
        const after = deleted ? null : await fileImageDataUrl(abs, path)
        setImage({
          before,
          after,
          noteA: before ? "" : "Sin versión anterior (archivo nuevo)",
          noteB: after ? "" : "Sin versión nueva (archivo eliminado)",
        })
        return
      }
      if (staged) {
        const [head, index] = await Promise.all([showOrEmpty(repo, "HEAD", path), showOrEmpty(repo, "", path)])
        setData({ original: normalize(head).text, modified: normalize(index).text, editable: false, bom: false, eol: "\n" })
        return
      }
      const untracked = entry ? isUntracked(entry) : false
      const index = untracked ? "" : await showOrEmpty(repo, "", path)
      let working = ""
      let bom = false
      let eol: "\n" | "\r\n" = "\n"
      const deleted = entry?.worktree === "D"
      if (!deleted) {
        const dirtyText = isDirty(abs) ? docText(abs) : null
        if (dirtyText !== null) working = dirtyText
        else {
          const file = await readFile(abs)
          const n = normalize(file.content)
          working = n.text
          eol = n.eol
          bom = file.bom
        }
      }
      setData({ original: normalize(index).text, modified: working, editable: !deleted && !isDirty(abs), bom, eol })
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [repo, path, staged, abs, entry, raster])

  useEffect(() => {
    void load()
  }, [load, revision])

  const onSave = async (text: string) => {
    if (!data) return
    await writeFile(abs, data.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text, data.bom)
    await reloadDocument(abs)
    notify.success("Guardado")
  }

  const onStageHunk = async (hunk: HunkInfo) => {
    try {
      await gitApplyPatch(repo, hunkPatch(path, hunk), true, false)
      notify.success("Hunk agregado al stage")
    } catch (e) {
      notify.error("No se pudo pasar el hunk al stage", errorMessage(e))
    } finally {
      await refreshRepo(repo)
    }
  }

  const header = (
    <>
      <FileIcon path={path} />
      <span className="diff-title">{path}</span>
      <span className={`diff-kind ${staged ? "staged" : "working"}`}>{staged ? "Staged vs HEAD" : "Cambios vs index"}</span>
      <button type="button" className="btn btn-xs" onClick={() => openFile(abs)}>
        <Icon name="go-to-file" /> Abrir archivo
      </button>
      {staged ? (
        <button type="button" className="btn btn-xs" onClick={() => void gitAction("No se pudo sacar del stage", () => gitUnstage(repo, [path]))}>
          <Icon name="remove" /> Sacar del stage
        </button>
      ) : (
        <>
          <button type="button" className="btn btn-xs" onClick={() => void gitAction("No se pudo pasar al stage", () => gitStage(repo, [path]))}>
            <Icon name="add" /> Stage del archivo
          </button>
          <button
            type="button"
            className="btn btn-xs btn-ghost-danger"
            onClick={async () => {
              const ok = await confirmAction("Descartar cambios", `Se pierden todos los cambios sin stage de ${path}.`, "Descartar", true)
              if (!ok) return
              const untracked = entry ? isUntracked(entry) : false
              await gitAction("No se pudieron descartar los cambios", () =>
                gitDiscard(repo, untracked ? [] : [path], untracked ? [path] : []),
              )
              await reloadDocument(abs, { force: true })
              if (untracked) void closeTab(tabId)
            }}
          >
            <Icon name="discard" /> Descartar
          </button>
        </>
      )}
    </>
  )

  if (error) return <div className="editor-message center">{error}</div>
  if (raster) {
    if (!image)
      return (
        <div className="editor-overlay">
          <Spinner />
        </div>
      )
    return (
      <ImageDiff
        path={path}
        before={image.before}
        after={image.after}
        labelA={staged ? "HEAD" : "Index (stage)"}
        labelB={staged ? "Stage" : "Working tree"}
        noteA={image.noteA}
        noteB={image.noteB}
        header={header}
      />
    )
  }
  if (!data)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )
  return (
    <DiffView
      path={path}
      original={data.original}
      modified={data.modified}
      editable={data.editable}
      header={header}
      onSave={data.editable ? onSave : undefined}
      onStageHunk={!staged ? onStageHunk : undefined}
      labelA={staged ? "HEAD" : "Index (stage)"}
      labelB={staged ? "Stage" : "Working tree"}
    />
  )
}

export function CommitFileEditor({
  repo,
  hash,
  parent,
  path,
  orig,
  label,
}: {
  repo: string
  hash: string
  parent: string
  path: string
  orig: string | null
  label?: string
}) {
  const [data, setData] = useState<{ a: string; b: string } | null>(null)
  const [image, setImage] = useState<{ before: string | null; after: string | null } | null>(null)
  const raster = isRasterImage(path)
  useEffect(() => {
    let cancelled = false
    if (raster) {
      void Promise.all([gitImageDataUrl(repo, parent, orig ?? path), gitImageDataUrl(repo, hash, path)]).then(([before, after]) => {
        if (!cancelled) setImage({ before, after })
      })
      return () => {
        cancelled = true
      }
    }
    void Promise.all([showOrEmpty(repo, parent, orig ?? path), showOrEmpty(repo, hash, path)]).then(([a, b]) => {
      if (!cancelled) setData({ a: normalize(a).text, b: normalize(b).text })
    })
    return () => {
      cancelled = true
    }
  }, [repo, hash, parent, path, orig, raster])
  const header = (
    <>
      <FileIcon path={path} />
      <span className="diff-title">{path}</span>
      <span className="diff-kind">{label ?? `commit ${hash.slice(0, 7)}`}</span>
      <button type="button" className="btn btn-xs" onClick={() => openFile(joinPath(repo, path))}>
        <Icon name="go-to-file" /> Abrir versión actual
      </button>
    </>
  )
  if (raster) {
    if (!image)
      return (
        <div className="editor-overlay">
          <Spinner />
        </div>
      )
    return (
      <ImageDiff
        path={path}
        before={image.before}
        after={image.after}
        labelA={`${parent.slice(0, 7)}${orig ? ` · ${orig}` : ""}`}
        labelB={hash.slice(0, 7)}
        noteA="Sin versión anterior (archivo nuevo)"
        noteB="Sin versión nueva (archivo eliminado)"
        header={header}
      />
    )
  }
  if (!data)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )
  return (
    <DiffView
      path={path}
      original={data.a}
      modified={data.b}
      editable={false}
      labelA={`${parent.slice(0, 7)}${orig ? ` · ${orig}` : ""}`}
      labelB={hash.slice(0, 7)}
      header={header}
    />
  )
}
