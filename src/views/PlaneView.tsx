import { useEffect } from "react"
import { Icon, IconButton } from "../components/ui"
import { isTauri } from "../lib/tauri"
import { loadPlane, openPlane, usePlane } from "../state/plane"

export function PlaneView() {
  const data = usePlane((s) => s.data)
  const loaded = usePlane((s) => s.loaded)
  const error = usePlane((s) => s.error)

  useEffect(() => {
    const refresh = () => void loadPlane()
    refresh()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  return (
    <div className="view memory-view">
      <div className="view-header">
        <span className="view-title">Plano del agente</span>
        <span className="view-actions">
          <IconButton icon="refresh" title="Actualizar" onClick={() => void loadPlane()} />
        </span>
      </div>
      {!isTauri ? <p className="view-note">El plano del agente está disponible solo en la app de escritorio.</p> : (
        <>
          <p className="view-note">Tu versión del agente: su política y las guías de sus canales. Editalo, guardá y aplicá (reinicia el motor).</p>
          {error && <div className="view-error">{error}</div>}
          <div className="memory-list">
            <button type="button" className="memory-nav-row" onClick={() => openPlane()}>
              <Icon name="edit" /><span>Abrir el plano</span>
            </button>
            {data.files.map((file) => (
              <button key={file.key} type="button" className="memory-nav-row memory-entry-row" title={file.hint} onClick={() => openPlane(file.key)}>
                <Icon name="file-code" /><span>{file.label}</span>
                {file.edited && <Icon name="circle-filled" className="memory-nav-origin" />}
              </button>
            ))}
            {loaded && !data.files.length && <p className="view-note">No hay archivos del plano.</p>}
          </div>
        </>
      )}
    </div>
  )
}
