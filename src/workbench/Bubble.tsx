import { useEffect } from "react"
import { bindAgentProject, ensureSessionView, loadAgentMeta, selectSession, sessionWaiting, startEventStream, useAgent } from "../state/agent"
import { initProject, useProject } from "../state/project"
import { initApprovals } from "../state/approvals"
import { dockBubble } from "../state/bubbles"
import { listenWindowClose } from "../state/hub"
import { SessionPane } from "../agent/AgentPanel"
import { DialogHost } from "../components/Dialog"
import { ContextMenuHost } from "../components/ContextMenu"
import { QuickInput } from "../components/QuickInput"
import { ImageLightbox } from "../components/ImageLightbox"
import { Toasts } from "../components/Toasts"
import { Icon, Spinner } from "../components/ui"

let bubbleBooted = false

function bootBubble(): void {
  if (bubbleBooted) return
  bubbleBooted = true
  initApprovals()
  void initProject().then(() => {
    const root = useProject.getState().root
    bindAgentProject(root)
    startEventStream()
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
      <button
        type="button"
        className="bubble-dock"
        title="Volver a GuilleCode (el chat vuelve a las pestañas)"
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
    bootBubble()
  }, [])

  useEffect(() => {
    if (!ready) return
    selectSession(sessionId)
    void ensureSessionView(sessionId)
  }, [ready, sessionId])

  useEffect(() => {
    document.documentElement.classList.add("is-bubble")
  }, [])

  return (
    <div className="bubble">
      <BubbleHead sessionId={sessionId} origin={origin} />
      <div className="bubble-body">
        {ready ? (
          <SessionPane sessionId={sessionId} variant="panel" />
        ) : (
          <div className="bubble-loading">
            <Spinner size={16} />
            <span>Conectando con opencode…</span>
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
