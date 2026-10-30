import { useCallback, useEffect, useRef, useState } from "react"
import { readToken, hub, oc, AuthError, type HubInfo, type Permission, type Question } from "./api"
import { Home, type Route } from "./Home"
import { SessionScreen } from "./Session"
import { Icon } from "./ui"
import { TeamsScreen } from "./Teams"

type Toast = { title: string; body: string; url: string }

function routeFromUrl(raw: string): Route | null {
  const url = new URL(raw, window.location.origin)
  if (url.searchParams.has("teams")) return { kind: "teams", chatId: url.searchParams.get("chat") ?? undefined, runId: url.searchParams.get("run") ?? undefined }
  const project = url.searchParams.get("p")
  const id = url.searchParams.get("s")
  return project && id ? { kind: "session", project, id, title: "" } : null
}

function initialRoute(): Route {
  const deep = routeFromUrl(window.location.href)
  if (!deep) return { kind: "home" }
  if (deep.kind === "teams") return deep
  window.history.replaceState(null, "", "/")
  window.history.pushState({ session: true }, "")
  return deep
}

const TOKEN = readToken()
const START = initialRoute()

export function App() {
  const [token] = useState(TOKEN)
  const [route, setRoute] = useState<Route>(START)
  const [viewed, setViewed] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const current = useRef(route)
  const [fleetVisible, setFleetVisible] = useState(() => !new URLSearchParams(window.location.search).has("fleet"))

  useEffect(() => {
    if (window.parent === window) return
    let origin: string | null = null
    let stopped = false
    let reporting = false
    const report = async () => {
      if (reporting) return
      reporting = true
      try {
        const info = await hub<HubInfo>("GET", "/info")
        const summaries = await Promise.all(info.projects.map(async project => {
          const [status, permissions, questions] = await Promise.all([
            oc<Record<string, { type: string }>>("GET", "/session/status", project).catch(() => ({})),
            oc<Permission[]>("GET", "/permission", project).catch(() => []),
            oc<Question[]>("GET", "/question", project).catch(() => []),
          ])
          return { busy: Object.values(status).filter(s => s.type !== "idle").length, pending: permissions.length + questions.length }
        }))
        if (!stopped && origin) window.parent.postMessage({ type: "guillecode:status", state: "online", projects: info.projects.length, routines: info.routines.length, busy: summaries.reduce((n, s) => n + s.busy, 0), pending: summaries.reduce((n, s) => n + s.pending, 0) }, origin)
      } catch (error) {
        if (!stopped && origin) window.parent.postMessage({ type: "guillecode:status", state: error instanceof AuthError ? "unauthorized" : "offline" }, origin)
      } finally {
        reporting = false
      }
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== "guillecode:hello") return
      if (event.origin !== "https://fluws.com" && event.origin !== "http://localhost:3300") return
      origin = event.origin
      setFleetVisible(event.data.active === true)
      void report()
    }
    window.addEventListener("message", receive)
    return () => { stopped = true; window.removeEventListener("message", receive) }
  }, [])

  const go = useCallback((r: Route) => {
    current.current = r
    setRoute(r)
  }, [])

  const open = useCallback(
    (r: Route) => {
      const query = r.kind === "teams" ? new URLSearchParams({ teams: "1", ...(r.chatId ? { chat: r.chatId } : {}), ...(r.runId ? { run: r.runId } : {}) }) : r.kind === "session" ? new URLSearchParams({ p: r.project, s: r.id }) : new URLSearchParams()
      window.history.pushState({ session: true }, "", `/${query.size ? `?${query}` : ""}`)
      go(r)
      setToast(null)
    },
    [go],
  )

  const goHome = useCallback(() => {
    const last = current.current
    if (last.kind === "session") setViewed(last.id)
    go({ kind: "home" })
    window.history.replaceState(null, "", "/")
  }, [go])

  useEffect(() => {
    const pop = () => { const route = routeFromUrl(window.location.href); if (route) go(route); else goHome() }
    window.addEventListener("popstate", pop)
    return () => window.removeEventListener("popstate", pop)
  }, [go, goHome])

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string; title?: string; body?: string } | null
      if (!data?.url) return
      if (data.type === "open") {
        const r = routeFromUrl(data.url)
        if (r) open(r)
      }
      if (data.type === "push" && routeFromUrl(data.url)) {
        setToast({ title: data.title ?? "Flufy", body: data.body ?? "", url: data.url })
        if ("vibrate" in navigator) navigator.vibrate(80)
      }
    }
    navigator.serviceWorker.addEventListener("message", onMessage)
    return () => navigator.serviceWorker.removeEventListener("message", onMessage)
  }, [open])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 8000)
    return () => clearTimeout(timer)
  }, [toast])

  if (!fleetVisible) return <main className="screen center"><p>Flufy · conectada a Mis computadoras</p></main>

  if (!token)
    return (
      <main className="screen center">
        <img src="/icon-256.png" alt="" className="logo big" />
        <h1>Flufy</h1>
        <p className="muted">Abrí este link desde el QR de Flufy: comando «Conectar el celular».</p>
      </main>
    )

  const toastRoute = toast ? routeFromUrl(toast.url) : null
  const hideToast = !toastRoute || (route.kind === "session" && toastRoute.kind === "session" && route.id === toastRoute.id)

  return (
    <>
      {route.kind === "session" ? (
        <SessionScreen
          key={route.id}
          route={route}
          back={() => {
            if (window.history.state?.session) window.history.back()
            else goHome()
          }}
        />
      ) : route.kind === "teams" ? (
        <TeamsScreen route={route} back={goHome} open={open} />
      ) : (
        <Home open={open} viewed={viewed} />
      )}
      {toast && toastRoute && !hideToast && (
        <button type="button" className="toast" onClick={() => open(toastRoute)}>
          <Icon name="bell-dot" />
          <span className="card-text">
            <strong>{toast.title}</strong>
            {toast.body && <small>{toast.body}</small>}
          </span>
          <Icon name="chevron-right" />
        </button>
      )}
    </>
  )
}
