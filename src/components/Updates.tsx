import { useEffect } from "react"
import { checkUpdates, downloadUpdate, installUpdate, showUpdates, useUpdates } from "../state/updates"
import { isTauri } from "../lib/tauri"
import { Icon, Spinner } from "./ui"
import "../styles/updates.css"

export function UpdateButton() {
  const phase = useUpdates((s) => s.phase)
  const version = useUpdates((s) => s.update?.version)
  if (!isTauri) return null
  return <button type="button" className={`btn update-button${version ? " has-update" : ""}`} onClick={showUpdates} title="Actualizaciones de GuilleCode">
    <Icon name={phase === "downloading" ? "loading" : "cloud-download"} spin={phase === "downloading"} />
    {phase === "ready" ? "Reiniciar para actualizar" : phase === "downloading" ? "Descargando…" : version ? `Actualizar a ${version}` : "Actualizaciones"}
  </button>
}

export function UpdatesHost() {
  const { open, version, update, phase, downloaded, total, error, checkedAt } = useUpdates()
  const close = () => useUpdates.setState({ open: false })
  useEffect(() => {
    if (!open || phase === "installing") return
    const listener = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [open, phase])
  if (phase === "installing") return <div className="update-installing" role="alert" aria-busy="true"><Spinner /><strong>Instalando actualización…</strong><span>GuilleCode volverá a abrirse con la nueva versión.</span></div>
  if (!open) return null
  const percent = total ? Math.min(100, Math.floor(downloaded * 100 / total)) : null
  return <section className="updates-panel" role="dialog" aria-label="Actualizaciones de GuilleCode">
    <div className="updates-head"><h2>Actualizaciones de GuilleCode</h2><button type="button" className="btn" aria-label="Cerrar actualizaciones" onClick={close}><Icon name="close" /></button></div>
    <p className="updates-version">Versión instalada: {version || update?.currentVersion || "…"}</p>
    {error && <p className="updates-error" role="alert">{error}</p>}
    {update ? <>
      <h3>{phase === "ready" ? "Lista para instalar" : "Nueva versión disponible"}: {update.version}</h3>
      {update.notes && <div className="updates-notes">{update.notes}</div>}
      {phase === "downloading" && <div aria-live="polite">
        <progress aria-label="Descarga de actualización" max={100} {...(percent === null ? {} : { value: percent })} />
        <p>{percent === null ? `${Math.round(downloaded / 1024 / 1024)} MB descargados` : `${percent}% descargado`} · Podés seguir trabajando.</p>
      </div>}
      <div className="updates-actions">
        {phase === "available" && <button type="button" className="btn btn-primary" onClick={() => void downloadUpdate()}><Icon name="cloud-download" />{error ? "Reintentar descarga" : "Descargar actualización"}</button>}
        {phase === "ready" && <button type="button" className="btn btn-primary" onClick={() => void installUpdate()}><Icon name="debug-restart" />Instalar y reiniciar</button>}
        <button type="button" className="btn" onClick={close}>Más tarde</button>
      </div>
    </> : <p>{phase === "checking" ? "Buscando actualizaciones…" : error ? "Tu versión actual sigue disponible. Podés reintentar." : checkedAt ? "Tenés la última versión." : "Buscá si hay una versión nueva."}</p>}
    {!["downloading", "ready"].includes(phase) && <button type="button" className="btn" disabled={phase === "checking"} onClick={() => void checkUpdates()}><Icon name="refresh" spin={phase === "checking"} />Buscar actualizaciones</button>}
  </section>
}
