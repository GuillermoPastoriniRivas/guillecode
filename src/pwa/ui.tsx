import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import { marked } from "marked"
import DOMPurify from "dompurify"
import { ago, connectLive, type LiveEvent, type LiveStatus, type OfflineReason } from "./api"

export function Md({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

export function Icon({ name, spin }: { name: string; spin?: boolean }) {
  return <i className={`codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}`} aria-hidden />
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible")
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])
  return visible
}

export function usePoll(fn: () => Promise<void>, ms: number | null) {
  const saved = useRef(fn)
  const visible = useVisible()
  useEffect(() => {
    saved.current = fn
  })
  useEffect(() => {
    if (ms === null || !visible) return
    const id = window.setInterval(() => void saved.current(), ms)
    return () => window.clearInterval(id)
  }, [ms, visible])
}

export function useLive(session: string | null, onEvent: (e: LiveEvent) => void, onOpen: () => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting")
  const visible = useVisible()
  const handlers = useRef({ onEvent, onOpen })
  useEffect(() => {
    handlers.current = { onEvent, onOpen }
  })
  useEffect(() => {
    if (!visible) return
    let settled = false
    return connectLive(
      session,
      (e) => handlers.current.onEvent(e),
      (s) => {
        setStatus(s)
        if (s === "open" || s === "unsupported" || (s === "down" && !settled)) handlers.current.onOpen()
        if (s !== "connecting") settled = true
      },
    )
  }, [session, visible])
  return status
}

const OFFLINE_COPY: Record<OfflineReason, { title: string; body: string }> = {
  "no-internet": { title: "Este celular no tiene internet", body: "Cuando vuelva la conexión, se actualiza solo." },
  unreachable: {
    title: "No llego a tu PC",
    body: "Puede estar apagada o suspendida, o Tailscale está desconectado en este dispositivo.",
  },
  closed: { title: "GuilleCode está cerrado en tu PC", body: "La PC responde, pero GuilleCode no. Abrilo (o revisá que siga en la bandeja)." },
}

export function OfflineBanner({ reason, cachedAt, onRetry }: { reason: OfflineReason; cachedAt: number | null; onRetry: () => void }) {
  const copy = OFFLINE_COPY[reason]
  return (
    <div className="offline">
      <Icon name={reason === "no-internet" ? "debug-disconnect" : "vm-outline"} />
      <div className="offline-text">
        <strong>{copy.title}</strong>
        <small>{copy.body}</small>
        {cachedAt !== null && <small>Te muestro lo último que vi, {ago(cachedAt)}.</small>}
      </div>
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        <Icon name="refresh" /> Reintentar
      </button>
    </div>
  )
}

export function Sheet({ title, onClose, children, actions, className, innerRef }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; className?: string; innerRef?: Ref<HTMLDivElement> }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    document.body.classList.add("sheet-open")
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.classList.remove("sheet-open")
    }
  }, [onClose])
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${className ? ` ${className}` : ""}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} ref={innerRef}>
        <header className="sheet-head">
          <strong>{title}</strong>
          <div className="sheet-actions">
            {actions}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
