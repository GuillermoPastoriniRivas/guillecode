import { useMemo, useState } from "react"
import type { Session } from "@opencode-ai/sdk"
import { deleteSession, newSession, renameSession, selectSession, sessionInRoot, sessionWaiting, setSessionArchived, useAgent } from "../state/agent"
import { useSessionMark } from "../state/unseen"
import { useProject } from "../state/project"
import { featureTitle, findFeature, useFeatures } from "../state/features"
import { normalizePath } from "../lib/paths"
import { archivedSessionIds, archivedSessionOwner } from "../lib/sessions"
import { openEditor } from "../state/editors"
import { useLayout } from "../state/layout"
import { promptInput } from "../state/quickinput"
import { shortAgo } from "../lib/time"
import { openContextMenu } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { EmptyState, Icon, IconButton } from "../components/ui"

function SessionRow({ session, depth, childCount }: { session: Session; depth: number; childCount: number }) {
  const active = useAgent((s) => s.activeSessionId === session.id)
  const mark = useSessionMark(session.id)
  const flash = useAgent((s) => !!s.doneFlash[session.id])
  const sessions = useAgent((s) => s.allSessions)
  const archived = archivedSessionOwner(session, sessions)
  const [saving, setSaving] = useState(false)
  const summary = session.summary

  const toggleArchive = async () => {
    setSaving(true)
    await setSessionArchived(archived?.id ?? session.id, !archived)
    setSaving(false)
  }

  const open = () => {
    useLayout.getState().toggleAgent(true)
    selectSession(session.id)
  }

  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: "Abrir en el panel", icon: "comment-discussion", run: open },
      { label: "Abrir en una pestaña", icon: "go-to-file", run: () => openEditor({ kind: "chat", sessionId: session.id }) },
      { label: "Revisar cambios", icon: "diff-multiple", run: () => openEditor({ kind: "review", sessionId: session.id }) },
      {
        label: "Renombrar…",
        icon: "edit",
        run: async () => {
          const title = await promptInput({ title: "Renombrar sesión", value: session.title })
          if (title?.trim()) await renameSession(session.id, title.trim())
        },
      },
      {
        label: archived ? "Restaurar conversación" : "Archivar conversación",
        icon: archived ? "discard" : "archive",
        disabled: saving,
        run: () => void toggleArchive(),
      },
      { separator: true },
      {
        label: "Eliminar",
        icon: "trash",
        danger: true,
        run: async () => {
          if (await confirmAction("Eliminar sesión", `"${session.title}" se borra con su historial.`, "Eliminar", true)) await deleteSession(session.id)
        },
      },
    ])

  return (
    <div
      className={`session-row state-${mark}${active ? " active" : ""}${mark === "busy" || mark === "retry" ? " busy" : ""}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={open}
      onDoubleClick={() => openEditor({ kind: "chat", sessionId: session.id })}
      onContextMenu={menu}
      title={session.title}
    >
      <span className="session-state">
        {mark === "attention" ? (
          <Icon name="bell-dot" className="attention" />
        ) : mark === "busy" ? (
          <Icon name="loading" spin />
        ) : mark === "retry" ? (
          <Icon name="warning" />
        ) : mark === "unseen" || flash ? (
          <Icon name="pass-filled" className="done" />
        ) : (
          <Icon name={archived ? "archive" : depth > 0 ? "hubot" : "comment-discussion"} />
        )}
      </span>
      <span className="session-main">
        <span className="session-title">{session.title || "Sin título"}</span>
        <span className="session-meta">
          {summary && summary.files > 0 && (
            <span className="session-diff">
              <span className="add">+{summary.additions}</span>
              <span className="del">−{summary.deletions}</span>
            </span>
          )}
          {mark === "attention" && <span className="session-flag attention">espera tu respuesta</span>}
          {mark === "unseen" && <span className="session-flag done">terminó</span>}
          {childCount > 0 && <span className="session-children">{childCount} subagentes</span>}
          <span className="session-time">{shortAgo(session.time.updated)}</span>
        </span>
      </span>
      <IconButton
        icon={archived ? "discard" : "archive"}
        title={archived ? "Restaurar conversación" : "Archivar conversación"}
        className="session-archive-action"
        disabled={saving}
        onClick={(e) => {
          e.stopPropagation()
          void toggleArchive()
        }}
      />
    </div>
  )
}

export function AgentsView() {
  const sessions = useAgent((s) => s.sessions)
  const loaded = useAgent((s) => s.sessionsLoaded)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const archived = useMemo(() => archivedSessionIds(sessions), [sessions])
  const counts = useMemo(() => ({
    active: sessions.filter((s) => !archived.has(s.id) && (!s.parentID || !sessions.some((p) => p.id === s.parentID))).length,
    archived: sessions.filter((s) => archived.has(s.id) && (!s.parentID || !archived.has(s.parentID))).length,
  }), [sessions, archived])

  const tree = useMemo(() => {
    const visible = sessions.filter((s) => archived.has(s.id) === showArchived)
    const ids = new Set(visible.map((s) => s.id))
    const children = new Map<string, Session[]>()
    for (const s of visible) {
      if (!s.parentID) continue
      const list = children.get(s.parentID) ?? []
      list.push(s)
      children.set(s.parentID, list)
    }
    const q = query.trim().toLowerCase()
    const roots = visible.filter((s) => (!s.parentID || !ids.has(s.parentID)) && (!q || (s.title ?? "").toLowerCase().includes(q)))
    return { roots, children }
  }, [sessions, query, archived, showArchived])

  return (
    <div className="view agents-view">
      <div className="view-header">
        <span className="view-title">Sesiones del agente</span>
        <span className="view-actions">
          <IconButton
            icon="add"
            title="Nueva sesión"
            onClick={() => {
              useLayout.getState().toggleAgent(true)
              newSession()
            }}
          />
        </span>
      </div>
      <div className="segmented session-filters" role="group" aria-label="Estado de las conversaciones">
        <button type="button" className={!showArchived ? "active" : ""} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>
          Activas ({counts.active})
        </button>
        <button type="button" className={showArchived ? "active" : ""} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>
          Archivadas ({counts.archived})
        </button>
      </div>
      <div className="view-filter">
        <Icon name="search" />
        <input placeholder="Filtrar sesiones" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="session-list">
        {loaded && tree.roots.length === 0 && (
          <EmptyState icon={showArchived ? "archive" : "comment-discussion"} title={query ? "Sin resultados" : showArchived ? "No hay conversaciones archivadas" : "Todavía no hay sesiones"}>
            {!query && (showArchived ? "Archivá una conversación para guardarla acá con todo su historial." : "Escribile al agente en el panel de la derecha.")}
          </EmptyState>
        )}
        {tree.roots.map((s) => {
          const kids = tree.children.get(s.id) ?? []
          return (
            <div key={s.id}>
              <div className="session-row-wrap">
                {kids.length > 0 && (
                  <button type="button" className="session-expand" onClick={() => setExpanded((e) => ({ ...e, [s.id]: !e[s.id] }))}>
                    <Icon name={expanded[s.id] ? "chevron-down" : "chevron-right"} />
                  </button>
                )}
                <SessionRow session={s} depth={0} childCount={kids.length} />
              </div>
              {expanded[s.id] && kids.map((k) => <SessionRow key={k.id} session={k} depth={1} childCount={0} />)}
            </div>
          )
        })}
        {!showArchived && <OtherFeatureSessions />}
      </div>
    </div>
  )
}

function OtherFeatureSessions() {
  const root = useProject((s) => s.root)
  const all = useAgent((s) => s.allSessions)
  const statuses = useAgent((s) => s.statuses)
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const list = useFeatures((s) => s.list)
  const archived = archivedSessionIds(all)
  const active = all.filter((s) => {
    if (s.parentID || archived.has(s.id) || sessionInRoot(s, root)) return false
    const busy = statuses[s.id] && statuses[s.id].type !== "idle"
    return busy || sessionWaiting({ allSessions: all, permissions, questions }, s.id)
  })
  if (active.length === 0) return null
  return (
    <div className="session-others">
      <div className="session-others-title">Trabajando en otras features</div>
      {active.map((s) => {
        const feature = findFeature(s.directory ? normalizePath(s.directory) : null, list)
        return (
          <div key={s.id} className="session-other">
            <span className="session-other-feature">
              <Icon name={feature?.kind === "main" ? "home" : "worktree"} /> {feature ? featureTitle(feature) : "otra carpeta"}
            </span>
            <SessionRow session={s} depth={0} childCount={0} />
          </div>
        )
      })}
    </div>
  )
}
