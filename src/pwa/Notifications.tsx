import { useCallback, useEffect, useState } from "react"
import { errorText } from "./api"
import { disablePush, enablePush, pushStatus, savePushPrefs, testPush, type PushPrefs, type PushStatus } from "./push"
import { Icon, Sheet } from "./ui"

export type PushControl = {
  status: PushStatus | null
  busy: boolean
  error: string | null
  enable: () => Promise<void>
  disable: () => Promise<void>
  setPrefs: (prefs: PushPrefs) => Promise<void>
  test: () => Promise<void>
}

export function usePushStatus(): PushControl {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    pushStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    status,
    busy,
    error,
    enable: () => run(async () => setStatus(await enablePush())),
    disable: () =>
      run(async () => {
        await disablePush()
        setStatus({ kind: "off" })
      }),
    setPrefs: (prefs) =>
      run(async () => {
        const saved = await savePushPrefs(prefs)
        setStatus((s) => (s?.kind === "on" ? { ...s, prefs: saved } : s))
      }),
    test: () =>
      run(async () => {
        if (status?.kind === "on") await testPush(status.endpoint)
      }),
  }
}

function Toggle({ on, label, hint, disabled, onChange }: { on: boolean; label: string; hint: string; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="toggle-row" disabled={disabled} onClick={() => onChange(!on)}>
      <span className="card-text">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <span className={`toggle${on ? " on" : ""}`} />
    </button>
  )
}

export function NotificationSettings({ push, onClose }: { push: PushControl; onClose: () => void }) {
  const status = push.status
  const [tested, setTested] = useState(false)
  return (
    <Sheet title="Notificaciones" onClose={onClose}>
      {!status && (
        <div className="loading">
          <Icon name="loading" spin /> Revisando…
        </div>
      )}
      {status?.kind === "insecure" && (
        <div className="notice">
          <strong>Necesitan el link HTTPS</strong>
          <small>
            Los celulares solo permiten notificaciones en sitios seguros. En GuilleCode (comando «Conectar el celular») elegí el link que empieza con https:// y termina en
            .ts.net, y escanealo de nuevo.
          </small>
        </div>
      )}
      {status?.kind === "unsupported" && (
        <div className="notice">
          <strong>Este navegador no soporta notificaciones push</strong>
          <small>Probá con Chrome. En iPhone, primero agregá la app a la pantalla de inicio y abrila desde ahí.</small>
        </div>
      )}
      {status?.kind === "denied" && (
        <div className="notice">
          <strong>El navegador las tiene bloqueadas</strong>
          <small>Tocá el candado junto a la dirección → Permisos → Notificaciones → Permitir. Después volvé acá.</small>
        </div>
      )}
      {status?.kind === "off" && (
        <>
          <p className="muted">Te aviso aunque tengas el celular bloqueado: cuando el agente termina, falla o necesita que le respondas.</p>
          <button type="button" className="btn primary" disabled={push.busy} onClick={() => void push.enable()}>
            <Icon name={push.busy ? "loading" : "bell"} spin={push.busy} /> Activar notificaciones
          </button>
        </>
      )}
      {status?.kind === "on" && (
        <>
          <Toggle
            on={status.prefs.attention}
            label="Cuando te necesita"
            hint="Pide un permiso o te hace una pregunta"
            disabled={push.busy}
            onChange={(v) => void push.setPrefs({ ...status.prefs, attention: v })}
          />
          <Toggle
            on={status.prefs.done}
            label="Cuando termina"
            hint="Con el principio de la respuesta"
            disabled={push.busy}
            onChange={(v) => void push.setPrefs({ ...status.prefs, done: v })}
          />
          <Toggle
            on={status.prefs.error}
            label="Cuando falla"
            hint="Error del modelo o del proveedor"
            disabled={push.busy}
            onChange={(v) => void push.setPrefs({ ...status.prefs, error: v })}
          />
          <small className="muted">No te llegan mientras estás usando GuilleCode en la PC.</small>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={push.busy}
              onClick={() =>
                void push.test().then(() => {
                  setTested(true)
                })
              }
            >
              <Icon name="beaker" /> Enviar una de prueba
            </button>
            <button type="button" className="btn danger" disabled={push.busy} onClick={() => void push.disable()}>
              Desactivar
            </button>
          </div>
          {tested && !push.error && <small className="muted">Enviada: te tendría que llegar en unos segundos.</small>}
        </>
      )}
      {push.error && <div className="alert">{push.error}</div>}
    </Sheet>
  )
}
