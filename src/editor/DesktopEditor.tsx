import { useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { call, errorMessage } from "../lib/tauri"
import { PLAYWRIGHT_EXTENSION_URL, recentlyActive, useDesktopStatus, type BridgeStatus, type DesktopStatus } from "../lib/desktop"
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

function bridgeLabel(b: BridgeStatus): string {
  if (b.state === "ready") return `Conectado a Playwright (${b.tools} herramientas)`
  if (b.state === "starting") return "Arrancando Playwright…"
  if (b.state === "error") return `Error: ${b.error ?? "desconocido"}`
  return "Sin iniciar: arranca solo cuando opencode lo pide"
}

export function DesktopEditor() {
  const { status, error, refresh, update } = useDesktopStatus(5000)
  const [token, setToken] = useState("")
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
  const m = status.machine

  const stopAll = () =>
    run(async () => {
      if (!(await confirmAction("Detener todo", "Corta todas las sesiones del agente que estén trabajando y pausa el control de la PC.", "Detener"))) return
      const aborted = await call<number>("desktop_stop_all")
      notify.info("Listo", aborted > 0 ? `Detuve ${aborted} sesión${aborted === 1 ? "" : "es"} y pausé el control.` : "No había sesiones trabajando. El control quedó en pausa.")
      await refresh()
    }, "No se pudo detener")

  const saveToken = () =>
    run(async () => {
      await update({ browserToken: token })
      setToken("")
      notify.info("Token guardado", "La próxima vez que el agente use el navegador se conecta sin pedirte aprobación.")
    }, "No se pudo guardar el token")

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
            Para que el agente use tu Chrome real (Gmail, Meta Business, consolas web…) sin volver a iniciar sesión, instalá la extensión oficial de Playwright, abrila y copiá el token que muestra. Con
            el token se conecta sola, sin pedirte aprobación cada vez: sin token, la primera conexión espera que toques «Permitir» en Chrome.
          </span>
          <div className="remote-command">
            <button type="button" className="btn btn-sm" onClick={() => void openUrl(PLAYWRIGHT_EXTENSION_URL)}>
              <Icon name="link-external" /> Instalar la extensión
            </button>
            <span className={`routine-pill ${status.bridge.state === "ready" ? "ok" : status.bridge.state === "error" ? "error" : ""}`}>{bridgeLabel(status.bridge)}</span>
          </div>
          <div className="voice-model desktop-token">
            <input
              className="input input-sm"
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder={status.browserConfigured ? "Token guardado. Pegá otro para reemplazarlo" : "PLAYWRIGHT_MCP_EXTENSION_TOKEN"}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !token.trim()} onClick={() => void saveToken()}>
              Guardar
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call<BridgeStatus>("desktop_browser_restart")
                  await refresh()
                }, "No se pudo reiniciar")
              }
            >
              <Icon name="refresh" /> Reconectar
            </button>
          </div>
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
