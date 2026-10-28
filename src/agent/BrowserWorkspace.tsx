import { useEffect, useRef, useState } from "react"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { Icon } from "../components/ui"
import { notify } from "../state/toasts"
import { patchSessionRuntime, useSessionRuntime } from "../state/session-runtime"

type Page = { id: number; windowId: number | null; url: string }
type Workspace = { internal?: boolean; assigned: boolean; missing: boolean; windowId: number | null; pages: Page[] }

// All tabs in the chosen window belong to the agent's workspace. The Chrome
// profile (cookies/accounts) is shared; personal tabs should be in other windows.
export function BrowserWorkspace({ sessionId, shared = false }: { sessionId: string; shared?: boolean }) {
  const [state, setState] = useState<Workspace | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const [url, setUrl] = useState("")
  const host = useRef<HTMLDivElement>(null)
  const runtime = useSessionRuntime(sessionId)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false) } }
    window.addEventListener("pointerdown", outside)
    window.addEventListener("keydown", escape, true)
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true) }
  }, [open])

  const inspect = async () => {
    setBusy(true); setError("")
    try { setState(await call<Workspace>("browser_workspace", { session: sessionId, pageId: null })) }
    catch (e) { setError(errorMessage(e)); setState(null) }
    finally { setBusy(false) }
  }

  if (!isTauri) return null

  const assign = async (page: Page) => {
    setBusy(true)
    try {
      const workspace = await call<Workspace>("browser_workspace", { session: sessionId, pageId: page.id })
      setState(workspace)
      if (workspace.assigned && workspace.windowId !== null) patchSessionRuntime(sessionId, { browserWindow: workspace.windowId })
      setOpen(false)
    } catch (e) {
      notify.error("No se pudo asignar la ventana del browser", errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const openInternal = async () => {
    setBusy(true); setError("")
    try {
      await call("browser_internal_open", { session: sessionId, url: url.trim() || null })
      setState({internal:true, assigned:true, missing:false, windowId:null, pages:[]})
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }

  const controlInternal = async (action: string) => {
    try { await call("browser_internal_control", {session: sessionId, action}) }
    catch (e) { setError(errorMessage(e)) }
  }
  const windows = new Map<number, Page[]>()
  for (const page of state?.pages ?? []) {
    if (page.windowId == null) continue
    windows.set(page.windowId, [...(windows.get(page.windowId) ?? []), page])
  }
  const owned = state?.assigned ? state.pages.filter(page => page.windowId === state.windowId) : []

  return (
    <div className="composer-workspace" ref={host}>
      <button
        type="button"
        className={`composer-pill${state?.assigned ? " set" : state?.missing ? " warn" : ""}`}
        title={state?.internal ? "Navegador propio de GuilleCode con el perfil de este equipo" : state?.assigned
          ? "El agente puede usar todas las pestañas de la ventana asignada. Conservá tus pestañas personales en otra ventana."
          : "Elegí una ventana del browser para que el agente trabaje ahí sin interrumpirte."}
        aria-expanded={open}
        disabled={busy}
        onClick={() => { setOpen((v) => !v); if (!open && !shared) void inspect() }}
      >
        <Icon name="globe" />
        <span>{busy ? "Consultando navegador…" : state?.internal ? "Navegador interno" : state?.assigned ? `Navegador · ${owned.length} pestañas` : state?.missing ? "Navegador: elegí ventana" : runtime.browserWindow !== undefined ? "Navegador asignado" : shared ? "Navegador del equipo" : "Elegir navegador"}</span>
      </button>
      {open && (
        <div className="composer-popover">
          <div className="composer-popover-title">Ventana del navegador para {shared ? "este equipo" : "esta conversación"}</div>
          {shared && <>
            <p>El navegador interno abre una ventana propia de GuilleCode. El equipo trabaja ahí mientras vos seguís con lo tuyo. Sus cuentas se guardan en el perfil de este equipo.</p>
            <input aria-label="Página para el navegador interno" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void openInternal() } }} />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void openInternal()}>{state?.internal ? "Mostrar / abrir página" : "Abrir navegador interno"}</button>
            {state?.internal && <div className="team-actions">{[["back", "Atrás"], ["forward", "Adelante"], ["reload", "Recargar"], ["show", "Ver navegador"]].map(([action,label]) => <button key={action} type="button" className="btn btn-xs" onClick={() => void controlInternal(action)}>{label}</button>)}</div>}
            <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void inspect()}>Consultar páginas del equipo</button>
          </>}
          {!shared && <p>{shared ? "El Lead y los especialistas comparten esta ventana y trabajan en pestañas propias. " : "El agente usará todas sus pestañas. "}Cookies y cuentas son compartidas.</p>}
          {error && <div role="alert">{error}</div>}
          {!shared && !busy && !error && windows.size === 0 && (
            <div className="composer-suggestion-desc">No veo pestañas del browser. Habilitá las DevTools remotas del navegador y volvé a abrir esta lista.</div>
          )}
          {[...windows.entries()].map(([win, pages], i) => (
            <div key={win}>
              <div className="composer-suggestion-desc">{state?.assigned && win === state.windowId ? `Ventana ${i + 1} · asignada` : `Ventana ${i + 1}`}</div>
              {pages.map((page) => (
                <button
                  type="button"
                  key={page.id}
                  className={`composer-suggestion${state?.assigned && page.windowId === state.windowId ? " selected" : ""}`}
                  disabled={busy}
                  title={`Asignar la ventana que contiene ${page.url}`}
                  onClick={() => void assign(page)}
                >
                  <Icon name="globe" />
                  <span className="composer-suggestion-label">{page.url || "(sin título)"}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
