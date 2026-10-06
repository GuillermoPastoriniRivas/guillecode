import { useEffect, useState } from "react"
import { changeCount, featuresDiff, type Feature, type FeatureDiff, type RepoGroup } from "../lib/features"
import { gitBranches, hasStaged, hasUnstaged, isConflict, type Branch, type CommitFile } from "../lib/git"
import { basename, dirname, joinPath, samePath } from "../lib/paths"
import { loadJson, saveJson } from "../lib/persist"
import { openPath } from "@tauri-apps/plugin-opener"
import { errorMessage, isTauri } from "../lib/tauri"
import { useProject } from "../state/project"
import { sessionInRoot, useAgent } from "../state/agent"
import { useTerminals } from "../state/terminals"
import {
  changeBase,
  configureRunCommand,
  featureTitle,
  isAppRunning,
  newSessionIn,
  openFeatureCreate,
  openPullRequest,
  removeFeature,
  renameFeature,
  runApp,
  setArchived,
  stopApp,
  switchToFeature,
  updateFromBase,
  useFeatures,
} from "../state/features"
import { openEditor, openFile } from "../state/editors"
import { refreshRepo, unwatchRepo, useGit, watchRepo } from "../state/git"
import { StatusRow } from "./StatusRow"
import { notify } from "../state/toasts"
import { openContextMenu, openMenuAt, type MenuItem } from "../components/ContextMenu"
import { FileIcon, Icon, IconButton, Section, Spinner } from "../components/ui"
import { Select } from "../components/fields"

const OPEN_KEY = "scm.featuresOpen"
const EXPANDED_KEY = "scm.featuresExpanded"
const COLLAPSED_REPOS_KEY = "scm.featuresCollapsedRepos"
const POLL_MS = 5000

function useActivity(feature: Feature): { busy: number; waiting: number } {
  const sessions = useAgent((s) => s.allSessions)
  const statuses = useAgent((s) => s.statuses)
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const mine = sessions.filter((x) => sessionInRoot(x, feature.root))
  const ids = new Set(mine.map((x) => x.id))
  return {
    busy: mine.filter((x) => statuses[x.id] && statuses[x.id].type !== "idle").length,
    waiting: permissions.filter((p) => ids.has(p.sessionID)).length + questions.filter((q) => ids.has(q.sessionID)).length,
  }
}

function featureMenu(feature: Feature, active: boolean, running: boolean): MenuItem[] {
  const main = feature.kind === "main"
  const items: MenuItem[] = []
  if (!active) items.push({ label: "Abrir", icon: "folder-opened", disabled: feature.missing, run: () => void switchToFeature(feature) })
  items.push({ label: "Nueva conversación acá", icon: "comment-discussion", disabled: feature.missing, run: () => void newSessionIn(feature) })
  if (active)
    items.push(
      running
        ? { label: "Detener la app", icon: "debug-stop", run: () => void stopApp() }
        : { label: "Correr la app", icon: "play", run: () => void runApp() },
    )
  items.push({ separator: true })
  if (!main) {
    items.push({ label: "Integrar…", icon: "git-merge", disabled: feature.missing, run: () => openEditor({ kind: "featureIntegrate", path: feature.path }) })
    items.push({ label: "Crear pull request", icon: "git-pull-request-create", disabled: feature.missing || !feature.branch, run: () => void openPullRequest(feature) })
    items.push({
      label: feature.base ? `Traer ${feature.base} a la feature` : "Traer la base a la feature",
      icon: "git-pull-request-go-to-changes",
      disabled: feature.missing || !feature.base,
      run: () => void updateFromBase(feature),
    })
    items.push({ separator: true })
    items.push({ label: "Renombrar…", icon: "edit", run: () => void renameFeature(feature) })
    items.push({ label: feature.base ? `Cambiar la base (${feature.base})…` : "Elegir la rama base…", icon: "git-compare", disabled: feature.missing, run: () => void changeBase(feature) })
    items.push(
      feature.archived
        ? { label: "Desarchivar", icon: "inbox", run: () => void setArchived(feature, false) }
        : { label: "Archivar", icon: "archive", run: () => void setArchived(feature, true) },
    )
  }
  items.push({
    label: "Copiar la ruta",
    icon: "copy",
    run: () => void navigator.clipboard.writeText(feature.root).then(() => notify.info("Ruta copiada")),
  })
  if (isTauri && !feature.missing)
    items.push({ label: "Abrir la carpeta en Windows", icon: "folder", run: () => void openPath(feature.root).catch(() => undefined) })
  if (active) items.push({ label: "Configurar cómo correr la app…", icon: "settings-gear", run: () => void configureRunCommand() })
  if (!main) {
    items.push({ separator: true })
    items.push({ label: feature.missing ? "Quitar de la lista" : "Eliminar…", icon: "trash", danger: true, run: () => void removeFeature(feature) })
  }
  return items
}

function RangeRow({ feature, diff, file }: { feature: Feature; diff: FeatureDiff; file: CommitFile }) {
  const deleted = file.status === "D"
  const tone = file.status === "A" ? "added" : file.status === "D" ? "deleted" : file.status === "R" ? "renamed" : "modified"
  const open = () => {
    if (!diff.head || !diff.mergeBase) return
    openEditor(
      {
        kind: "commitFile",
        repo: feature.path,
        hash: diff.head,
        parent: diff.mergeBase,
        path: file.path,
        orig: file.orig,
        label: `${featureTitle(feature)} vs ${diff.base}`,
      },
      { preview: true },
    )
  }
  const dir = dirname(file.path) === file.path ? "" : dirname(file.path)
  return (
    <div
      className={`scm-row git-${tone}`}
      onClick={open}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: "Ver lo que cambió en la feature", icon: "diff", run: open },
          { label: "Abrir el archivo de esta feature", icon: "go-to-file", disabled: deleted, run: () => openFile(joinPath(feature.path, file.path)) },
        ])
      }
      title={`${file.path}${file.orig ? ` (antes ${file.orig})` : ""}`}
    >
      <FileIcon path={file.path} />
      <span className={`scm-name${deleted ? " deleted" : ""}`}>{basename(file.path)}</span>
      <span className="scm-dir">{dir}</span>
      <span className="feature-file-stats">
        {file.additions > 0 && <span className="pane-added">+{file.additions}</span>}
        {file.deletions > 0 && <span className="pane-removed">−{file.deletions}</span>}
      </span>
      <span className="scm-letter">{file.status}</span>
    </div>
  )
}

function FeatureChanges({ feature, active }: { feature: Feature; active: boolean }) {
  const project = useProject((s) => s.project)
  const status = useGit((s) => s.byRepo[feature.path]?.status ?? null)
  const statusError = useGit((s) => s.byRepo[feature.path]?.error ?? null)
  const refreshedAt = useGit((s) => s.byRepo[feature.path]?.loadedAt ?? 0)
  const [result, setResult] = useState<{ key: string; diff: FeatureDiff | null; error: string | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [comparison, setComparison] = useState("")
  const [branches, setBranches] = useState<Branch[]>([])

  useEffect(() => {
    if (feature.missing || feature.kind === "main") return
    let alive = true
    gitBranches(feature.path).then((found) => alive && setBranches(found)).catch(() => alive && setBranches([]))
    return () => { alive = false }
  }, [feature.path, feature.missing, feature.kind, nonce])

  useEffect(() => {
    if (feature.missing) return
    watchRepo(feature.path)
    return () => unwatchRepo(feature.path)
  }, [feature.path, feature.missing])

  useEffect(() => {
    if (feature.missing || active) return
    const timer = setInterval(() => {
      if (!document.hidden) void refreshRepo(feature.path)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [feature.path, feature.missing, active])

  const diffKey = `${feature.path}|${feature.head ?? ""}|${feature.base ?? ""}|${comparison}|${refreshedAt}|${nonce}`
  const diff = result?.key === diffKey ? result.diff : null
  const diffError = result?.key === diffKey ? result.error : null
  useEffect(() => {
    if (!project || feature.missing || feature.kind === "main") return
    let alive = true
    featuresDiff(feature.repo || project, feature.path, comparison)
      .then((d) => {
        if (!alive) return
        setResult({ key: diffKey, diff: d, error: null })
      })
      .catch((e) => alive && setResult({ key: diffKey, diff: null, error: errorMessage(e) }))
    return () => {
      alive = false
    }
  }, [diffKey, project, feature.repo, feature.path, feature.missing, feature.kind, comparison])

  if (feature.missing)
    return (
      <div className="feature-changes">
        <div className="view-note">La carpeta de esta feature ya no existe.</div>
      </div>
    )

  const entries = status?.entries ?? []
  const staged = entries.filter((e) => !isConflict(e) && hasStaged(e))
  const unstaged = entries.filter((e) => isConflict(e) || hasUnstaged(e))
  const refresh = () => {
    void refreshRepo(feature.path)
    setNonce((n) => n + 1)
  }
  const comparisonOptions = [
    { value: "", label: feature.base ? `Base: ${feature.base}` : "Base por determinar", icon: "worktree" },
    ...branches.filter((b) => b.name !== feature.branch && !b.name.endsWith("/HEAD"))
      .map((b) => ({ value: b.name, label: b.name, description: b.remote ? "referencia remota · último fetch" : "rama local", icon: b.remote ? "cloud" : "git-branch" })),
  ]

  return (
    <div className="feature-changes">
      {feature.kind !== "main" && (
        <div className="feature-comparison">
          <span>Comparar con</span>
          <Select value={comparison} options={comparisonOptions} onChange={setComparison} title="Comparar sin cambiar la base del worktree ni la carpeta activa" />
          <span className="feature-comparison-note">
            {comparison ? "Comparación temporal; la base del worktree se conserva." :
              !feature.base ? "El agente debe registrar la base real. Podés inspeccionar otra referencia mientras tanto." :
              feature.baseSource === "inferred" || feature.baseSource === "upstream" ? "Base inferida; el agente puede confirmar su origen." :
              "Cambios propios desde el punto de separación de la base."}
          </span>
          {comparisonOptions.find((o) => o.value === comparison)?.icon === "cloud" || (!comparison && branches.some((b) => b.remote && b.name === feature.base)) ? (
            <span className="feature-comparison-note">Referencia remota del último fetch.</span>
          ) : null}
        </div>
      )}
      <div className="feature-changes-title">
        <span>Pendientes de commit</span>
        {entries.length > 0 && <span className="pane-count">{entries.length}</span>}
        <span className="toolbar-spacer" />
        <IconButton icon="refresh" title="Refrescar los cambios de esta feature" onClick={refresh} />
      </div>
      {!status && !statusError && (
        <div className="view-note">
          <Spinner size={11} /> Leyendo…
        </div>
      )}
      {statusError && <div className="view-error">{statusError}</div>}
      {status && entries.length === 0 && <div className="view-note">No hay cambios pendientes.{feature.kind !== "main" ? " Los commits propios se muestran abajo." : ""}</div>}
      {staged.map((e) => (
        <StatusRow key={`s-${e.path}`} repo={feature.path} entry={e} staged />
      ))}
      {unstaged.map((e) => (
        <StatusRow key={`u-${e.path}`} repo={feature.path} entry={e} staged={false} />
      ))}
      {feature.kind !== "main" && (
        <>
          <div className="feature-changes-title">
            <span>{diff?.base ? `Cambios propios vs ${diff.base}` : "Cambios propios"}</span>
            {diff && diff.files.length > 0 && <span className="pane-count">{diff.files.length}</span>}
            {diff && diff.commits > 0 && <span className="feature-changes-meta">{diff.commits === 1 ? "1 commit" : `${diff.commits} commits`}</span>}
          </div>
          {diffError && <div className="view-error">{diffError}</div>}
          {!diff && !diffError && (
            <div className="view-note">
              <Spinner size={11} /> Comparando con la base…
            </div>
          )}
          {diff && !diff.base && <div className="view-note">La base todavía no está registrada. No se asume main.</div>}
          {diff && diff.base && diff.files.length === 0 && <div className="view-note">Todavía no hay commits propios respecto de {diff.base}.</div>}
          {diff && diff.files.length > 0 && (
            <div className="view-note feature-diff-summary">
              {diff.files.length} archivo(s) · <span className="pane-added">+{diff.files.reduce((sum, f) => sum + f.additions, 0)}</span> / <span className="pane-removed">−{diff.files.reduce((sum, f) => sum + f.deletions, 0)}</span>
            </div>
          )}
          {diff && diff.files.map((f) => <RangeRow key={f.path} feature={feature} diff={diff} file={f} />)}
        </>
      )}
      {!active && (
        <div className="feature-changes-actions">
          <button type="button" className="btn btn-sm" onClick={() => void switchToFeature(feature)}>
            <Icon name="folder-opened" /> Abrir esta feature
          </button>
          {feature.kind !== "main" && (
            <button type="button" className="btn btn-sm" onClick={() => openEditor({ kind: "featureIntegrate", path: feature.path })}>
              <Icon name="git-merge" /> Integrar…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function FeatureRow({
  feature,
  active,
  expanded,
  onToggle,
  nested = false,
  note,
}: {
  feature: Feature
  active: boolean
  expanded: boolean
  onToggle: (() => void) | null
  nested?: boolean
  note?: string
}) {
  const runId = useFeatures((s) => s.runTerminalId)
  const terminals = useTerminals((s) => s.terminals)
  const running = active && isAppRunning(runId, terminals)
  const activity = useActivity(feature)
  const changes = changeCount(feature.changes)
  const icon = feature.missing ? "warning" : feature.kind === "main" ? "home" : feature.kind === "external" ? "repo-forked" : "worktree"
  const open = () => {
    if (!active) void switchToFeature(feature)
  }
  const details: string[] = []
  if (feature.kind === "external") details.push("creada fuera de GuilleCode")
  if (feature.base && (feature.ahead || feature.behind)) {
    const parts = []
    if (feature.ahead) parts.push(`${feature.ahead} commit(s) propios`)
    if (feature.behind) parts.push(`${feature.behind} atrás de ${feature.base}`)
    details.push(parts.join(", "))
  }
  return (
    <>
    <div
      className={`feature-row${active ? " active" : ""}${feature.missing ? " missing" : ""}${feature.archived ? " archived" : ""}${expanded ? " expanded" : ""}${nested ? " nested" : ""}`}
      onClick={onToggle ?? open}
      onDoubleClick={open}
      onContextMenu={(e) => openContextMenu(e, featureMenu(feature, active, running))}
      title={`${feature.root}${details.length ? `\n${details.join(" · ")}` : ""}\n${onToggle ? "Clic: ver sus cambios · Doble clic: abrirla" : "Clic: abrirla"}`}
    >
      {onToggle ? <Icon name={expanded ? "chevron-down" : "chevron-right"} className="feature-chevron" /> : <span className="feature-chevron" />}
      <Icon name={icon} className="feature-icon" />
      <div className="feature-text">
        <div className="feature-name">
          <span>{nested ? feature.label : featureTitle(feature)}</span>
          {active && <span className="feature-badge active">activa</span>}
          {feature.archived && <span className="feature-badge">archivada</span>}
        </div>
        <div className="feature-sub">
          {feature.missing ? (
            <span>carpeta no encontrada</span>
          ) : note ? (
            <span>{note}</span>
          ) : (
            <>
              <Icon name="git-branch" />
              <span className="mono">{feature.detached ? "HEAD detached" : (feature.branch ?? "")}</span>
              {feature.kind !== "main" && feature.base && (feature.ahead !== null || feature.behind !== null) && (
                <span className="feature-sync" title={details.join(" · ")}>
                  {feature.ahead ? `${feature.ahead}↑` : ""}
                  {feature.behind ? ` ${feature.behind}↓` : ""}
                  {!feature.ahead && !feature.behind ? `= ${feature.base}` : ""}
                </span>
              )}
              {feature.merging && <span className="feature-badge conflict">merge en curso</span>}
            </>
          )}
        </div>
        {feature.kind !== "main" && !feature.missing && (
          <div className={`feature-sub feature-base${!feature.base ? " unknown" : ""}`}>
            <Icon name="git-compare" />
            <span>Base: <span className="mono">{feature.base ?? "por determinar"}</span></span>
            {(feature.baseSource === "inferred" || feature.baseSource === "upstream") && <span className="feature-badge">inferida</span>}
          </div>
        )}
      </div>
      <span className="feature-indicators">
        {activity.waiting > 0 && (
          <span className="feature-pill attention" title="Un agente espera tu respuesta">
            <Icon name="bell-dot" /> {activity.waiting}
          </span>
        )}
        {activity.busy > 0 && (
          <span className="feature-pill busy" title="Agentes trabajando">
            <Spinner size={10} /> {activity.busy}
          </span>
        )}
        {running && (
          <span className="feature-pill running" title="La app de esta feature está corriendo">
            <Icon name="play" />
          </span>
        )}
        {changes > 0 && (
          <span className="feature-pill" title="Archivos con cambios sin commitear">
            {changes}
          </span>
        )}
      </span>
      <span className="feature-actions" onClick={(e) => e.stopPropagation()}>
        {active ? (
          <IconButton
            icon={running ? "debug-stop" : "play"}
            title={running ? "Detener la app" : "Correr la app en la terminal"}
            onClick={() => void (running ? stopApp() : runApp())}
          />
        ) : (
          <IconButton icon="folder-opened" title="Abrir esta feature" disabled={feature.missing} onClick={open} />
        )}
        {feature.kind !== "main" && !feature.missing && (
          <IconButton icon="git-merge" title="Integrar…" onClick={() => openEditor({ kind: "featureIntegrate", path: feature.path })} />
        )}
        <IconButton icon="ellipsis" title="Más acciones" onClick={(e) => openMenuAt(e.currentTarget, featureMenu(feature, active, running))} />
      </span>
    </div>
    {expanded && <FeatureChanges feature={feature} active={active} />}
    </>
  )
}

function RepoHeader({ group, count, collapsed, onToggle }: { group: RepoGroup; count: number; collapsed: boolean; onToggle: () => void }) {
  const changes = changeCount(group.changes)
  const branch = group.detached ? "HEAD detached" : (group.branch ?? "")
  const menu = (): MenuItem[] => [
    { label: `Nueva feature en ${group.name}…`, icon: "git-branch-create", run: () => void openFeatureCreate(group.path) },
    { label: "Ver historial", icon: "git-commit", run: () => openEditor({ kind: "graph", repo: group.main }) },
    { separator: true },
    { label: "Copiar la ruta", icon: "copy", run: () => void navigator.clipboard.writeText(group.main).then(() => notify.info("Ruta copiada")) },
    ...(isTauri ? [{ label: "Abrir la carpeta en Windows", icon: "folder", run: () => void openPath(group.main).catch(() => undefined) }] : []),
  ]
  return (
    <div
      className="feature-repo"
      onClick={count > 0 ? onToggle : undefined}
      onContextMenu={(e) => openContextMenu(e, menu())}
      title={`${group.main}\nCopia principal en ${branch}`}
    >
      {count > 0 ? <Icon name={collapsed ? "chevron-right" : "chevron-down"} className="feature-chevron" /> : <span className="feature-chevron" />}
      <Icon name="repo" className="feature-icon" />
      <span className="feature-repo-name">{group.name}</span>
      <span className="feature-repo-branch mono">{branch}</span>
      {group.merging && <span className="feature-badge conflict">merge en curso</span>}
      <span className="feature-indicators">
        {changes > 0 && (
          <span className="feature-pill" title="Archivos con cambios sin commitear en la copia principal">
            {changes}
          </span>
        )}
        {collapsed && count > 0 && (
          <span className="feature-pill" title="Features de este repositorio">
            <Icon name="worktree" /> {count}
          </span>
        )}
      </span>
      <span className="feature-actions" onClick={(e) => e.stopPropagation()}>
        <IconButton icon="add" title={`Nueva feature en ${group.name}`} onClick={() => void openFeatureCreate(group.path)} />
        <IconButton icon="ellipsis" title="Más acciones" onClick={(e) => openMenuAt(e.currentTarget, menu())} />
      </span>
    </div>
  )
}

export function FeaturesSection() {
  const list = useFeatures((s) => s.list)
  const loading = useFeatures((s) => s.loading)
  const error = useFeatures((s) => s.error)
  const showArchived = useFeatures((s) => s.showArchived)
  const root = useProject((s) => s.root)
  const [open, setOpen] = useState(() => loadJson(OPEN_KEY, true))
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadJson(EXPANDED_KEY, {}))
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>(() => loadJson(COLLAPSED_REPOS_KEY, {}))
  if (!isTauri || !list?.git) return null
  const toggleExpanded = (path: string) => {
    const k = path.toLowerCase()
    const next = { ...expanded, [k]: !expanded[k] }
    if (!next[k]) delete next[k]
    setExpanded(next)
    saveJson(EXPANDED_KEY, next)
  }
  const toggleRepo = (path: string) => {
    const k = path.toLowerCase()
    const next = { ...collapsedRepos, [k]: !collapsedRepos[k] }
    if (!next[k]) delete next[k]
    setCollapsedRepos(next)
    saveJson(COLLAPSED_REPOS_KEY, next)
  }
  const isActive = (f: Feature) => !!root && samePath(f.root, root)
  const archived = list.features.filter((f) => f.archived && !isActive(f)).length
  const visible = list.features.filter((f) => showArchived || !f.archived || isActive(f))
  const toggle = () => {
    setOpen(!open)
    saveJson(OPEN_KEY, !open)
  }
  const repoCount = list.repos.length === 1 ? "1 repositorio" : `${list.repos.length} repositorios`
  const row = (f: Feature, nested = false) => {
    const multiMain = list.multi && f.kind === "main"
    return (
      <FeatureRow
        key={f.path}
        feature={f}
        active={isActive(f)}
        expanded={!multiMain && !!expanded[f.path.toLowerCase()]}
        onToggle={multiMain ? null : () => toggleExpanded(f.path)}
        nested={nested}
        note={multiMain ? `${repoCount} en sus ramas actuales` : undefined}
      />
    )
  }
  return (
    <Section
      title="Worktrees"
      count={list.features.length > 1 ? visible.length : undefined}
      open={open}
      onToggle={toggle}
      actions={
        <>
          {loading && <Spinner size={11} />}
          <IconButton icon="add" title="Pedir al agente un nuevo worktree" onClick={() => void openFeatureCreate()} />
        </>
      }
    >
      <div className="feature-list">
        {list.multi ? (
          <>
            {visible.filter((f) => f.kind === "main").map((f) => row(f))}
            {list.repos.map((g) => {
              const mine = visible.filter((f) => f.kind !== "main" && samePath(f.repo, g.path))
              const collapsed = !!collapsedRepos[g.path.toLowerCase()]
              return (
                <div key={g.path} className="feature-group">
                  <RepoHeader group={g} count={mine.length} collapsed={collapsed} onToggle={() => toggleRepo(g.path)} />
                  {!collapsed && mine.map((f) => row(f, true))}
                </div>
              )
            })}
          </>
        ) : (
          visible.map((f) => row(f))
        )}
        {list.features.length === 1 && (
          <button type="button" className="feature-empty" onClick={() => void openFeatureCreate()}>
            <Icon name="git-branch-create" />
            <span>
              <strong>Pedile al agente un trabajo separado</strong>
              <span>El agente crea y prepara el worktree. Acá supervisás sus cambios respecto a su base.</span>
            </span>
          </button>
        )}
        {archived > 0 && (
          <button type="button" className="feature-more" onClick={() => useFeatures.setState({ showArchived: !showArchived })}>
            <Icon name={showArchived ? "eye-closed" : "archive"} /> {showArchived ? "Ocultar archivadas" : `Ver ${archived} archivada(s)`}
          </button>
        )}
        {error && <div className="view-error">{error}</div>}
      </div>
    </Section>
  )
}
