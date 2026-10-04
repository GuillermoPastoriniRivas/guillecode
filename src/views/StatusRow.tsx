import {
  decorationLetter,
  decorationOf,
  gitDiscard,
  gitStage,
  gitUnstage,
  isConflict,
  isUntracked,
  type StatusEntry,
} from "../lib/git"
import { basename, dirname, joinPath } from "../lib/paths"
import { gitAction } from "../state/git"
import { openEditor, openFile } from "../state/editors"
import { addContext, focusComposer } from "../state/agent"
import { useLayout } from "../state/layout"
import { reloadDocument } from "../editor/documents"
import { revealInExplorer } from "../state/explorer"
import { openContextMenu } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { FileIcon, Icon, IconButton } from "../components/ui"

export function StatusRow({
  repo,
  entry,
  staged,
}: {
  repo: string
  entry: StatusEntry
  staged: boolean
}) {
  const decoration = decorationOf(entry)
  const isDir = entry.path.endsWith("/")
  const cleanPath = isDir ? entry.path.slice(0, -1) : entry.path
  const abs = joinPath(repo, cleanPath)
  const untracked = isUntracked(entry)
  const deleted = (staged ? entry.index : entry.worktree) === "D"
  const open = () => {
    if (isDir) {
      useLayout.getState().showView("explorer", false)
      void revealInExplorer(abs)
    } else if (isConflict(entry)) openFile(abs)
    else openEditor({ kind: "diff", repo, path: entry.path, staged }, { preview: true })
  }

  const discard = async () => {
    const ok = await confirmAction(
      untracked ? `¿Borrar ${basename(entry.path)}?` : `¿Descartar los cambios de ${basename(entry.path)}?`,
      untracked ? "Es un archivo nuevo sin trackear: va a la papelera." : "Se pierden los cambios sin stage de este archivo.",
      untracked ? "Borrar" : "Descartar",
      true,
    )
    if (!ok) return
    await gitAction("No se pudo descartar", () => gitDiscard(repo, untracked ? [] : [entry.path], untracked ? [entry.path] : []))
    await reloadDocument(abs, { force: true })
  }

  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: isDir ? "Mostrar en el explorador" : "Ver cambios", icon: isDir ? "files" : "diff", run: open },
      { label: "Abrir archivo", icon: "go-to-file", disabled: deleted || isDir, run: () => openFile(abs) },
      {
        label: "Preguntarle al agente por este cambio",
        icon: "sparkle",
        run: () => {
          addContext({ kind: "file", path: abs })
          useLayout.getState().toggleAgent(true)
          focusComposer(`Revisá los cambios sin commitear de ${entry.path} (usá git diff) y decime si ves algún problema.`)
        },
      },
      { separator: true },
      staged
        ? { label: "Sacar del stage", icon: "remove", run: () => void gitAction("No se pudo sacar del stage", () => gitUnstage(repo, [entry.path])) }
        : { label: "Pasar al stage", icon: "add", run: () => void gitAction("No se pudo pasar al stage", () => gitStage(repo, [entry.path])) },
      ...(!staged ? [{ label: "Descartar cambios", icon: "discard", danger: true, run: () => void discard() }] : []),
    ])

  return (
    <div
      className={`scm-row git-${decoration}`}
      onClick={open}
      onDoubleClick={() => !deleted && !isDir && openFile(abs)}
      onContextMenu={menu}
      title={`${entry.path}${entry.orig ? ` (antes ${entry.orig})` : ""}`}
    >
      {isDir ? <Icon name="folder" className="tree-folder-icon" /> : <FileIcon path={entry.path} />}
      <span className={`scm-name${deleted ? " deleted" : ""}`}>
        {basename(cleanPath)}
        {isDir ? "/" : ""}
      </span>
      <span className="scm-dir">{dirname(cleanPath) === cleanPath ? "" : dirname(cleanPath)}</span>
      <span className="scm-actions" onClick={(e) => e.stopPropagation()}>
        {!deleted && !isDir && <IconButton icon="go-to-file" title="Abrir archivo" onClick={() => openFile(abs)} />}
        {!staged && <IconButton icon="discard" title="Descartar cambios" onClick={() => void discard()} />}
        {staged ? (
          <IconButton icon="remove" title="Sacar del stage" onClick={() => void gitAction("No se pudo sacar del stage", () => gitUnstage(repo, [entry.path]))} />
        ) : (
          <IconButton icon="add" title="Pasar al stage" onClick={() => void gitAction("No se pudo pasar al stage", () => gitStage(repo, [entry.path]))} />
        )}
      </span>
      <span className="scm-letter">{decorationLetter(decoration)}</span>
    </div>
  )
}
