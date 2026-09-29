import { useMemo, useState } from "react"
import { create } from "zustand"
import {
  decorationLetter,
  decorationOf,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitFetch,
  gitPull,
  gitPush,
  gitStage,
  gitStageAll,
  gitStash,
  gitUnstage,
  gitUnstageAll,
  hasStaged,
  hasUnstaged,
  isConflict,
  isUntracked,
  type StatusEntry,
} from "../lib/git"
import { generateCommitMessage } from "../lib/ai"
import { basename, dirname, joinPath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { bumpHead, gitAction, refreshAllRepos, setActiveRepo, useGit } from "../state/git"
import { openEditor, openFile } from "../state/editors"
import { openAiReview } from "../state/aiReview"
import { pickOne, promptInput } from "../state/quickinput"
import { notify } from "../state/toasts"
import { addContext, focusComposer } from "../state/agent"
import { useLayout } from "../state/layout"
import { reloadDocument } from "../editor/documents"
import { revealInExplorer } from "../state/explorer"
import { openContextMenu, openMenuAt } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { EmptyState, FileIcon, Icon, IconButton, Section, Spinner } from "../components/ui"

const useCommitDraft = create<{ messages: Record<string, string> }>(() => ({ messages: {} }))

export async function pickBranch(repo: string): Promise<void> {
  let branches
  try {
    branches = await gitBranches(repo)
  } catch (e) {
    notify.error("No se pudieron listar las ramas", errorMessage(e))
    return
  }
  const localNames = new Set(branches.filter((b) => !b.remote).map((b) => b.name))
  const items = [
    { id: "__new__", label: "Crear rama nueva…", icon: "add" },
    ...branches
      .filter((b) => !b.remote)
      .map((b) => ({
        id: b.name,
        label: b.name,
        description: b.current ? "actual" : b.subject,
        icon: b.current ? "check" : "git-branch",
        group: "ramas locales",
      })),
    ...branches
      .filter((b) => b.remote && !localNames.has(b.name.split("/").slice(1).join("/")))
      .map((b) => ({ id: b.name, label: b.name, description: b.subject, icon: "cloud", group: "remotas" })),
  ]
  const choice = await pickOne(items, { title: "Cambiar de rama", placeholder: "Elegí o buscá una rama" })
  if (!choice) return
  if (choice.id === "__new__") {
    const name = await promptInput({
      title: "Nueva rama",
      placeholder: "nombre-de-la-rama",
      validate: (v) => (!v.trim() ? "Escribí un nombre" : /\s|\.\.|[~^:?*[\\]/.test(v) ? "Nombre inválido para git" : null),
    })
    if (!name) return
    await gitAction("No se pudo crear la rama", () => gitCheckout(repo, name.trim(), true), `Rama ${name.trim()} creada`)
    return
  }
  await gitAction("No se pudo cambiar de rama", () => gitCheckout(repo, choice.id), `Ahora en ${choice.id}`)
}

function StatusRow({
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
    } else openEditor({ kind: "diff", repo, path: entry.path, staged }, { preview: true })
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

export function ScmView() {
  const repos = useGit((s) => s.repos)
  const activeRepo = useGit((s) => s.activeRepo)
  const repoState = useGit((s) => (s.activeRepo ? s.byRepo[s.activeRepo] : undefined))
  const busy = useGit((s) => s.busy)
  const message = useCommitDraft((s) => (activeRepo ? (s.messages[activeRepo] ?? "") : ""))
  const [generating, setGenerating] = useState(false)
  const [open, setOpen] = useState({ conflicts: true, staged: true, changes: true })

  const status = repoState?.status ?? null
  const groups = useMemo(() => {
    const entries = status?.entries ?? []
    return {
      conflicts: entries.filter(isConflict),
      staged: entries.filter((e) => !isConflict(e) && hasStaged(e)),
      changes: entries.filter((e) => !isConflict(e) && hasUnstaged(e)),
    }
  }, [status])

  if (repos.length === 0 || !activeRepo)
    return (
      <div className="view">
        <div className="view-header">
          <span className="view-title">Control de código</span>
        </div>
        <EmptyState icon="source-control" title="La carpeta no es un repositorio git">
          Inicializá un repo con <code>git init</code> desde la terminal para ver los cambios acá.
        </EmptyState>
      </div>
    )

  const repo = activeRepo
  const setMessage = (value: string) => useCommitDraft.setState((s) => ({ messages: { ...s.messages, [repo]: value } }))

  const commit = async (mode: "commit" | "push" | "amend" | "all") => {
    let msg = message.trim()
    if (mode === "amend" && !msg) msg = ""
    if (!msg && mode !== "amend") {
      notify.warning("Escribí un mensaje de commit (o generalo con ✦)")
      return
    }
    if (mode === "all" || (groups.staged.length === 0 && mode !== "amend")) {
      if (groups.changes.length === 0) {
        notify.info("No hay cambios para commitear")
        return
      }
      if (mode !== "all") {
        const ok = await confirmAction("No hay nada en el stage", "¿Querés commitear todos los cambios?", "Commitear todo")
        if (!ok) return
      }
      await gitAction("No se pudo pasar al stage", () => gitStageAll(repo))
    }
    const hash = await gitAction(
      "No se pudo commitear",
      () => gitCommit(repo, msg || "amend", mode === "amend"),
      mode === "amend" ? "Commit enmendado" : "Commit creado",
    )
    if (!hash) return
    setMessage("")
    if (mode === "push") await gitAction("No se pudo hacer push", () => gitPush(repo), "Push listo")
  }

  const generate = async () => {
    setGenerating(true)
    try {
      if (groups.staged.length === 0 && groups.changes.length > 0) {
        await gitStageAll(repo)
        await refreshAllRepos()
      }
      setMessage(await generateCommitMessage(repo))
    } catch (e) {
      notify.error("No se pudo generar el mensaje", errorMessage(e))
    } finally {
      setGenerating(false)
    }
  }

  const sync = async () => {
    if (!status) return
    if (status.behind > 0) await gitAction("No se pudo hacer pull", () => gitPull(repo), "Pull listo")
    if (status.ahead > 0 || !status.upstream) await gitAction("No se pudo hacer push", () => gitPush(repo), "Push listo")
    if (status.behind === 0 && status.ahead === 0 && status.upstream) await gitAction("No se pudo actualizar", () => gitFetch(repo), "Actualizado")
  }

  const moreMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { label: "Pull", icon: "arrow-down", run: () => void gitAction("No se pudo hacer pull", () => gitPull(repo), "Pull listo") },
      { label: "Push", icon: "arrow-up", run: () => void gitAction("No se pudo hacer push", () => gitPush(repo), "Push listo") },
      {
        label: "Push forzado (with lease)",
        icon: "warning",
        run: async () => {
          if (await confirmAction("Push forzado", "Pisa la rama remota si nadie más la cambió.", "Forzar", true))
            await gitAction("No se pudo hacer push", () => gitPush(repo, true), "Push forzado listo")
        },
      },
      { label: "Fetch", icon: "sync", run: () => void gitAction("No se pudo hacer fetch", () => gitFetch(repo), "Fetch listo") },
      { separator: true },
      { label: "Commit y push", icon: "cloud-upload", run: () => void commit("push") },
      { label: "Commit de todo (incluye sin stage)", icon: "check-all", run: () => void commit("all") },
      { label: "Enmendar el último commit", icon: "edit", run: () => void commit("amend") },
      { separator: true },
      { label: "Guardar cambios en stash", icon: "archive", run: () => void gitAction("No se pudo hacer stash", () => gitStash(repo, false), "Cambios guardados en stash") },
      { label: "Recuperar el último stash", icon: "inbox", run: () => void gitAction("No se pudo aplicar el stash", () => gitStash(repo, true), "Stash aplicado") },
      { separator: true },
      { label: "Cambiar de rama…", icon: "git-branch", run: () => void pickBranch(repo) },
      { label: "Ver historial", icon: "git-commit", run: () => openEditor({ kind: "graph", repo }) },
      { label: "Crear pull request", icon: "git-pull-request-create", run: () => openEditor({ kind: "prCreate", repo }) },
    ])

  const stageAll = () => void gitAction("No se pudo pasar al stage", () => gitStageAll(repo))
  const unstageAll = () => void gitAction("No se pudo sacar del stage", () => gitUnstageAll(repo))
  const discardAll = async () => {
    const ok = await confirmAction("Descartar todos los cambios", `Se pierden los cambios sin stage de ${groups.changes.length} archivos (los nuevos van a la papelera).`, "Descartar todo", true)
    if (!ok) return
    const tracked = groups.changes.filter((e) => !isUntracked(e)).map((e) => e.path)
    const untracked = groups.changes.filter(isUntracked).map((e) => e.path)
    await gitAction("No se pudo descartar", () => gitDiscard(repo, tracked, untracked), "Cambios descartados")
  }

  return (
    <div className="view scm-view">
      <div className="view-header">
        <span className="view-title">Control de código</span>
        <span className="view-actions">
          {busy && <Spinner size={12} />}
          <IconButton
            icon="sparkle"
            title="Revisar los cambios con IA"
            onClick={() => openAiReview({ kind: "aiReview", repo, scope: "changes" })}
          />
          <IconButton icon="git-commit" title="Historial (grafo)" onClick={() => openEditor({ kind: "graph", repo })} />
          <IconButton
            icon="refresh"
            title="Refrescar"
            onClick={() => {
              bumpHead()
              void refreshAllRepos()
            }}
          />
          <IconButton icon="ellipsis" title="Más acciones" onClick={(e) => moreMenu(e.currentTarget)} />
        </span>
      </div>
      {repos.length > 1 && (
        <div className="scm-repos">
          {repos.map((r) => (
            <button key={r} type="button" className={`scm-repo${r === repo ? " active" : ""}`} onClick={() => setActiveRepo(r)} title={r}>
              <Icon name="repo" /> {basename(r)}
              {(useGit.getState().byRepo[r]?.status?.entries.length ?? 0) > 0 && (
                <span className="pane-count">{useGit.getState().byRepo[r]?.status?.entries.length}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {status && (
        <div className="scm-branch">
          <button type="button" className="scm-branch-name" onClick={() => void pickBranch(repo)} title="Cambiar de rama">
            <Icon name="git-branch" />
            <span>{status.detached ? "HEAD detached" : status.branch}</span>
          </button>
          <button type="button" className="scm-sync" onClick={() => void sync()} title={status.upstream ? `Sincronizar con ${status.upstream}` : "Publicar la rama"}>
            {status.upstream ? (
              <>
                <Icon name="sync" />
                {status.behind > 0 && <span>{status.behind}↓</span>}
                {status.ahead > 0 && <span>{status.ahead}↑</span>}
              </>
            ) : (
              <>
                <Icon name="cloud-upload" /> Publicar
              </>
            )}
          </button>
        </div>
      )}
      <div className="scm-commit">
        <div className="scm-message">
          <textarea
            placeholder={`Mensaje (Ctrl+Enter para commitear en "${status?.branch ?? ""}")`}
            value={message}
            rows={Math.min(8, Math.max(2, message.split("\n").length))}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault()
                void commit(e.shiftKey ? "push" : "commit")
              }
            }}
          />
          <button
            type="button"
            className="scm-generate"
            title="Generar el mensaje con IA a partir del stage"
            disabled={generating || (groups.staged.length === 0 && groups.changes.length === 0)}
            onClick={() => void generate()}
          >
            {generating ? <Spinner size={12} /> : <Icon name="sparkle" />}
          </button>
        </div>
        <div className="scm-commit-buttons">
          <button type="button" className="btn btn-primary scm-commit-main" disabled={!!busy} onClick={() => void commit("commit")}>
            <Icon name="check" /> Commit{groups.staged.length > 0 ? ` (${groups.staged.length})` : ""}
          </button>
          <button type="button" className="btn btn-primary scm-commit-more" onClick={(e) => moreMenu(e.currentTarget)} title="Más opciones de commit">
            <Icon name="chevron-down" />
          </button>
        </div>
      </div>
      {repoState?.error && <div className="view-error">{repoState.error}</div>}
      <div className="scm-sections">
        {groups.conflicts.length > 0 && (
          <Section title="Conflictos" count={groups.conflicts.length} open={open.conflicts} onToggle={() => setOpen((o) => ({ ...o, conflicts: !o.conflicts }))}>
            {groups.conflicts.map((e) => (
              <StatusRow key={`c-${e.path}`} repo={repo} entry={e} staged={false} />
            ))}
          </Section>
        )}
        {groups.staged.length > 0 && (
          <Section
            title="En el stage"
            count={groups.staged.length}
            open={open.staged}
            onToggle={() => setOpen((o) => ({ ...o, staged: !o.staged }))}
            actions={<IconButton icon="remove" title="Sacar todo del stage" disabled={!!busy} onClick={unstageAll} />}
          >
            {groups.staged.map((e) => (
              <StatusRow key={`s-${e.path}`} repo={repo} entry={e} staged />
            ))}
          </Section>
        )}
        <Section
          title="Cambios"
          count={groups.changes.length}
          open={open.changes}
          onToggle={() => setOpen((o) => ({ ...o, changes: !o.changes }))}
          actions={
            groups.changes.length > 0 ? (
              <>
                <IconButton icon="discard" title="Descartar todo" disabled={!!busy} onClick={() => void discardAll()} />
                <IconButton icon="add" title="Pasar todo al stage" disabled={!!busy} onClick={stageAll} />
              </>
            ) : undefined
          }
        >
          {groups.changes.map((e) => (
            <StatusRow key={`u-${e.path}`} repo={repo} entry={e} staged={false} />
          ))}
          {groups.changes.length === 0 && <div className="view-note">Sin cambios pendientes</div>}
        </Section>
        {status?.truncated && <div className="view-note">Mostrando los primeros 5000 archivos</div>}
      </div>
    </div>
  )
}
