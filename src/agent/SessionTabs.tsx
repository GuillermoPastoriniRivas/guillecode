import { useEffect, useRef } from "react"
import type { Session } from "@opencode-ai/sdk"
import {
  DRAFT_TAB,
  closeOtherSessionTabs,
  closeSessionTab,
  compactSession,
  deleteSession,
  newSession,
  renameSession,
  selectSession,
  useAgent,
} from "../state/agent"
import { openEditor } from "../state/editors"
import { promptInput } from "../state/quickinput"
import { notify } from "../state/toasts"
import { confirmAction } from "../components/Dialog"
import { openContextMenu, type MenuItem } from "../components/ContextMenu"
import { Icon } from "../components/ui"

function tabMenu(e: React.MouseEvent, id: string, session: Session | null) {
  const items: MenuItem[] = []
  if (session) {
    items.push(
      {
        label: "Renombrar…",
        icon: "edit",
        run: async () => {
          const title = await promptInput({ title: "Renombrar sesión", value: session.title })
          if (title?.trim()) await renameSession(session.id, title.trim())
        },
      },
      { label: "Abrir en una pestaña del editor", icon: "go-to-file", run: () => openEditor({ kind: "chat", sessionId: session.id }) },
      { label: "Revisar cambios de la sesión", icon: "diff-multiple", run: () => openEditor({ kind: "review", sessionId: session.id }) },
      {
        label: "Compactar conversación",
        icon: "fold",
        run: () => void compactSession(session.id).then(() => notify.info("Compactando la sesión…")),
      },
      { separator: true },
    )
  }
  items.push(
    { label: "Cerrar pestaña", icon: "close", run: () => closeSessionTab(id) },
    { label: "Cerrar las demás", run: () => closeOtherSessionTabs(id) },
  )
  if (session) {
    items.push(
      { separator: true },
      {
        label: "Eliminar sesión",
        icon: "trash",
        danger: true,
        run: async () => {
          if (await confirmAction("Eliminar sesión", `"${session.title || "Sin título"}" se borra con su historial.`, "Eliminar", true))
            await deleteSession(session.id)
        },
      },
    )
  }
  openContextMenu(e, items)
}

export function SessionTabs() {
  const open = useAgent((s) => s.openSessionIds)
  const sessions = useAgent((s) => s.sessions)
  const activeId = useAgent((s) => s.activeSessionId)
  const statuses = useAgent((s) => s.statuses)
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(".agent-tab.active")
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeId, open.length])

  if (open.length === 1 && open[0] === DRAFT_TAB) return null

  return (
    <div
      className="agent-tabs"
      ref={ref}
      onWheel={(e) => {
        if (ref.current && e.deltaY !== 0) ref.current.scrollLeft += e.deltaY
      }}
    >
      {open.map((id) => {
        const draft = id === DRAFT_TAB
        const session = draft ? null : sessions.find((x) => x.id === id) ?? null
        const active = draft ? activeId === null : activeId === id
        const status = statuses[id]?.type ?? "idle"
        const busy = !draft && (status === "busy" || status === "retry")
        const pending = !draft && (permissions.some((p) => p.sessionID === id) || questions.some((q) => q.sessionID === id))
        const title = draft ? "Nueva conversación" : session?.title || "Sin título"
        return (
          <div
            key={id}
            className={`agent-tab${active ? " active" : ""}`}
            title={title}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeSessionTab(id)
              } else if (e.button === 0) {
                if (draft) newSession()
                else selectSession(id)
              }
            }}
            onContextMenu={(e) => tabMenu(e, id, session)}
          >
            {busy ? (
              <Icon name="loading" spin className="agent-tab-icon" />
            ) : pending ? (
              <Icon name="bell-dot" className="agent-tab-icon attention" />
            ) : (
              <Icon name={draft ? "add" : "comment-discussion"} className="agent-tab-icon" />
            )}
            <span className="agent-tab-label">{title}</span>
            <button
              type="button"
              className="agent-tab-close"
              title="Cerrar pestaña"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                closeSessionTab(id)
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
