import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { VoiceSettings } from "../editor/VoiceSettings"
import { Icon } from "../components/ui"
import { call, errorMessage } from "../lib/tauri"

// Bubbles do not mount the workbench editor. Keep audio setup available in
// the current view instead of silently opening an invisible editor tab.
export function VoiceSetup({ onClose, onRecord }: { onClose: () => void; onRecord: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState("")
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  const record = async () => {
    if (checking) return
    setChecking(true)
    setError("")
    try {
      const voice = await call<{ ready: boolean }>("voice_get")
      if (!voice.ready) {
        setError("Guardá una configuración activa. Si elegiste voz local, primero descargá el modelo.")
        return
      }
      onClose()
      await onRecord()
    } catch (e) { setError(errorMessage(e)) }
    finally { setChecking(false) }
  }

  return createPortal(
    <dialog className="voice-setup-dialog" ref={dialog} aria-labelledby="voice-setup-title"
      onCancel={event => { event.preventDefault(); onClose() }}>
      <header className="voice-setup-head">
        <h2 id="voice-setup-title">Configurar voz</h2>
        <button className="icon-button" type="button" aria-label="Cerrar configuración de voz" onClick={onClose}><Icon name="close" /></button>
      </header>
      <p>Para grabar, activá la transcripción en esta instancia de Flufy.</p>
      <VoiceSettings />
      {error && <p role="alert">{error}</p>}
      <footer className="voice-setup-actions">
        <button className="btn" type="button" onClick={onClose}>Cerrar</button>
        <button className="btn btn-primary" type="button" disabled={checking} onClick={() => void record()}>
          <Icon name={checking ? "loading" : "mic"} spin={checking} /> Grabar voz
        </button>
      </footer>
    </dialog>, document.body,
  )
}
