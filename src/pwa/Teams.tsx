import { useCallback, useEffect, useRef, useState } from "react"
import { TeamBoard, type BoardPatch } from "../team/TeamBoard"
import type { TeamRun } from "../team/types"
import { AuthError, hub } from "./api"
import type { Route } from "./Home"
import { Icon, Sheet, useLive, usePoll } from "./ui"
import "./teams.css"

type Chat = { id: string; title: string; archived: boolean; runs: { id: string; goal: string; status: string }[] }
type Selection = { chatId: string; runId: string }
type Evidence = { text?: string; mime?: string; data?: string; sha256?: string }

export function TeamsScreen({ route, back, open }: { route: Extract<Route, { kind: "teams" }>; back: () => void; open: (route: Route) => void }) {
  const [chats, setChats] = useState<Chat[]>([])
  const [selection, setSelection] = useState<Selection | null>(() => route.chatId && route.runId ? { chatId: route.chatId, runId: route.runId } : null)
  const [run, setRun] = useState<TeamRun | null>(null)
  const [online, setOnline] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [evidencePath, setEvidencePath] = useState("")
  const epoch = useRef(0)
  const request = useRef(0)
  const evidenceRequest = useRef(0)
  const sequence = useRef(-1)
  const current = useRef(selection)
  const eventTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const generation = epoch.current, id = ++request.current, selected = current.current
    try {
      const [list, snapshot] = await Promise.all([
        hub<{ chats: Chat[] }>("GET", "/teams"),
        selected ? hub<{ run: TeamRun; sequence: number }>("GET", `/teams/run?chat=${encodeURIComponent(selected.chatId)}&run=${encodeURIComponent(selected.runId)}`) : Promise.resolve(null),
      ])
      if (generation !== epoch.current || id !== request.current) return
      setChats(list.chats)
      if (snapshot && snapshot.sequence >= sequence.current) { sequence.current = snapshot.sequence; setRun(snapshot.run) }
      setOnline(true)
      setError(current => current.startsWith("Sin conexión") || current.startsWith("Acceso revocado") ? "" : current)
    } catch (error) {
      if (generation !== epoch.current || id !== request.current) return
      setOnline(false)
      setError(error instanceof AuthError ? "Acceso revocado. Volvé a conectar con el QR de la PC." : "Sin conexión con la PC. Se muestra el último estado recibido; los cambios están deshabilitados.")
      if (error instanceof AuthError) { setRun(null); setChats([]); setEvidence(null); sequence.current = -1 }
    }
  }, [])
  useEffect(() => {
    void load()
    // These are request-generation counters, not refs to DOM nodes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    return () => { epoch.current++; request.current++; if (eventTimer.current) clearTimeout(eventTimer.current) }
  }, [load])
  usePoll(load, 5000)
  useEffect(() => {
    const offline = () => { setOnline(false); setError("Sin conexión con la PC. Se muestra el último estado recibido; los cambios están deshabilitados.") }
    const online = () => { void load() }
    window.addEventListener("offline", offline); window.addEventListener("online", online)
    return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online) }
  }, [load])
  const live = useLive(null, event => {
    if (!["team.changed", "resync"].includes(event.type) || eventTimer.current) return
    eventTimer.current = setTimeout(() => { eventTimer.current = null; void load() }, 150)
  }, () => { void load() })

  const choose = (next: Selection | null) => {
    epoch.current++; sequence.current = -1; current.current = next
    setSelection(next); setRun(null); setOnline(false); setBusy(false); setError(""); setEvidenceOpen(false); evidenceRequest.current++
    const url = new URL(window.location.href)
    url.search = next ? new URLSearchParams({ teams: "1", chat: next.chatId, run: next.runId }).toString() : "teams=1"
    window.history.replaceState({ session: true }, "", url)
    void load()
  }
  const mutate = async (path: string, body: object) => {
    if (!online || busy || !selection) throw new Error("Esperá a que se confirme la conexión con la PC.")
    const generation = epoch.current
    setBusy(true); setError("")
    try {
      const result = await hub("POST", `/teams/${path}`, { chatId: selection.chatId, ...body })
      if (generation === epoch.current) await load()
      return result
    } catch (error) {
      if (generation === epoch.current) {
        await load()
        setError(`${error instanceof Error ? error.message : String(error)}. Se consultó el estado actual. No se reenvió la operación automáticamente.`)
      }
      throw error
    } finally { if (generation === epoch.current) setBusy(false) }
  }
  const control = async (action: string) => { await mutate("control", { runId: run!.id, action }) }
  const patch = (patch: BoardPatch) => mutate("patch", { patch })
  const act = (action: string) => { void control(action).catch(() => {}) }
  const showEvidence = async (path: string) => {
    const id = ++evidenceRequest.current
    setEvidence(null); setEvidencePath(path)
    try {
      const result = await hub<Evidence>("POST", "/teams/evidence", { chatId: selection!.chatId, runId: run!.id, path })
      if (id === evidenceRequest.current) setEvidence(result)
    } catch (error) { if (id === evidenceRequest.current) setEvidence({ text: String(error) }) }
  }
  const archived = chats.some(c => c.id === selection?.chatId && c.archived)
  const readOnly = !online || busy || archived
  return <main className="screen pwa-teams">
    <header className="topbar"><button className="icon-btn" aria-label="Volver" onClick={() => selection ? choose(null) : back()}><Icon name="arrow-left" /></button><h1>Equipos</h1><span className="spacer" /><button className="btn btn-sm" onClick={() => void load()}>Actualizar</button></header>
    {error && <div className="alert" role="alert">{error}</div>}
    {online && live === "down" && <p className="muted">Reconectando eventos · actualización periódica activa</p>}
    {!selection ? <section aria-label="Ejecuciones de equipos">{!chats.length && <p className="muted">No hay ejecuciones disponibles.</p>}{chats.map(chat => <section key={chat.id}><h2>{chat.title}{chat.archived ? " · Archivado" : ""}</h2>{chat.runs.map(run => <button className="card team-run-link" key={run.id} onClick={() => choose({ chatId: chat.id, runId: run.id })}><strong>{run.goal}</strong><small>{run.status}</small></button>)}</section>)}</section> : run ? <>
      <h2>{run.goal}</h2><p className="muted">{run.status} · Secuencia {run.planV2?.sequence ?? 0}{archived ? " · Solo lectura" : ""}</p>
      <div className="row team-controls">
        {run.status === "running" && <button className="btn" disabled={readOnly} onClick={() => act("pause")}>Pausar</button>}
        {run.status === "paused" && <button className="btn" disabled={readOnly} onClick={() => act("resume")}>Reanudar</button>}
        {run.status === "plan_ready" && <button className="btn primary" disabled={readOnly} onClick={() => act("start_plan")}>Iniciar plan validado</button>}
        {["blocked", "failed"].includes(run.status) && <button className="btn" disabled={readOnly} onClick={() => act("retry")}>Reintentar</button>}
        {["completed", "awaiting_manual_qa"].includes(run.status) && <button className="btn primary" disabled={readOnly} onClick={() => act("approve")}>Aprobar entrega</button>}
        {["planning", "plan_ready", "planning_blocked", "running", "paused", "blocked"].includes(run.status) && <button className="btn" disabled={readOnly} onClick={() => { if (window.confirm("¿Cancelar esta ejecución?")) act("cancel") }}>Cancelar ejecución</button>}
      </div>
      <TeamBoard key={run.id} run={run} readOnly={readOnly} onPatch={patch} onRetry={() => control("retry")} onEvidence={() => setEvidenceOpen(true)} onSession={(id, project) => open({ kind: "session", id, project, title: "Sesión del equipo" })} />
      <form className="team-lead-message" onSubmit={e => { e.preventDefault(); if (!message.trim()) return; void mutate("message", { text: message }).then(() => setMessage("")).catch(() => {}) }}><label>Escribir al Lead<textarea value={message} maxLength={20000} onChange={e => setMessage(e.target.value)} disabled={readOnly} placeholder="Aclaraciones o cambios del objetivo" /></label><button className="btn primary" disabled={readOnly || !message.trim()}>Enviar al Lead</button></form>
      {evidenceOpen && <Sheet title="Evidencias del equipo" onClose={() => { evidenceRequest.current++; setEvidenceOpen(false); setEvidence(null); setEvidencePath("") }}>
        <p className="muted">Archivos registrados por el motor. Las capturas se verifican por hash antes de mostrarse.</p>
        {run.artifacts.map(artifact => <button key={artifact.id} className="btn team-artifact" disabled={!online || artifact.status !== "captured"} onClick={() => void showEvidence(artifact.relativePath)}>{artifact.relativePath} · {artifact.status}</button>)}
        {!run.artifacts.length && <p>No hay artefactos registrados.</p>}
        {evidencePath && <h3>{evidencePath}</h3>}{evidence?.text && <pre>{evidence.text}</pre>}{evidence?.mime === "image/png" && evidence.data && <><img className="team-evidence-image" src={`data:image/png;base64,${evidence.data}`} alt={evidencePath} /><p className="muted">SHA-256: {evidence.sha256}</p></>}
      </Sheet>}
    </> : <p className="muted">Consultando el estado de la ejecución…</p>}
  </main>
}
