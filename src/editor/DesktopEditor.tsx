import { useState } from "react"
import { call, errorMessage } from "../lib/tauri"
import { recentlyActive, useDesktopStatus, type BridgeStatus, type DesktopStatus } from "../lib/desktop"
import { confirmAction } from "../components/Dialog"
import { Toggle } from "../components/fields"
import { Icon, Spinner } from "../components/ui"
import { notify } from "../state/toasts"

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function stateLabel(s: DesktopStatus): { text: string; tone: string } {
  if (!s.enabled) return { text: "Apagado", tone: "" }
  if (s.paused) return { text: "Pausado", tone: "warn" }
  if (recentlyActive(s)) return { text: "El agente está usando la PC", tone: "busy" }
  return { text: "Activado", tone: "ok" }
}

function bridgeError(raw: string): { text: string; detail: string } {
  const e = raw.toLowerCase()
  if (e.includes("devtoolsactiveport") || e.includes("could not connect") || e.includes("check if chrome is running"))
    return {
      text: "No pude conectar con Chrome. Abrilo, activá la depuración remota en «Abrir configuración de Chrome» y aceptá «Permitir».",
      detail: raw,
    }
  if (e.includes("a tiempo") || e.includes("timed out") || e.includes("timeout"))
    return { text: "Chrome no respondió. Si quedó un diálogo pidiendo permiso, aceptalo y volvé a probar.", detail: raw }
  return { text: `Chrome no conectado: ${raw}`, detail: raw }
}

function bridgeLabel(b: BridgeStatus): { text: string; detail: string | null } {
  if (b.connecting) return { text: "Conectando con Chrome: aceptá «Permitir» si lo pide…", detail: null }
  if (b.state === "ready" && b.connected) return { text: `Conexión con Chrome verificada (${b.tools} herramientas)`, detail: null }
  if (b.state === "ready") return b.error ? bridgeError(b.error) : { text: "Chrome DevTools listo; conexión con Chrome sin verificar", detail: null }
  if (b.state === "starting") return { text: "Arrancando Chrome DevTools…", detail: null }
  if (b.state === "error") return b.error ? bridgeError(b.error) : { text: "Error desconocido al arrancar Chrome DevTools", detail: null }
  return { text: "Sin iniciar: arranca solo cuando opencode lo pide", detail: null }
}

export function DesktopEditor() {
  const { status, error, refresh, update } = useDesktopStatus(5000)
  const [newApp, setNewApp] = useState("")
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      notify.error(failure, errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (error && !status)
    return (
      <div className="doc-page remote-page">
        <header className="doc-header">
          <h1>Control de la PC</h1>
        </header>
        <section className="doc-section remote-section">
          <div className="editor-banner warning">
            <Icon name="warning" />
            <span>Esta versión de GuilleCode todavía no tiene el control de la PC. Cerrala y abrila de nuevo con run.bat para compilar la nueva.</span>
          </div>
        </section>
      </div>
    )

  if (!status)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )

  const label = stateLabel(status)
  const bridge = bridgeLabel(status.bridge)
  const m = status.machine

  const stopAll = () =>
    run(async () => {
      if (!(await confirmAction("Detener todo", "Corta todas las sesiones del agente que estén trabajando y pausa el control de la PC.", "Detener"))) return
      const aborted = await call<number>("desktop_stop_all")
      notify.info("Listo", aborted > 0 ? `Detuve ${aborted} sesión${aborted === 1 ? "" : "es"} y pausé el control.` : "No había sesiones trabajando. El control quedó en pausa.")
      await refresh()
    }, "No se pudo detener")

  const addBlocked = () => {
    const name = newApp.trim().toLowerCase()
    if (!name) return
    const exe = name.endsWith(".exe") ? name : `${name}.exe`
    void run(async () => {
      await update({ blocked: [...status.blocked.filter((b) => b !== exe), exe] })
      setNewApp("")
    }, "No se pudo agregar")
  }

  return (
    <div className="doc-page remote-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="vm" /> Tu PC
        </div>
        <h1>Control de la PC</h1>
        <div className="doc-meta">
          <span className={`routine-pill ${label.tone}`}>{label.text}</span>
          <span>{m.locked || !m.interactive ? "Sesión bloqueada" : "Sesión desbloqueada"}</span>
          {m.hasBattery && <span>{m.onBattery ? `Batería ${m.battery ?? "?"}%` : `Enchufada${m.battery !== null ? ` (${m.battery}%)` : ""}`}</span>}
          <span>{m.keepAwake ? "No se suspende sola" : "Puede suspenderse sola"}</span>
        </div>
        <div className="doc-actions">
          <button type="button" className={`btn btn-sm${status.enabled ? "" : " btn-primary"}`} disabled={busy || !status.available} onClick={() => void run(() => update({ enabled: !status.enabled }), "No se pudo cambiar")}>
            <Icon name={status.enabled ? "circle-slash" : "play"} /> {status.enabled ? "Apagar" : "Permitir que el agente use la PC"}
          </button>
          {status.enabled && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => update({ paused: !status.paused }), "No se pudo cambiar")}>
              <Icon name={status.paused ? "debug-continue" : "debug-pause"} /> {status.paused ? "Reanudar" : "Pausar"}
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void stopAll()}>
            <Icon name="debug-stop" /> Detener todo
          </button>
          <span className="toolbar-spacer" />
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            <Icon name="refresh" /> Actualizar
          </button>
        </div>
      </header>
      <section className="doc-section remote-section">
        <p className="remote-text">
          Con esto el agente puede usar las apps de Windows y tu Chrome (con tus sesiones iniciadas) cuando la tarea lo necesita: lo pedís desde el chat o desde el celular y trabaja en esta PC mientras
          no estás. Primero lee la pantalla por accesibilidad, que es rápido, preciso y funciona aunque la PC esté bloqueada; usa el mouse y capturas solo como respaldo.
        </p>
        {!status.available && (
          <div className="editor-banner warning">
            <Icon name="warning" />
            <span>El servidor del control de la PC no pudo arrancar. Reiniciá GuilleCode.</span>
          </div>
        )}
        {m.lidSleeps && (
          <div className="editor-banner warning">
            <Icon name="warning" />
            <span>
              Si cerrás la tapa, la PC se suspende y el celular pierde la conexión. Para dejarla trabajando cerrada: Configuración de Windows → Sistema → Energía → «Acciones de la tapa» → «No hacer nada»
              {m.onBattery ? " (en batería)" : " (enchufada)"}.
            </span>
          </div>
        )}
        {(m.locked || !m.interactive) && (
          <div className="editor-banner">
            <Icon name="lock" />
            <span>La sesión está bloqueada: el agente puede leer y usar controles por accesibilidad, pero no mover el mouse, teclear ni capturar la pantalla hasta que la desbloquees.</span>
          </div>
        )}
        <div className="remote-steps">
          <strong>
            <Icon name="browser" /> Tu Chrome, con tus sesiones
          </strong>
          <span>
            El agente se conecta a tu Chrome abierto, con tus sesiones, mediante Chrome DevTools. Requiere Chrome 144 o posterior. Abrí la configuración de abajo y habilitá la depuración remota;
            después probá la conexión y aceptá «Permitir» en Chrome. Chrome pide permiso en cada nueva conexión, no en cada acción.
          </span>
          <div className="remote-bridge-row">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => call("desktop_browser_setup"), "No se pudo abrir Chrome: abrí chrome://inspect/#remote-debugging manualmente")}>
              <Icon name="link-external" /> Abrir configuración de Chrome
            </button>
            <span className={`remote-bridge ${status.bridge.connected ? "ok" : status.bridge.error ? "error" : ""}`} title={bridge.detail ?? undefined}>
              {bridge.text}
            </span>
          </div>
          <div className="voice-model desktop-token">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !status.enabled || status.paused || !status.browser}
              onClick={() =>
                void run(async () => {
                  try {
                    await call<BridgeStatus>("desktop_browser_restart")
                    notify.info("Chrome conectado", "Se comprobó el acceso a las pestañas del navegador.")
                  } finally {
                    await refresh()
                  }
                }, "No se pudo conectar con Chrome")
              }
            >
              <Icon name="refresh" /> {busy ? "Esperando conexión…" : "Probar / reconectar"}
            </button>
          </div>
          <span className="desktop-note">Sin extensión ni token. Se usa el perfil elegido por Chrome; si tenés varios, comprobá que sea el correcto. El control de escritorio queda disponible para la barra, los menús y los diálogos nativos.</span>
          <Toggle checked={status.browser} onChange={(v) => void run(() => update({ browser: v }), "No se pudo cambiar")} label="Ofrecerle al agente las herramientas del navegador" />
          {status.browser !== status.browserActive && <span className="desktop-note">Se aplica cuando reinicies GuilleCode.</span>}
          <Toggle checked={status.subagent} onChange={(v) => void run(() => update({ subagent: v }), "No se pudo cambiar")} label="Delegar el manejo de la PC en un subagente (recomendado: las conversaciones de código no cargan estas herramientas)" />
          {status.subagent !== status.subagentActive && <span className="desktop-note">Se aplica cuando reinicies GuilleCode.</span>}
        </div>
        <div className="remote-steps">
          <strong>
            <Icon name="shield" /> Apps que el agente no puede tocar
          </strong>
          <span>Consolas, administradores de contraseñas y herramientas del sistema vienen bloqueadas. GuilleCode también: así el agente no puede aprobarse sus propios permisos.</span>
          <div className="desktop-chips">
            {status.blocked.map((b) => (
              <span key={b} className="desktop-chip">
                {b}
                <button type="button" aria-label={`Quitar ${b}`} onClick={() => void run(() => update({ blocked: status.blocked.filter((x) => x !== b) }), "No se pudo quitar")}>
                  <Icon name="close" />
                </button>
              </span>
            ))}
          </div>
          <div className="voice-model desktop-token">
            <input
              className="input input-sm"
              value={newApp}
              spellCheck={false}
              placeholder="nombre del programa, ej. excel.exe"
              onChange={(e) => setNewApp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addBlocked()
              }}
            />
            <button type="button" className="btn btn-sm" disabled={!newApp.trim()} onClick={addBlocked}>
              <Icon name="add" /> Bloquear
            </button>
          </div>
        </div>
        <div className="remote-steps desktop-activity">
          <strong>
            <Icon name="history" /> Qué hizo el agente
          </strong>
          {status.activity.length === 0 ? (
            <span>Todavía nada en esta sesión de GuilleCode.</span>
          ) : (
            <ul>
              {status.activity.slice(0, 40).map((a, i) => (
                <li key={`${a.at}-${i}`} className={a.ok ? "" : "failed"}>
                  <Icon name={a.channel === "browser" ? "globe" : "vm"} />
                  <span className="desktop-activity-time">{timeOf(a.at)}</span>
                  <span className="desktop-activity-text">{a.summary}</span>
                  {!a.ok && <Icon name="error" />}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="remote-note">
          <Icon name="info" />
          <span>
            Desde el celular, en la tarjeta «Tu PC», podés activarlo, pausarlo, ver la pantalla y detener todo. Mientras el acceso desde el celular está activo, GuilleCode no deja que Windows suspenda la
            PC por inactividad.
          </span>
        </div>
      </section>
    </div>
  )
}
