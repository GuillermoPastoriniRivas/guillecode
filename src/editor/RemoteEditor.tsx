import { useCallback, useEffect, useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { call, errorMessage } from "../lib/tauri"
import { confirmAction } from "../components/Dialog"
import { Icon, Spinner } from "../components/ui"
import { notify } from "../state/toasts"
import { VoiceSettings } from "./VoiceSettings"

type RemoteStatus = {
  enabled: boolean
  running: boolean
  port: number
  token: string
  tailscaleIp: string | null
  tailscaleName: string | null
  urls: string[]
  pwaReady: boolean
  pushDevices: number
  error: string | null
}

function describeUrl(url: string): string {
  if (url.startsWith("https://")) return "HTTPS por Tailscale (instalable como app y con notificaciones; requiere tailscale serve)"
  if (url.includes("localhost")) return "Solo desde esta PC (para probar)"
  return "Por Tailscale, directo (anda ya, sin instalar como app)"
}

export function RemoteEditor() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [selected, setSelected] = useState(0)
  const [qr, setQr] = useState<{ url: string; svg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<RemoteStatus>("remote_status"))
    } catch (e) {
      notify.error("No se pudo leer el estado", errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const url = status?.urls[Math.min(selected, (status?.urls.length ?? 1) - 1)] ?? null

  useEffect(() => {
    if (!url || !status?.enabled) return
    call<string>("remote_qr", { text: url })
      .then((svg) => setQr({ url, svg }))
      .catch(() => undefined)
  }, [url, status?.enabled])

  const qrSvg = qr && qr.url === url ? qr.svg : ""

  const toggle = async () => {
    if (!status) return
    setBusy(true)
    try {
      setStatus(await call<RemoteStatus>("remote_set_enabled", { enabled: !status.enabled }))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    if (!(await confirmAction("Generar un link nuevo", "Los celulares conectados con el link anterior dejan de tener acceso hasta que escaneen el QR nuevo.", "Generar"))) return
    setStatus(await call<RemoteStatus>("remote_regenerate_token"))
  }

  const testPush = async () => {
    try {
      const sent = await call<number>("remote_push_test")
      notify.info("Prueba enviada", `Le llegó a ${sent} dispositivo${sent === 1 ? "" : "s"}.`)
    } catch (e) {
      notify.error("No se pudo enviar la prueba", errorMessage(e))
    }
  }

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text)
    notify.info(`${what} copiado`)
  }

  if (!status)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )

  const serveCommand = `tailscale serve --bg ${status.port}`

  return (
    <div className="doc-page remote-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="device-mobile" /> Acceso desde el celular
        </div>
        <h1>Conectar el celular</h1>
        <div className="doc-meta">
          <span className={`routine-pill ${status.running ? "ok" : status.error ? "error" : ""}`}>
            {status.running ? `Activo en el puerto ${status.port}` : status.error ? "No pudo arrancar" : "Apagado"}
          </span>
          <span>{status.tailscaleIp ? `Tailscale: ${status.tailscaleName ?? status.tailscaleIp}` : "Tailscale no detectado"}</span>
        </div>
        <div className="doc-actions">
          <button type="button" className={`btn btn-sm${status.enabled ? "" : " btn-primary"}`} disabled={busy} onClick={() => void toggle()}>
            <Icon name={status.enabled ? "debug-stop" : "play"} /> {status.enabled ? "Apagar el acceso" : "Activar el acceso"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            <Icon name="refresh" /> Actualizar
          </button>
          <span className="toolbar-spacer" />
          <button type="button" className="btn btn-sm" onClick={() => void regenerate()}>
            <Icon name="key" /> Generar link nuevo
          </button>
        </div>
      </header>
      <section className="doc-section remote-section">
        {status.error && (
          <div className="editor-banner warning">
            <Icon name="warning" />
            <span>{status.error}</span>
          </div>
        )}
        {!status.pwaReady && (
          <div className="editor-banner warning">
            <Icon name="warning" />
            <span>
              Falta compilar la app del celular. En la carpeta de GuilleCode corré <code>npm run build:pwa</code> y tocá Actualizar.
            </span>
          </div>
        )}
        <p className="remote-text">
          Desde el celular ves tus sesiones de todos los proyectos, contestás preguntas, aprobás permisos, le escribís al agente y corrés rutinas. Funciona mientras GuilleCode esté abierto o en la bandeja.
        </p>
        {!status.tailscaleIp && (
          <div className="remote-steps">
            <strong>1. Instalá Tailscale en la PC y en el celular</strong>
            <span>Con la misma cuenta en los dos. Así el celular llega a la PC desde cualquier red, sin abrir nada a internet.</span>
            <button type="button" className="btn btn-sm" onClick={() => void openUrl("https://tailscale.com/download")}>
              <Icon name="link-external" /> Descargar Tailscale
            </button>
          </div>
        )}
        {status.enabled && url && (
          <div className="remote-connect">
            <div className="remote-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <div className="remote-links">
              <strong>Escaneá el QR con la cámara del celular</strong>
              {status.urls.map((u, i) => (
                <label key={u} className="remote-url">
                  <input type="radio" checked={i === selected} onChange={() => setSelected(i)} />
                  <span>
                    <span className="remote-url-kind">{describeUrl(u)}</span>
                    <code>{u.replace(/t=.*/, "t=…")}</code>
                  </span>
                </label>
              ))}
              <button type="button" className="btn btn-sm" onClick={() => copy(url, "Link")}>
                <Icon name="copy" /> Copiar link
              </button>
            </div>
          </div>
        )}
        {status.enabled && status.tailscaleName && (
          <div className="remote-steps">
            <strong>Para instalarla como app en el celular (opcional)</strong>
            <span>
              Los celulares solo instalan apps web por HTTPS. Tailscale te da HTTPS gratis con un comando, una sola vez:
            </span>
            <div className="remote-command">
              <code>{serveCommand}</code>
              <button type="button" className="btn btn-xs" onClick={() => copy(serveCommand, "Comando")}>
                <Icon name="copy" /> Copiar
              </button>
            </div>
            <span>Después usá la opción HTTPS del QR y, en el celular, «Agregar a la pantalla de inicio».</span>
          </div>
        )}
        {status.enabled && (
          <div className="remote-steps">
            <strong>Notificaciones en el celular</strong>
            <span>
              {status.pushDevices === 0
                ? "Ningún dispositivo las activó todavía. En la app del celular tocá la campanita (necesita el link HTTPS)."
                : `${status.pushDevices} dispositivo${status.pushDevices === 1 ? " recibe" : "s reciben"} avisos cuando el agente termina, falla o te necesita. No llegan mientras estás usando GuilleCode en la PC.`}
            </span>
            {status.pushDevices > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => void testPush()}>
                <Icon name="bell" /> Enviar una de prueba
              </button>
            )}
          </div>
        )}
        <VoiceSettings />
        <div className="remote-note">
          <Icon name="shield" />
          <span>
            El link da control total del agente de esta PC: tratalo como una contraseña. Solo responde a Tailscale y a esta PC; si lo compartiste por error, generá uno nuevo.
          </span>
        </div>
      </section>
    </div>
  )
}
