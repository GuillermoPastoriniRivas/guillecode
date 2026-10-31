import { useEffect, useRef, useState } from "react"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { Icon } from "../components/ui"

let presentationGeneration = Date.now() * 1000

type BrowserPage = { label: string; actor: string; url: string }

// La WebView2 nativa siempre se dibuja sobre el HTML del chat, así que un modal,
// popover o menú que tape esta zona quedaría detrás de la página. En vez de
// enumerar overlays, se comprueba que el host siga siendo el elemento de arriba
// en varios puntos de su rectángulo.
function unobstructed(host: HTMLElement, r: DOMRect) {
  const inset = 4
  const xs = [r.left + inset, r.left + r.width / 2, r.right - inset]
  const ys = [r.top + inset, r.top + r.height / 2, r.bottom - inset]
  for (const x of xs) for (const y of ys) {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
    const hit = document.elementFromPoint(x, y)
    if (!hit || (hit !== host && !host.contains(hit))) return false
  }
  return true
}

// Superficie del navegador interno de Flufy. Las páginas viven en una WebView2
// propia por conversación; este componente sólo les da lugar y navegación.
export function BrowserPane({ session, names = {} }: { session: string; names?: Record<string, string> }) {
  const [pages, setPages] = useState<BrowserPage[]>([])
  const [selected, setSelected] = useState("")
  const [address, setAddress] = useState<string | undefined>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const surface = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    const refresh = async () => {
      try {
        const next = await call<BrowserPage[]>("browser_internal_pages", { session })
        if (!disposed) { setPages(next); setSelected(previous => next.some(p => p.label === previous) ? previous : next[0]?.label ?? "") }
      } catch(e) { if (!disposed) setError(errorMessage(e)) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [session])
  const page = pages.find(p => p.label === selected)
  useEffect(() => {
    const host = surface.current
    if (!isTauri || !host || !selected) return
    let disposed = false, running = false
    let last = ""
    const sync = async () => {
      if (disposed || running) return
      const r = host.getBoundingClientRect(), d = window.devicePixelRatio || 1
      const visible = r.width > 0 && r.height > 0 && unobstructed(host, r)
      const bounds = visible ? {x:r.x*d,y:r.y*d,width:r.width*d,height:r.height*d} : null
      const key = JSON.stringify(bounds)
      if (key === last) return
      running = true
      try { await call("browser_internal_view",{session,label:visible ? selected : null,bounds,generation:++presentationGeneration}); if (!disposed) last=key }
      catch(e) { if (!disposed) setError(errorMessage(e)) }
      finally { running = false }
    }
    void sync()
    const resize = new ResizeObserver(() => void sync()); resize.observe(host)
    const timer = window.setInterval(() => void sync(), 250)
    return () => {
      disposed=true; resize.disconnect(); window.clearInterval(timer)
      void call("browser_internal_view",{session,label:null,bounds:null,generation:++presentationGeneration}).catch(() => {})
    }
  }, [session, selected])
  const navigate = async () => {
    if (busy) return
    setBusy(true);setError("")
    try {
      const opened=await call<BrowserPage>("browser_internal_open",{session,url:(address ?? page?.url ?? "").trim() || null,label:selected || null})
      setPages(previous => [...previous.filter(p => p.label!==opened.label),opened]);setSelected(opened.label);setAddress(undefined)
    } catch(e) {setError(errorMessage(e))} finally {setBusy(false)}
  }
  const control = async (action:string) => {
    try { await call("browser_internal_control",{session,label:selected,action}) }
    catch(e) {setError(errorMessage(e))}
  }
  const label = (p: BrowserPage, i: number) => {
    const own = p.actor === "user" || p.actor === session
    if (own && pages.length === 1) return "Tu página"
    const host = p.url.replace(/^https?:\/\//, "").split("/")[0]
    if (own) return host || `Página ${i + 1}`
    return names[p.actor] || `Agente ${i + 1}`
  }
  return <section className="team-browser" aria-label="Navegador de este chat">
    <div className="team-browser-tabs" role="tablist" aria-label="Páginas de los agentes">
      {pages.map((p,i) => <button type="button" key={p.label} role="tab" aria-selected={p.label===selected} onClick={() => {setSelected(p.label);setAddress(undefined)}} title={p.url}>{label(p, i)}</button>)}
    </div>
    <form className="team-browser-toolbar" onSubmit={e=>{e.preventDefault();void navigate()}}>
      <button className="btn btn-xs" type="button" disabled={!selected} aria-label="Retroceder" onClick={()=>void control("back")}><Icon name="arrow-left" /></button>
      <button className="btn btn-xs" type="button" disabled={!selected} aria-label="Recargar página" onClick={()=>void control("reload")}><Icon name="refresh" /></button>
      <input aria-label="Dirección del navegador del chat" value={address ?? page?.url ?? ""} onChange={e=>setAddress(e.target.value)} placeholder="https://…" />
      <button className="btn btn-xs" disabled={busy || !isTauri}>{busy ? "Abriendo…" : "Abrir"}</button>
    </form>
    {error && <p className="team-error" role="alert">{error}</p>}
    <div className="team-browser-surface" ref={surface}>
      {!selected && <p>Escribí una dirección para abrir tu página. Cuando los agentes naveguen, sus páginas aparecerán acá. Podés cambiar de vista mientras siguen trabajando.</p>}
    </div>
  </section>
}
