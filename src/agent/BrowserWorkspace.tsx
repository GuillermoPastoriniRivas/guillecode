import { useEffect, useRef, useState } from "react"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { Icon } from "../components/ui"
import { notify } from "../state/toasts"
import { draftRuntimeKey, patchSessionRuntime, useSessionRuntime } from "../state/session-runtime"
import { openEditor } from "../state/editors"
import { useProject } from "../state/project"
import { windowLabel } from "../lib/windows"

type Page = { id: number; windowId: number | null; url: string }
type Workspace = { internal?: boolean; assigned: boolean; missing: boolean; windowId: number | null; pages: Page[] }

// El agente usa una ventana completa de Chrome o el navegador interno de Flufy.
// En una conversación nueva la elección queda guardada y se aplica al enviar.
export function BrowserWorkspace({ sessionId, shared = false }: { sessionId: string | null; shared?: boolean }) {
  const root = useProject((s) => s.root)
  const runtimeKey = sessionId ?? draftRuntimeKey(root, windowLabel())
  const runtime = useSessionRuntime(runtimeKey)
  const draft = !sessionId
  const choice = draft ? runtime.browserChoice : undefined
  const [state, setState] = useState<Workspace | null>(null)
  const [chrome, setChrome] = useState<Workspace | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const [url, setUrl] = useState("")
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false) } }
    window.addEventListener("pointerdown", outside)
    window.addEventListener("keydown", escape, true)
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true) }
  }, [open])

  const inspect = async () => {
    if (!sessionId) return
    setBusy(true); setError("")
    try { setState(await call<Workspace>("browser_workspace", { session: sessionId, pageId: null })) }
    catch (e) { setError(errorMessage(e)); setState(null) }
    finally { setBusy(false) }
  }

  const inspectChrome = async () => {
    try { setChrome(await call<Workspace>("browser_chrome_workspace", { session: runtimeKey })) }
    catch { setChrome(null) }
  }

  useEffect(() => {
    if (sessionId) void inspect()
    else void inspectChrome()
    // La asignación vive en el backend: al abrir la conversación hay que
    // reflejar si ya estaba usando Chrome o el navegador interno.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (!isTauri || (shared && !sessionId)) return null

  const refresh = () => { void inspect(); void inspectChrome() }

  const chooseDraft = (value: NonNullable<typeof runtime.browserChoice>) => {
    patchSessionRuntime(runtimeKey, { browserChoice: value })
    setOpen(false)
  }

  const assign = async (page: Page, tabs = 1) => {
    if (draft) {
      chooseDraft({ kind: "chrome", pageId: page.id, windowId: page.windowId ?? 0, tabs })
      return
    }
    setBusy(true)
    try {
      if (state?.internal) await call("browser_internal_off", { session: sessionId })
      const workspace = await call<Workspace>("browser_workspace", { session: sessionId, pageId: page.id })
      setState(workspace)
      if (workspace.assigned && workspace.windowId !== null) patchSessionRuntime(runtimeKey, { browserWindow: workspace.windowId })
      setOpen(false)
    } catch (e) {
      notify.error("No se pudo asignar la ventana del browser", errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const openBrowserTab = () => {
    if (!sessionId) return
    openEditor({ kind: "browser", sessionId })
    setOpen(false)
  }

  const openInternal = async () => {
    if (draft) { chooseDraft({ kind: "internal" }); return }
    if (state?.internal) { openBrowserTab(); return }
    setBusy(true); setError("")
    try {
      await call("browser_internal_open", { session: sessionId, url: null })
      setState({ internal: true, assigned: true, missing: false, windowId: null, pages: [] })
      if (!shared) { openEditor({ kind: "browser", sessionId }); setOpen(false) }
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }

  const leaveInternal = async () => {
    setBusy(true); setError("")
    try {
      await call("browser_internal_off", { session: sessionId })
      setState(null)
      await inspect()
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }

  const chromePages = (draft || state?.internal ? chrome : state ?? chrome)?.pages ?? []
  const windows = new Map<number, Page[]>()
  for (const page of chromePages) {
    if (page.windowId == null) continue
    windows.set(page.windowId, [...(windows.get(page.windowId) ?? []), page])
  }
  const groups = [...windows.entries()].map(([id, pages]) => ({
    id,
    pages,
    host: (pages[0]?.url ?? "").replace(/^https?:\/\//, "").split("/")[0],
  }))
  const owned = state?.assigned ? state.pages.filter(page => page.windowId === state.windowId) : []
  const internalChosen = draft ? choice?.kind === "internal" : !!state?.internal
  const chromeChoice = choice?.kind === "chrome" ? choice : null
  const pillSet = draft ? !!choice : !!state?.assigned
  const label = busy ? "Consultando navegador…"
    : draft ? (choice?.kind === "internal" ? "Navegador interno" : choice?.kind === "chrome" ? `Navegador · ${choice.tabs} pestaña${choice.tabs === 1 ? "" : "s"}` : "Elegir navegador")
    : state?.internal ? `Navegador interno${state.pages.length ? ` · ${state.pages.length} pág.` : ""}` : state?.assigned ? `Navegador · ${owned.length} pestañas` : state?.missing ? "Navegador: elegí ventana" : runtime.browserWindow !== undefined ? "Navegador asignado" : shared ? "Navegador del equipo" : "Elegir navegador"

  return (
    <div className="composer-workspace" ref={host}>
      <button
        type="button"
        className={`composer-pill${pillSet ? " set" : state?.missing ? " warn" : ""}`}
        title={internalChosen ? "Navegador propio de Flufy con perfil separado de tu Chrome" : state?.assigned
          ? "El agente puede usar todas las pestañas de la ventana asignada. Podés compartirla con otra conversación."
          : "Elegí una ventana de Chrome o el navegador interno para que el agente trabaje ahí."}
        aria-expanded={open}
        disabled={busy}
        onClick={() => { setOpen((v) => !v); if (!open && !shared) refresh() }}
      >
        <Icon name="globe" />
        <span>{label}</span>
      </button>
      {open && (
        <div className="composer-popover">
          <div className="composer-popover-title">{shared ? "Navegador del equipo" : "Navegador para esta conversación"}</div>
          {shared ? (
            <>
              <p>El navegador interno usa un perfil propio de Flufy, separado de tu Chrome personal. El equipo trabaja ahí mientras vos seguís con lo tuyo.</p>
              <input aria-label="Página para el navegador interno" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} />
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void openInternal()}>Abrir navegador interno</button>
              <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void inspect()}>Consultar páginas</button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`composer-suggestion${internalChosen ? " selected" : ""}`}
                disabled={busy}
                title={internalChosen ? "Abrir la pestaña del navegador interno" : "Usar el navegador interno de Flufy"}
                onClick={() => void openInternal()}
              >
                <Icon name="globe" />
                <span className="composer-suggestion-label">Navegador interno{internalChosen ? " · en uso" : ""}</span>
                <span className="composer-suggestion-desc">{draft ? "Se abre al enviar el primer mensaje" : "Perfil propio de Flufy, sin tocar tu Chrome"}</span>
              </button>
              <div className="composer-popover-title">Ventanas de Chrome</div>
              {!busy && groups.length === 0 && (
                <div className="composer-suggestion-desc">No veo ventanas de Chrome. Habilitá las DevTools remotas del navegador y volvé a abrir esta lista.</div>
              )}
              {groups.map((group, i) => {
                const assigned = draft ? chromeChoice?.windowId === group.id : !state?.internal && state?.assigned && group.id === state.windowId
                return (
                  <button
                    type="button"
                    key={group.id}
                    className={`composer-suggestion${assigned ? " selected" : ""}`}
                    disabled={busy}
                    title={`Asignar la ventana completa (${group.pages.length} pestañas)`}
                    onClick={() => void assign(group.pages[0], group.pages.length)}
                  >
                    <Icon name="globe" />
                    <span className="composer-suggestion-label">Ventana {i + 1}{assigned ? " · asignada" : ""}</span>
                    <span className="composer-suggestion-desc">
                      {group.pages.length} pestaña{group.pages.length === 1 ? "" : "s"}{group.host ? ` · ${group.host}` : ""}
                    </span>
                  </button>
                )
              })}
              {!draft && state?.internal && (
                <div className="team-actions">
                  <button type="button" className="btn btn-xs" disabled={busy} onClick={openBrowserTab}>Ver en una pestaña</button>
                  <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void leaveInternal()}>Volver a mi Chrome</button>
                </div>
              )}
            </>
          )}
          {error && <div role="alert">{error}</div>}
        </div>
      )}
    </div>
  )
}
