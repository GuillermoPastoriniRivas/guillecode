import { useEffect, useRef } from "react"
import { create } from "zustand"
import { Icon } from "./ui"

type DialogButton = { id: string; label: string; primary?: boolean; danger?: boolean }

type DialogRequest = {
  title: string
  message?: string
  icon?: string
  buttons: DialogButton[]
  resolve: (id: string | null) => void
}

const useDialog = create<{ request: DialogRequest | null }>(() => ({ request: null }))

export function ask(title: string, opts: { message?: string; icon?: string; buttons: DialogButton[] }): Promise<string | null> {
  const previous = useDialog.getState().request
  previous?.resolve(null)
  return new Promise((resolve) => {
    useDialog.setState({ request: { title, ...opts, resolve } })
  })
}

export async function confirmAction(title: string, message: string, confirmLabel: string, danger = false): Promise<boolean> {
  const result = await ask(title, {
    message,
    icon: danger ? "warning" : "question",
    buttons: [
      { id: "cancel", label: "Cancelar" },
      { id: "ok", label: confirmLabel, primary: !danger, danger },
    ],
  })
  return result === "ok"
}

export function DialogHost() {
  const request = useDialog((s) => s.request)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!request) return
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>("button.primary-choice, button:last-child")?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        useDialog.setState({ request: null })
        request.resolve(null)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [request])

  if (!request) return null
  const close = (id: string | null) => {
    useDialog.setState({ request: null })
    request.resolve(id)
  }
  return (
    <div className="dialog-backdrop" onMouseDown={() => close(null)}>
      <div className="dialog" ref={ref} role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          {request.icon && <Icon name={request.icon} className="dialog-icon" />}
          <div>
            <div className="dialog-title">{request.title}</div>
            {request.message && <div className="dialog-message">{request.message}</div>}
          </div>
        </div>
        <div className="dialog-buttons">
          {request.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`btn${b.primary ? " btn-primary primary-choice" : ""}${b.danger ? " btn-danger primary-choice" : ""}`}
              onClick={() => close(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
