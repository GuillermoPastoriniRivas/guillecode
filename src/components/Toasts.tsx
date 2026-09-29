import { useToasts, type ToastKind } from "../state/toasts"
import { Icon, Spinner } from "./ui"

const ICONS: Record<ToastKind, string> = {
  info: "info",
  success: "pass-filled",
  warning: "warning",
  error: "error",
  progress: "loading",
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="status">
          <span className="toast-icon">{t.kind === "progress" ? <Spinner size={13} /> : <Icon name={ICONS[t.kind]} />}</span>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
            {t.actions && t.actions.length > 0 && (
              <div className="toast-actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className={`btn btn-sm${a.primary ? " btn-primary" : ""}`}
                    onClick={() => {
                      dismiss(t.id)
                      a.run()
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Cerrar">
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  )
}
