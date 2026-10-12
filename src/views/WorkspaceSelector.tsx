import { useState } from "react"
import { loadJson, saveJson } from "../lib/persist"
import { sessionInRoot, useAgent } from "../state/agent"
import { useTerminals } from "../state/terminals"
import {
  isAppRunning,
  openFeatureCreate,
  prepareWorkspace,
  removeWorkspace,
  runApp,
  selectWorkspace,
  stopApp,
  useFeatures,
  workspaceTitle,
} from "../state/features"
import { openMenuAt, type MenuItem } from "../components/ContextMenu"
import { Icon, IconButton, Section, Spinner } from "../components/ui"
import type { Workspace } from "../lib/features"

const OPEN_KEY = "scm.workspacesOpen"

function useWorkspaceActivity(ws: Workspace): { busy: number; waiting: number } {
  const sessions = useAgent((s) => s.allSessions)
  const statuses = useAgent((s) => s.statuses)
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const roots = ws.repos.map((r) => r.root)
  const mine = sessions.filter((x) => roots.some((root) => sessionInRoot(x, root)))
  const ids = new Set(mine.map((x) => x.id))
  return {
    busy: mine.filter((x) => statuses[x.id] && statuses[x.id].type !== "idle").length,
    waiting: permissions.filter((p) => ids.has(p.sessionID)).length + questions.filter((q) => ids.has(q.sessionID)).length,
  }
}

function changesOf(ws: Workspace): number {
  return ws.repos.reduce((n, r) => n + (r.changes ? r.changes.staged + r.changes.unstaged + r.changes.untracked + r.changes.conflicts : 0), 0)
}

function WorkspaceRow({ ws, active }: { ws: Workspace; active: boolean }) {
  const activity = useWorkspaceActivity(ws)
  const changes = changesOf(ws)
  const prepare = useFeatures((s) => s.prepare[ws.id])
  const runId = useFeatures((s) => s.runTerminalId)
  const terminals = useTerminals((s) => s.terminals)
  const running = active && isAppRunning(runId, terminals)
  const feature = ws.kind === "feature"
  const missing = ws.repos.every((r) => r.missing)
  const repoNote = ws.repos.length === 1 ? ws.repos[0].name : `${ws.repos.length} repositorios`
  const branches = Array.from(new Set(ws.repos.map((r) => r.branch).filter((b): b is string => !!b)))
  const menu = (): MenuItem[] => {
    const items: MenuItem[] = []
    if (!active) items.push({ label: "Usar este espacio", icon: "check", run: () => void selectWorkspace(ws.id) })
    items.push({ label: "Preparar el entorno", icon: "tools", disabled: missing, run: () => void prepareWorkspace(ws) })
    if (active) {
      items.push(
        running
          ? { label: "Detener la app", icon: "debug-stop", run: () => void stopApp() }
          : { label: "Correr la app", icon: "play", run: () => void runApp() },
      )
    }
    if (feature) {
      items.push({ separator: true })
      items.push({ label: "Eliminar el trabajo…", icon: "trash", danger: true, run: () => void removeWorkspace(ws) })
    }
    return items
  }
  return (
    <div
      className={`feature-row${active ? " active" : ""}${ws.archived ? " archived" : ""}`}
      onClick={() => {
        if (!active) void selectWorkspace(ws.id)
      }}
      onContextMenu={(e) => openMenuAt(e.currentTarget, menu())}
      title={`${ws.kind === "main" ? "Copia principal del proyecto" : "Trabajo separado"}\n${ws.repos.map((r) => `${r.name}: ${r.path}`).join("\n")}`}
    >
      <span className="feature-chevron" />
      <Icon name={ws.kind === "main" ? "home" : "worktree"} className="feature-icon" />
      <div className="feature-text">
        <div className="feature-name">
          <span>{workspaceTitle(ws)}</span>
          {active && <span className="feature-badge active">activo</span>}
        </div>
        <div className="feature-sub">
          <Icon name="repo" />
          <span>{repoNote}</span>
          {branches.length > 0 && <span className="mono"> · {branches.join(", ")}</span>}
          {prepare?.status === "preparing" && (
            <span className="feature-badge">
              <Spinner size={10} /> preparando
            </span>
          )}
          {prepare?.status === "ready" && <span className="feature-badge">entorno listo</span>}
          {prepare?.status === "error" && <span className="feature-badge conflict">error al preparar</span>}
        </div>
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
          <span className="feature-pill running" title="La app está corriendo">
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
            title={running ? "Detener la app" : "Correr la app"}
            onClick={() => void (running ? stopApp() : runApp())}
          />
        ) : (
          <IconButton icon="check" title="Usar este espacio" onClick={() => void selectWorkspace(ws.id)} />
        )}
        <IconButton icon="tools" title="Preparar el entorno de este trabajo" disabled={missing} onClick={() => void prepareWorkspace(ws)} />
        <IconButton icon="ellipsis" title="Más acciones" onClick={(e) => openMenuAt(e.currentTarget, menu())} />
      </span>
    </div>
  )
}

export function WorkspaceSelector() {
  const list = useFeatures((s) => s.list)
  const active = useFeatures((s) => s.activeWorkspace)
  const [open, setOpen] = useState(() => loadJson(OPEN_KEY, true))
  if (!list?.git) return null
  const workspaces = list.workspaces ?? []
  const features = workspaces.filter((w) => w.kind !== "main")
  const mains = workspaces.filter((w) => w.kind === "main")
  const toggle = () => {
    setOpen(!open)
    saveJson(OPEN_KEY, !open)
  }
  return (
    <Section
      title="Espacios de trabajo"
      count={features.length || undefined}
      open={open}
      onToggle={toggle}
      actions={<IconButton icon="add" title="Pedirle al agente un trabajo nuevo" onClick={() => void openFeatureCreate()} />}
    >
      <div className="feature-list">
        {mains.map((w) => (
          <WorkspaceRow key={w.id} ws={w} active={w.id === active} />
        ))}
        {features.map((w) => (
          <WorkspaceRow key={w.id} ws={w} active={w.id === active} />
        ))}
        {features.length === 0 && (
          <button type="button" className="feature-empty" onClick={() => void openFeatureCreate()}>
            <Icon name="git-branch-create" />
            <span>
              <strong>Pedile al agente un trabajo separado</strong>
              <span>El agente crea un worktree por repositorio y lo prepara. Acá cambiás entre Principal y cada trabajo.</span>
            </span>
          </button>
        )}
      </div>
    </Section>
  )
}
