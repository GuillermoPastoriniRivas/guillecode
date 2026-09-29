import { useMemo, useState } from "react"
import type { Session } from "@opencode-ai/sdk"
import { deleteSession, newSession, renameSession, selectSession, useAgent } from "../state/agent"
import { openEditor } from "../state/editors"
import { useLayout } from "../state/layout"
import { promptInput } from "../state/quickinput"
import { shortAgo } from "../lib/time"
import { openContextMenu } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { EmptyState, Icon, IconButton } from "../components/ui"

function SessionRow({ session, depth, childCount }: { session: Session; depth: number; childCount: number }) {
  const active = useAgent((s) => s.activeSessionId === session.id)
  const status = useAgent((s) => s.statuses[session.id]?.type ?? "idle")
  const flash = useAgent((s) => !!s.doneFlash[session.id])
  const pending = useAgent((s) => s.permissions.some((p) => p.sessionID === session.id) || s.questions.some((q) => q.sessionID === session.id))
  const summary = session.summary

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
      className={`session-row${active ? " active" : ""}${status !== "idle" ? " busy" : ""}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={open}
      onDoubleClick={() => openEditor({ kind: "chat", sessionId: session.id })}
      onContextMenu={menu}
      title={session.title}
    >
      <span className="session-state">
        {status === "busy" ? (
          <Icon name="loading" spin />
        ) : status === "retry" ? (
          <Icon name="warning" />
        ) : pending ? (
          <Icon name="bell-dot" className="attention" />
        ) : flash ? (
          <Icon name="pass-filled" className="done" />
        ) : (
          <Icon name={depth > 0 ? "hubot" : "comment-discussion"} />
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
          {childCount > 0 && <span className="session-children">{childCount} subagentes</span>}
          <span className="session-time">{shortAgo(session.time.updated)}</span>
        </span>
      </span>
    </div>
  )
}

export function AgentsView() {
  const sessions = useAgent((s) => s.sessions)
  const loaded = useAgent((s) => s.sessionsLoaded)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const tree = useMemo(() => {
    const children = new Map<string, Session[]>()
    for (const s of sessions) {
      if (!s.parentID) continue
      const list = children.get(s.parentID) ?? []
      list.push(s)
      children.set(s.parentID, list)
    }
    const q = query.trim().toLowerCase()
    const roots = sessions.filter((s) => !s.parentID && (!q || (s.title ?? "").toLowerCase().includes(q)))
    return { roots, children }
  }, [sessions, query])

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
      <div className="view-filter">
        <Icon name="search" />
        <input placeholder="Filtrar sesiones" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="session-list">
        {loaded && tree.roots.length === 0 && (
          <EmptyState icon="comment-discussion" title={query ? "Sin resultados" : "Todavía no hay sesiones"}>
            {!query && "Escribile al agente en el panel de la derecha."}
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
      </div>
    </div>
  )
}
