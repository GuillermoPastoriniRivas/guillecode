import { useId, useState, type ReactNode } from "react"

const shortcuts = [
  { title: "Editar", keys: [["Copiar", "Ctrl+C"], ["Pegar", "Ctrl+V"], ["Cortar", "Ctrl+X"], ["Seleccionar todo", "Ctrl+A"], ["Deshacer", "Ctrl+Z"], ["Rehacer", "Ctrl+Y"]] },
  { title: "Ventanas y apps", keys: [["Cambiar app", "Alt+Tab"], ["Ver escritorio", "Win+D"], ["Inicio", "Win"], ["Buscar", "Ctrl+F"], ["Guardar", "Ctrl+S"], ["Actualizar", "F5"]] },
]

export function ScreenCommands({ mouse, text, onTextChange, onKey, onWrite, onClipboard }: {
  mouse: ReactNode; text: string; onTextChange: (text: string) => void
  onKey: (key: string) => void; onWrite: (enter: boolean) => void
  onClipboard: (action: "read" | "write") => Promise<boolean>
}) {
  const [tab, setTab] = useState("mouse")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [mods, setMods] = useState<string[]>([])
  const [custom, setCustom] = useState("")
  const id = useId()
  const sendKey = (key: string, label = key) => { onKey(key); setMessage(`${label} enviado a la PC`) }
  const clip = async (action: "read" | "write") => {
    setBusy(true)
    try { if (await onClipboard(action)) setMessage(action === "read" ? "Texto de la PC recibido" : "Texto copiado al portapapeles de la PC") }
    finally { setBusy(false) }
  }
  return <div className="screen-command-center">
    <div className="screen-command-tabs" role="group" aria-label="Tipo de control">
      {[["mouse", "Mouse"], ["text", "Texto"], ["keys", "Atajos"]].map(([id, label]) =>
        <button type="button" key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setMessage("") }}>{label}</button>)}
    </div>
    {tab === "mouse" && mouse}
    {tab === "text" && <div className="screen-command-section">
      <label htmlFor={`${id}-write`}>Escribir en la ventana activa</label>
      <textarea id={`${id}-write`} aria-label="Texto para escribir en la PC" placeholder="Tocá primero el campo en tu PC y escribí acá…" value={text} maxLength={2000} rows={3} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={e => onTextChange(e.target.value)} />
      <div className="screen-command-grid">
        <button type="button" className="btn primary" disabled={!text || busy} onClick={() => { onWrite(false); setMessage("Texto enviado a la PC") }}>Escribir</button>
        <button type="button" className="btn" disabled={!text || busy} onClick={() => { onWrite(true); setMessage("Texto y Enter enviados a la PC") }}>Escribir + Enter</button>
      </div>
      <small className="muted">Enter del celular agrega una línea. «Escribir + Enter» confirma en la PC.</small>
      <details className="screen-command-details"><summary>Portapapeles</summary>
        <div className="screen-command-grid">
          <button type="button" className="btn" disabled={busy} onClick={() => void clip("read")}>Traer texto de PC</button>
          <button type="button" className="btn" disabled={!text || busy} onClick={() => void clip("write")}>Copiar texto a PC</button>
        </div>
        <small className="muted">Copiar deja el texto listo para pegar; no escribe en la ventana.</small>
      </details>
    </div>}
    {tab === "keys" && <div className="screen-command-section">
      {shortcuts.map(group => <section key={group.title}><h4>{group.title}</h4><div className="screen-command-grid">
        {group.keys.map(([label, key]) => <button type="button" className="screen-command" key={key} onClick={() => sendKey(key, label)}><span>{label}</span><kbd>{key.replace("Win", "Windows")}</kbd></button>)}
      </div></section>)}
      <details className="screen-command-details"><summary>Armar un atajo</summary>
        <div className="screen-modifiers" role="group" aria-label="Modificadores del atajo">
          {["Ctrl", "Alt", "Shift", "Win"].map(mod => <button type="button" aria-pressed={mods.includes(mod)} key={mod} onClick={() => setMods(list => list.includes(mod) ? list.filter(m => m !== mod) : [...list, mod])}>{mod}</button>)}
        </div>
        <form onSubmit={e => { e.preventDefault(); if (custom.trim()) sendKey([...mods, custom.trim()].join("+")) }}>
          <label htmlFor={`${id}-shortcut`}>Tecla (por ejemplo: L, F2, Enter)</label>
          <input id={`${id}-shortcut`} value={custom} maxLength={24} autoCapitalize="off" autoCorrect="off" onChange={e => setCustom(e.target.value)} />
          <button className="btn" type="submit" disabled={!custom.trim()}>Enviar {mods.length ? `${mods.join("+")}+` : ""}{custom || "tecla"}</button>
        </form>
      </details>
    </div>}
    <div className="screen-essential-keys" role="group" aria-label="Teclas frecuentes">
      {[["Esc", "Esc"], ["Tab", "Tab"], ["↵ Enter", "Enter"], ["⌫ Borrar", "Backspace"]].map(([label, key]) => <button type="button" key={key} onClick={() => sendKey(key, label)}>{label}</button>)}
    </div>
    <details className="screen-command-details"><summary>Navegación y más teclas</summary>
      <div className="screen-navigation" role="group" aria-label="Flechas de navegación">
        {[["↑", "ArrowUp"], ["←", "ArrowLeft"], ["↓", "ArrowDown"], ["→", "ArrowRight"]].map(([label, key]) => <button type="button" key={key} aria-label={{ ArrowUp: "Flecha arriba", ArrowLeft: "Flecha izquierda", ArrowDown: "Flecha abajo", ArrowRight: "Flecha derecha" }[key]} onClick={() => sendKey(key)}>{label}</button>)}
      </div>
      <div className="screen-command-grid">
        {[["Suprimir", "Delete"], ["Espacio", "Space"], ["Inicio", "Home"], ["Fin", "End"], ["Página arriba", "PageUp"], ["Página abajo", "PageDown"]].map(([label, key]) => <button type="button" className="btn" key={key} onClick={() => sendKey(key, label)}>{label}</button>)}
      </div>
    </details>
    <small className="screen-command-feedback" role="status" aria-live="polite">{message || "Los comandos actúan sobre la ventana activa de tu PC."}</small>
  </div>
}
