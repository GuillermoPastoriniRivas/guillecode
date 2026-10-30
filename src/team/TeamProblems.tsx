import { Icon } from "../components/ui"
import { useRef } from "react"
import type { TeamAttention } from "./attention"
import type { TeamRun } from "./types"
import { problemBrief, problemHelp } from "./problem"

export function TeamProblems({ items, run, pending, onInspect, onSettings, onAsk, onContinue }: {
  items: TeamAttention[]; run?: TeamRun; pending: boolean; onInspect: (item: TeamAttention) => void; onSettings: () => void; onAsk: () => void; onContinue: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = () => dialog.current?.close()
  const blocked = items.filter(i => i.kind !== "waiting")
  const waiting = items.filter(i => i.kind === "waiting")
  const render = (item: TeamAttention, expanded = false) => {
    const help = problemHelp(item)
    const brief = problemBrief(item, run)
    const details = <dl><div><dt>Qué pasó</dt><dd>{item.reason}</dd></div><div><dt>Qué podés hacer</dt><dd>{help.text}</dd></div></dl>
    return <article key={item.id} className={`team-problem-card ${item.kind}`}>
      <div className="team-problem-heading"><Icon name={item.kind === "waiting" ? "clock" : "warning"} /><strong>{item.name}</strong><span>{item.kind === "waiting" ? "En espera" : item.kind === "permission" ? "Necesita un permiso" : item.kind === "question" ? "Necesita una respuesta" : "Necesita ayuda"}</span></div>
      {expanded ? <><p className="team-problem-task">{item.task}</p>{details}</> : <>
        <div className="team-problem-brief"><p><strong>Tenía:</strong> {brief.work}.</p><p><strong>{item.kind === "waiting" ? "Espero" : "Me frena"}:</strong> {brief.blocked}. {brief.because}.</p><p><strong>Para seguir:</strong> {brief.next}</p></div>
        <details className="team-problem-details"><summary>Ver detalles</summary>{details}</details>
      </>}
      <div className="team-problem-actions"><button className="btn btn-sm" onClick={() => { close(); onInspect(item) }}>{item.kind === "permission" ? "Ver permiso" : item.kind === "question" ? "Responder al agente" : "Ver última actividad"}</button>{help.model && <button className="btn btn-sm" onClick={() => { close(); onSettings() }}>Cambiar modelo</button>}</div>
    </article>
  }
  return <><section className="team-attention" aria-label="Bloqueos del equipo">
    <div className="team-problems-title"><h3>{blocked.length ? "El equipo necesita ayuda" : "El Lead coordina estas esperas"}</h3><button className="btn btn-xs" onClick={() => dialog.current?.showModal()}><Icon name="screen-full" /> Ampliar diagnóstico</button></div>
    {!blocked.length && <p className="team-problem-intro">Los integrantes conservan su trabajo mientras el Lead organiza cómo continuar. No necesitás intervenir ahora.</p>}
    <div className="team-attention-list">{blocked.map(item => render(item))}</div>
    {waiting.length > 0 && (blocked.length ? <details className="team-waiting-details"><summary>{waiting.length} {waiting.length === 1 ? "integrante en espera" : "integrantes en espera"}</summary>{waiting.map(item => render(item))}</details> : <div className="team-attention-list">{waiting.map(item => render(item))}</div>)}
    <div className="team-problem-actions"><button className="btn btn-sm" onClick={onAsk}>Preguntarle al Lead qué pasó</button>{run && ["blocked", "failed", "planning_blocked"].includes(run.status) && <button className="btn btn-primary" disabled={pending} onClick={onContinue}>Continuar lo pendiente</button>}</div>
    {run?.status === "running" && blocked.length > 0 && run.tasks.some(t => ["running", "verifying"].includes(t.status) && !items.some(i => i.id === t.id)) && <p className="team-note">Las tareas independientes siguen trabajando.</p>}
  </section>
    <dialog ref={dialog} className="team-problem-dialog" aria-label="Diagnóstico del equipo">
      <div className="team-problems-title"><h2>Diagnóstico del equipo</h2><button className="btn btn-sm" onClick={close}>Cerrar diagnóstico</button></div>
      <div className="team-attention-list">{blocked.map(item => render(item, true))}{!blocked.length && waiting.map(item => render(item, true))}</div>
      {!!blocked.length && !!waiting.length && <details className="team-waiting-details"><summary>{waiting.length} {waiting.length === 1 ? "integrante en espera" : "integrantes en espera"}</summary>{waiting.map(item => render(item, true))}</details>}
      <div className="team-problem-actions"><button className="btn btn-sm" onClick={() => { close(); onAsk() }}>Preguntarle al Lead qué pasó</button></div>
    </dialog>
  </>
}
