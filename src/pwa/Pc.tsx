import { useCallback, useEffect, useRef, useState } from "react"
import { ago, errorText, hub, type PcStatus, type PcWindow } from "./api"
import { Icon, Sheet, usePoll } from "./ui"
import { ScreenView } from "./ScreenView"

const ACTIVE_MS = 20000

function stateOf(s: PcStatus): { label: string; dot: string } {
  if (!s.enabled) return { label: "El agente no puede usarla", dot: "idle" }
  if (s.paused) return { label: "Control en pausa", dot: "warn" }
  const last = s.activity[0]
  if (last && last.tool !== "stop" && Date.now() - last.at < ACTIVE_MS) return { label: "El agente la está usando", dot: "busy" }
  return { label: "El agente puede usarla", dot: "ok" }
}

function machineLine(s: PcStatus): string {
  const m = s.machine
  const parts = [m.locked || !m.interactive ? "bloqueada" : "desbloqueada"]
  if (m.hasBattery) parts.push(m.onBattery ? `batería ${m.battery ?? "?"}%` : "enchufada")
  if (m.keepAwake) parts.push("no se suspende sola")
  return parts.join(" · ")
}

export function PcCard({ status: initial, onChange }: { status: PcStatus; onChange?: () => void }) {
  const [local, setLocal] = useState<{ from: PcStatus; value: PcStatus } | null>(null)
  const status = local && local.from === initial ? local.value : initial
  const setStatus = useCallback((value: PcStatus) => setLocal({ from: initial, value }), [initial])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  const [open, setOpen] = useState(false)
  const [screen, setScreen] = useState(false)

  usePoll(
    async () => {
      try {
        setStatus(await hub<PcStatus>("GET", "/desktop"))
      } catch {
        return
      }
    },
    status.enabled ? 6000 : null,
  )

  useEffect(() => {
    if (!confirmStop) return
    const timer = setTimeout(() => setConfirmStop(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmStop])

  const patch = async (body: { enabled?: boolean; paused?: boolean }) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await hub<PcStatus>("POST", "/desktop", body))
      onChange?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const stopAll = async () => {
    if (!confirmStop) return setConfirmStop(true)
    setConfirmStop(false)
    setBusy(true)
    setError(null)
    try {
      const r = await hub<{ aborted: number; desktop: PcStatus }>("POST", "/desktop/stop")
      setStatus(r.desktop)
      setNotice(r.aborted > 0 ? `Detuve ${r.aborted} sesión${r.aborted === 1 ? "" : "es"} y pausé el control.` : "No había nada trabajando. El control quedó en pausa.")
      onChange?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const state = stateOf(status)
  const last = status.activity[0]
  const m = status.machine

  return (
    <section className="card pc column">
      <button type="button" className="pc-head" onClick={() => setOpen(!open)}>
        <Icon name="vm" />
        <span className="card-text">
          <strong>Tu PC</strong>
          <small>{machineLine(status)}</small>
        </span>
        <span className={`dot ${state.dot}`} />
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      <div className="pc-state">
        <span>{state.label}</span>
        {last && state.dot === "busy" && <small>{last.summary}</small>}
      </div>
      {m.lidSleeps && (
        <small className="warn-text">
          <Icon name="warning" /> Si cerrás la tapa, la PC se suspende y perdés la conexión.
        </small>
      )}
      {m.hasBattery && m.onBattery && (m.battery ?? 100) <= 20 && (
        <small className="warn-text">
          <Icon name="warning" /> Le queda {m.battery}% de batería.
        </small>
      )}
      {error && <div className="alert">{error}</div>}
      {notice && <small className="muted">{notice}</small>}
      <div className="row">
        {!status.enabled ? (
          <button type="button" className="btn btn-sm primary" disabled={busy || !status.available} onClick={() => void patch({ enabled: true })}>
            <Icon name="play" /> Permitir que la use
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void patch({ paused: !status.paused })}>
            <Icon name={status.paused ? "debug-continue" : "debug-pause"} /> {status.paused ? "Reanudar" : "Pausar"}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => setScreen(true)}>
          <Icon name="eye" /> Ver pantalla
        </button>
        <button type="button" className={`btn btn-sm danger${confirmStop ? " confirm" : ""}`} disabled={busy} onClick={() => void stopAll()}>
          <Icon name="debug-stop" /> {confirmStop ? "¿Seguro? Tocá de nuevo" : "Detener todo"}
        </button>
      </div>
      {open && (
        <div className="pc-more">
          {status.activity.length === 0 ? (
            <small className="muted">El agente todavía no usó la PC desde que abriste GuilleCode.</small>
          ) : (
            <ul className="pc-activity">
              {status.activity.slice(0, 8).map((a, i) => (
                <li key={`${a.at}-${i}`} className={a.ok ? "" : "failed"}>
                  <Icon name={a.channel === "browser" ? "globe" : "vm"} />
                  <span>{a.summary}</span>
                  <small>{ago(a.at)}</small>
                </li>
              ))}
            </ul>
          )}
          {status.enabled && (
            <button type="button" className="link" disabled={busy} onClick={() => void patch({ enabled: false })}>
              <Icon name="circle-slash" /> Apagar el control de la PC
            </button>
          )}
          {!status.bridge.connected && status.enabled && status.browser && (
            <small className="muted">Para usar tu Chrome, habilitá chrome://inspect/#remote-debugging en la PC y aceptá la conexión. Podés comprobarla en GuilleCode → «Control de la PC»; no necesita extensión ni token.</small>
          )}
        </div>
      )}
      {screen && <ScreenSheet onClose={() => setScreen(false)} />}
    </section>
  )
}

export function ScreenSheet({ onClose, initialTarget = null }: { onClose: () => void; initialTarget?: string | null }) {
  const [windows, setWindows] = useState<PcWindow[]>([])
  const [displays, setDisplays] = useState<Array<{id: string; name: string}>>([])
  const [target, setTarget] = useState<string | null>(initialTarget)
  const [live, setLive] = useState(true)
  const [full, setFull] = useState(false)
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    hub<PcWindow[]>("GET", "/desktop/windows")
      .then((list) => setWindows((list ?? []).filter((w) => !w.minimized && !w.blocked)))
      .catch(() => setWindows([]))
    hub<Array<{id: string; name: string}>>("GET", "/desktop/stream/displays").then(setDisplays).catch(() => {})
  }, [])

  const unlockOrientation = () => {
    const orientation = screen.orientation as ScreenOrientation & { unlock?: () => void }
    try { orientation.unlock?.() } catch { /* no soportado */ }
  }

  useEffect(() => {
    const sync = () => {
      const on = !!document.fullscreenElement
      setFull(on)
      if (!on) unlockOrientation()
    }
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [])

  const toggleFull = useCallback(async () => {
    if (full) {
      unlockOrientation()
      try { if (document.fullscreenElement) await document.exitFullscreen() } catch { /* no soportado */ }
      setFull(false)
      return
    }
    try { await sheet.current?.requestFullscreen?.() } catch { /* el navegador no lo permite */ }
    setFull(true)
    // Acostar el teléfono: solo funciona con el visor en pantalla completa (Android/Chrome).
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    try { await orientation.lock?.("landscape") } catch { /* iOS/Safari: girar a mano */ }
  }, [full])

  return (
    <Sheet
      title="Pantalla de tu PC"
      onClose={onClose}
      innerRef={sheet}
      className={full ? "full" : undefined}
      actions={
        <>
          {full && (
            <button type="button" className={`icon-btn${live ? "" : " active"}`} onClick={() => setLive((v) => !v)} aria-label={live ? "Pausar la vista" : "Seguir en vivo"}>
              <Icon name={live ? "debug-pause" : "play"} />
            </button>
          )}
          <button type="button" className={`icon-btn${full ? " active" : ""}`} onClick={() => void toggleFull()} aria-label={full ? "Salir de pantalla completa" : "Pantalla completa acostada"}>
            <Icon name={full ? "screen-normal" : "screen-full"} />
          </button>
        </>
      }
    >
      {!full && (
        <div className="screen-targets">
          <button type="button" className={`chip${target === null ? " on" : ""}`} onClick={() => setTarget(null)}>
            Toda la pantalla
          </button>
          {displays.map(d => <button key={d.id} type="button" className={`chip${target === d.id ? " on" : ""}`} onClick={() => setTarget(d.id)}>{d.name}</button>)}
          {windows.map((w) => (
            <button key={w.id} type="button" className={`chip${target === w.id ? " on" : ""}`} onClick={() => setTarget(w.id)}>
              {w.title.length > 34 ? `${w.title.slice(0, 34)}…` : w.title}
            </button>
          ))}
        </div>
      )}
      <ScreenView target={target} active={live} floating={full} />
      {!full && (
        <>
          <div className="row">
            <button type="button" className={`btn btn-sm${live ? " primary" : ""}`} onClick={() => setLive(!live)}>
              <Icon name={live ? "debug-pause" : "play"} /> {live ? "Dejar de seguir" : "Seguir en vivo"}
            </button>
          </div>
          <small className="muted">Las ventanas muestran su región visible del escritorio. Si otra app las tapa, vas a ver esa app.</small>
        </>
      )}
    </Sheet>
  )
}
