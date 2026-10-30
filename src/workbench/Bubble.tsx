import { useEffect, useState } from "react"
import { bindAgentProject, loadAgentMeta, selectSession, sessionWaiting, startEventStream, useAgent } from "../state/agent"
import { initProject, useProject } from "../state/project"
import { initApprovals } from "../state/approvals"
import { dockBubble, minimizeBubble, listenBubbleDock } from "../state/bubbles"
import { listenWindowClose } from "../state/hub"
import { SessionPane } from "../agent/AgentPanel"
import { DialogHost } from "../components/Dialog"
import { ContextMenuHost, openMenuAt } from "../components/ContextMenu"
import { QuickInput } from "../components/QuickInput"
import { ImageLightbox } from "../components/ImageLightbox"
import { Toasts } from "../components/Toasts"
import { Icon, IconButton, Spinner } from "../components/ui"
import { call, onEvent } from "../lib/tauri"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { DesktopContext, DesktopTask } from "../lib/desktop-context"
import { abortSession } from "../state/agent"

type ResizeDir = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West"

const RESIZE_EDGES: Array<[ResizeDir, string]> = [
  ["North", "n"],
  ["South", "s"],
  ["East", "e"],
  ["West", "w"],
  ["NorthEast", "ne"],
  ["NorthWest", "nw"],
  ["SouthEast", "se"],
  ["SouthWest", "sw"],
]

// La ventana es sin bordes, así que Windows no ofrece el marco para
// redimensionar: los tiradores llaman al arrastre de resize nativo.
function BubbleResizers() {
  return (
    <>
      {RESIZE_EDGES.map(([direction, side]) => (
        <div
          key={direction}
          className={`bubble-resize bubble-resize-${side}`}
          onMouseDown={(e) => {
            e.preventDefault()
            void getCurrentWindow().startResizeDragging(direction)
          }}
        />
      ))}
    </>
  )
}

function BubbleContext({ sessionId }: { sessionId: string }) {
  const [context, setContext] = useState<DesktopContext | null>(null)
  const [task, setTask] = useState<DesktopTask | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    let disposed = false
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try {
        const value = await call<DesktopContext>("desktop_context_get", { session: sessionId })
        if (!disposed) { setContext(value); setError("") }
      } catch (e) { if (!disposed) setError(String(e)) }
      finally { busy = false }
    }
    void refresh()
    void call<DesktopTask | null>("desktop_task_get", { session: sessionId }).then((value) => { if (!disposed) setTask(value) }).catch(() => undefined)
    const timer = setInterval(() => void refresh(), 1500)
    const unlisten = onEvent<DesktopTask>("desktop://task", (value) => { if (value.session === sessionId) { setTask(value); void refresh() } })
    return () => { disposed = true; clearInterval(timer); unlisten() }
  }, [sessionId])
  const select = async (window: string) => {
    try {
      await call("desktop_context_select", { session: sessionId, window: window || null })
      setContext(await call<DesktopContext>("desktop_context_get", { session: sessionId }))
    } catch (e) { setError(String(e)) }
  }
  const running = task?.status === "running"
  const targetLabel = !context?.enabled
    ? "Control de la PC apagado"
    : context.target
      ? `${context.pinned ? "" : "Auto · "}${context.target.title}`
      : "Automático"
  const chooseTarget = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!context?.enabled) return
    openMenuAt(e.currentTarget, [
      { label: "Automático", icon: context.pinned ? undefined : "check", run: () => void select("") },
      ...context.choices.map((choice) => ({
        label: `${choice.title} · ${choice.process}`,
        icon: context.pinned && context.target?.window === choice.window ? "check" : undefined,
        run: () => void select(choice.window),
      })),
    ])
  }
  return <div className="bubble-context">
    <label>
      <Icon name="eye" />
      <span>Viendo:</span>
      <button type="button" className="bubble-target" onClick={chooseTarget} disabled={!context?.enabled} aria-label="Aplicación objetivo" aria-haspopup="menu" title={targetLabel}>
        <span className="bubble-target-text">{targetLabel}</span>
        <Icon name="chevron-down" />
      </button>
    </label>
    {(error || context?.error) && <div role="alert">{error || context?.error}</div>}
    {task && <div className="bubble-task">
      <span title={task.objective}>{task.status === "completed" ? "Comprobado" : task.status === "stopped" ? "Detenido" : task.status === "interrupted" ? "Pendiente de retomar" : task.inFlight || task.next || "Preparado"}{task.checkpoints.length > 0 ? ` · ${task.checkpoints.length} comprobaciones` : ""}</span>
      {running && <button type="button" onClick={() => void abortSession(sessionId)}>Detener</button>}
    </div>}
  </div>
}

let bubbleBooted = false

function bootBubble(sessionId: string): void {
  if (bubbleBooted) return
  bubbleBooted = true
  initApprovals()
  void initProject().then(() => {
    const root = useProject.getState().root
    bindAgentProject(root)
    // initProject publishes ready before this continuation. Selecting in a
    // separate ready effect races with bindAgentProject resetting activeId.
    selectSession(sessionId)
    startEventStream()
    listenBubbleDock()
    void loadAgentMeta().catch(() => undefined)
  })
  listenWindowClose()
}

function BubbleHead({ sessionId, origin }: { sessionId: string; origin: string }) {
  const session = useAgent((s) => s.sessions.find((x) => x.id === sessionId) ?? null)
  const waiting = useAgent((s) => sessionWaiting(s, sessionId))
  return (
    <header className="bubble-head" data-tauri-drag-region>
      <Icon name={waiting ? "bell-dot" : "comment-discussion"} className="bubble-head-icon" />
      <span className="bubble-head-title" data-tauri-drag-region>
        {session?.title || "Conversación"}
      </span>
      <IconButton icon="remove" title="Minimizar chat" onClick={() => void minimizeBubble()} />
      <button
        type="button"
        className="bubble-dock"
        title="Volver a Flufy (el chat vuelve a las pestañas)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => void dockBubble(sessionId, origin)}
      >
        <Icon name="arrow-left" />
        Volver
      </button>
    </header>
  )
}

export function BubbleApp({ sessionId, origin }: { sessionId: string; origin: string }) {
  const ready = useProject((s) => s.ready)
  const connected = useAgent((s) => s.connected)

  useEffect(() => {
    bootBubble(sessionId)
  }, [sessionId])

  useEffect(() => {
    document.documentElement.classList.add("is-bubble")
  }, [])

  return (
    <div className="bubble">
      <BubbleResizers />
      <BubbleHead sessionId={sessionId} origin={origin} />
      <BubbleContext sessionId={sessionId} />
      <div className="bubble-body">
        {ready ? (
          <SessionPane sessionId={sessionId} variant="panel" />
        ) : (
          <div className="bubble-loading">
            <Spinner size={16} />
            <span>Conectando con Fluws…</span>
          </div>
        )}
        {ready && !connected && (
          <div className="bubble-offline">
            <Icon name="debug-disconnect" /> Reconectando…
          </div>
        )}
      </div>
      <QuickInput />
      <ContextMenuHost />
      <DialogHost />
      <ImageLightbox />
      <Toasts />
    </div>
  )
}
