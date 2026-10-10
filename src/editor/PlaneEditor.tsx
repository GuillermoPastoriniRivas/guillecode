import { useCallback, useEffect, useRef, useState } from "react"
import { errorMessage, isTauri } from "../lib/tauri"
import { notify } from "../state/toasts"
import { applyPlane, loadPlane, readPlane, resetPlane, usePlane, writePlane, type PlaneFile } from "../state/plane"
import { Icon } from "../components/ui"

export function PlaneEditor() {
  const data = usePlane((s) => s.data)
  const error = usePlane((s) => s.error)
  const request = usePlane((s) => s.request)
  const [selected, setSelected] = useState<string | null>(null)
  const [body, setBody] = useState("")
  const [original, setOriginal] = useState("")
  const [busy, setBusy] = useState(false)
  const readVersion = useRef(0)

  const open = useCallback(async (file: PlaneFile) => {
    const version = ++readVersion.current
    setSelected(file.key)
    setBusy(true)
    try {
      const content = await readPlane(file.key)
      if (version !== readVersion.current) return
      setBody(content)
      setOriginal(content)
    } catch (e) {
      if (version === readVersion.current) notify.error(errorMessage(e))
    } finally {
      if (version === readVersion.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadPlane()
  }, [])

  useEffect(() => {
    if (!request) return
    const key = request.key
    const file = data.files.find((f) => f.key === key) ?? (!selected ? data.files[0] : undefined)
    if (file) void open(file)
  }, [request, data.files, selected, open])

  const current = data.files.find((f) => f.key === selected) ?? null
  const dirty = body !== original

  const save = async () => {
    if (!current) return
    setBusy(true)
    try {
      await writePlane(current.key, body)
      setOriginal(body)
      notify.success("Guardado. Aplicá el cambio para que el motor lo tome.")
    } catch (e) {
      notify.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!current) return
    setBusy(true)
    try {
      if (await resetPlane(current.key)) {
        const content = await readPlane(current.key)
        setBody(content)
        setOriginal(content)
      }
    } catch (e) {
      notify.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!isTauri) return <div className="memory-editor"><p className="memory-empty">El plano del agente está disponible solo en la app de escritorio.</p></div>

  return (
    <div className="memory-editor">
      <header className="memory-head">
        <div className="memory-title">
          <Icon name="hubot" />
          <div>
            <strong>Plano del agente</strong>
            <small>Tu versión del agente: su política y las guías de sus canales. Se aplica al reiniciar el motor.</small>
          </div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} title="Reinicia el motor para que el agente use tu plano" onClick={() => void applyPlane()}>
          <Icon name="debug-restart" /> Aplicar
        </button>
      </header>
      {error && <div className="memory-error">{error}</div>}
      <nav className="memory-tabs">
        {data.files.map((file) => (
          <button key={file.key} type="button" disabled={busy} className={selected === file.key ? "active" : ""} onClick={() => void open(file)}>
            {file.label}{file.edited ? " •" : ""}
          </button>
        ))}
      </nav>
      <div className="memory-body">
        {current ? (
          <div className="memory-card">
            <div className="memory-card-head">
              <strong>{current.label}</strong>
              {current.edited && <span className="memory-kind">Editado</span>}
            </div>
            <p className="memory-hint">{current.hint}</p>
            <textarea
              aria-label={`Contenido de ${current.label}`}
              className="memory-textarea tall plane-textarea"
              value={body}
              spellCheck={false}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="memory-card-actions">
              <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}><Icon name="save" /> Guardar</button>
              <button type="button" className="btn" disabled={busy || !dirty} onClick={() => setBody(original)}>Descartar</button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void restore()}><Icon name="discard" /> Restaurar original</button>
            </div>
          </div>
        ) : (
          <p className="memory-empty">Elegí un archivo del plano.</p>
        )}
      </div>
    </div>
  )
}
