import { useEffect, useMemo } from "react"
import {
  compactSession,
  contextUsage,
  ensureSessionView,
  focusComposer,
  newSession,
  selectSession,
  useAgent,
} from "../state/agent"
import { notify } from "../state/toasts"
import { percent } from "../lib/format"
import { useLayout } from "../state/layout"
import { useProject } from "../state/project"
import { Chat } from "./Chat"
import { Composer } from "./Composer"
import { SessionTabs } from "./SessionTabs"
import { ChangesBar, PermissionCard, QuestionCard, TodoList } from "./Interactions"
import { Icon, IconButton } from "../components/ui"
import { Logo } from "../components/Logo"
import { shortAgo } from "../lib/time"
import { projectName } from "../lib/paths"

const SUGGESTIONS = [
  { icon: "telescope", title: "Entender el proyecto", text: "Explicame la arquitectura de este proyecto y dónde está cada cosa." },
  { icon: "bug", title: "Buscar y arreglar", text: "Corré el build y el linter, y arreglá los errores que encuentres." },
  { icon: "beaker", title: "Agregar tests", text: "Agregá tests para el módulo que tengo abierto y correlos." },
  { icon: "git-pull-request", title: "Revisar mis cambios", text: "/review" },
]

export function SessionPane({ sessionId, variant }: { sessionId: string | null; variant: "panel" | "editor" }) {
  const session = useAgent((s) => s.sessions.find((x) => x.id === sessionId) ?? null)
  const status = useAgent((s) => (sessionId ? (s.statuses[sessionId]?.type ?? "idle") : "idle"))
  const retry = useAgent((s) => (sessionId ? s.statuses[sessionId] : undefined))
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const todos = useAgent((s) => (sessionId ? s.todos[sessionId] : undefined))
  const sessions = useAgent((s) => s.sessions)
  const root = useProject((s) => s.root)
  const busy = status === "busy" || status === "retry"

  useEffect(() => {
    if (sessionId) void ensureSessionView(sessionId)
  }, [sessionId])

  const mine = useMemo(() => {
    if (!sessionId) return { permissions: [], questions: [] }
    const children = new Set(sessions.filter((s) => s.parentID === sessionId).map((s) => s.id))
    return {
      permissions: permissions.filter((p) => p.sessionID === sessionId || children.has(p.sessionID)),
      questions: questions.filter((q) => q.sessionID === sessionId || children.has(q.sessionID)),
    }
  }, [permissions, questions, sessions, sessionId])

  const view = useAgent((s) => (sessionId ? s.views[sessionId] : undefined))
  const changes = useMemo(() => {
    const byFile = new Map<string, { additions: number; deletions: number }>()
    for (const m of view?.messages ?? []) {
      const diffs = (m.info as { summary?: { diffs?: Array<{ file?: string; additions: number; deletions: number }> } }).summary?.diffs
      if (m.info.role !== "user" || !diffs) continue
      for (const d of diffs) {
        if (!d.file) continue
        const prev = byFile.get(d.file) ?? { additions: 0, deletions: 0 }
        byFile.set(d.file, { additions: prev.additions + d.additions, deletions: prev.deletions + d.deletions })
      }
    }
    const fromMessages = { files: 0, additions: 0, deletions: 0 }
    for (const c of byFile.values()) {
      fromMessages.files += 1
      fromMessages.additions += c.additions
      fromMessages.deletions += c.deletions
    }
    const summary = session?.summary
    if (fromMessages.files === 0 && summary && summary.files > 0) return summary
    return fromMessages
  }, [view, session?.summary])

  const models = useAgent((s) => s.models)
  const usage = useMemo(() => (session ? contextUsage(view?.messages ?? [], models) : null), [session, view, models])

  return (
    <div className={`session-pane ${variant}`}>
      {session ? (
        <Chat session={session} busy={busy} />
      ) : (
        <div className="agent-welcome">
          <div className="agent-welcome-hero">
            <Logo size={48} className="agent-logo-svg" />
            <h2>¿Qué hacemos en {projectName(root)}?</h2>
            <p>El agente lee y edita el código con vos. Lo que cambie lo ves en el editor al instante y lo revisás hunk por hunk.</p>
          </div>
          <div className="agent-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.title} type="button" className="agent-suggestion" onClick={() => focusComposer(s.text)}>
                <Icon name={s.icon} />
                <span>
                  <strong>{s.title}</strong>
                  <em>{s.text}</em>
                </span>
              </button>
            ))}
          </div>
          {sessions.length > 0 && (
            <div className="agent-recent">
              <div className="agent-recent-title">Sesiones recientes</div>
              {sessions
                .filter((s) => !s.parentID)
                .slice(0, 6)
                .map((s) => (
                  <button key={s.id} type="button" className="agent-recent-item" onClick={() => selectSession(s.id)}>
                    <Icon name="comment-discussion" />
                    <span className="agent-recent-name">{s.title || "Sin título"}</span>
                    <span className="agent-recent-time">{shortAgo(s.time.updated)}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      <div className="session-dock">
        {retry?.type === "retry" && (
          <div className="retry-banner">
            <Icon name="sync" spin /> Reintentando ({retry.attempt}): {retry.message}
          </div>
        )}
        {mine.questions.map((q) => (
          <QuestionCard key={q.id} request={q} />
        ))}
        {mine.permissions.map((p) => (
          <PermissionCard key={p.id} request={p} />
        ))}
        {todos && todos.length > 0 && <TodoList key={`${sessionId}-${busy}`} todos={todos} live={busy} />}
        {session && changes.files > 0 && (
          <ChangesBar sessionId={session.id} files={changes.files} additions={changes.additions} deletions={changes.deletions} />
        )}
        {session && usage && usage.ratio >= 0.8 && !busy && (
          <div className={`context-banner${usage.ratio >= 0.95 ? " danger" : ""}`}>
            <Icon name="warning" />
            <span>
              El contexto está al {percent(usage.ratio)}. Compactar resume la conversación y libera espacio para seguir.
            </span>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() =>
                void compactSession(session.id)
                  .then(() => notify.info("Compactando la sesión…"))
                  .catch((e) => notify.error("No se pudo compactar", e instanceof Error ? e.message : String(e)))
              }
            >
              Compactar
            </button>
          </div>
        )}
        <Composer sessionId={sessionId} busy={busy} compact={variant === "panel"} usage={usage} />
      </div>
    </div>
  )
}

export function AgentPanel() {
  const activeId = useAgent((s) => s.activeSessionId)
  const connected = useAgent((s) => s.connected)
  const busyCount = useAgent((s) => Object.values(s.statuses).filter((x) => x.type === "busy").length)
  const focusChat = useLayout((s) => s.focusChat)

  useEffect(() => {
    if (activeId) void ensureSessionView(activeId)
  }, [activeId])

  return (
    <aside className="agent-panel">
      <div className="agent-tabbar">
        <SessionTabs />
        <div className="agent-tabbar-actions">
          {busyCount > 0 && (
            <span className="agent-busy-count" title="Sesiones trabajando">
              <Icon name="loading" spin /> {busyCount}
            </span>
          )}
          <IconButton icon="add" title="Nueva sesión (Ctrl+Alt+N)" onClick={() => newSession()} />
          <IconButton icon="history" title="Historial de sesiones" onClick={() => useLayout.getState().showView("agents", false)} />
          <IconButton
            icon={focusChat ? "screen-normal" : "screen-full"}
            title={focusChat ? "Salir del foco en el chat (Ctrl+Alt+M)" : "Foco en el chat (Ctrl+Alt+M)"}
            active={focusChat}
            onClick={() => useLayout.getState().toggleFocusChat()}
          />
          <IconButton icon="close" title="Ocultar panel del agente (Ctrl+Alt+B)" onClick={() => useLayout.getState().toggleAgent(false)} />
        </div>
      </div>
      {!connected && (
        <div className="agent-offline">
          <Icon name="debug-disconnect" /> Conectando con opencode…
        </div>
      )}
      <SessionPane sessionId={activeId} variant="panel" />
    </aside>
  )
}
