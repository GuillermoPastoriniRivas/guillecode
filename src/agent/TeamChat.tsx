import { useEffect, useRef, useState } from "react"
import { teamCall, useTeams } from "../state/teams"
import { useAgent } from "../state/agent"
import { modelKey, rememberSessionDirectory } from "../lib/opencode"
import { openEditor } from "../state/editors"
import { confirmAction } from "../components/Dialog"
import { Icon } from "../components/ui"
import { Markdown } from "./Markdown"
import { statusLabel, runActive, type TeamRun } from "../team/types"
import { formatDateTime } from "../lib/time"
import { EvidenceComparison } from "../team/EvidenceComparison"
import { RunBudget } from "../team/RunBudget"
import { isAccountLimitError, readableTeamError } from "../lib/provider-error"
import { LeadReply } from "./LeadReply"
import { firstTeamSentence } from "../lib/team-response"
import { recoveryHint, runProblem, taskProblem } from "../team/problem"
import { ChatImages } from "../team/ChatImages"
import { TeamComposer } from "../team/TeamComposer"
import { TeamSettings } from "../team/TeamSettings"

function RunReply({ run }: { run: TeamRun }) {
  const pending = run.error ? runProblem(run) : run.status === "awaiting_manual_qa" ? "Falta tu revisión manual de la entrega." : run.status === "qa_approved" ? "Entrega aprobada. Podés enviar el siguiente pedido." : "El equipo todavía está trabajando."
  const brief = run.chatSummary ? { ...run.chatSummary, pending: run.error || ["awaiting_manual_qa", "qa_approved"].includes(run.status) ? pending : run.chatSummary.pending } : undefined
  return <LeadReply brief={brief} fallback={{
    done: run.summary ? firstTeamSentence(run.summary) : run.tasks.length ? `Organicé ${run.tasks.length} tareas; ${run.tasks.filter(t => t.status === "completed").length} están terminadas.` : "Estoy revisando tu pedido y organizando el trabajo.",
    tested: run.closingReviews?.at(-1)?.status === "approved" ? "Revisé las entregas y sus comprobaciones. Podés ver el informe en los detalles." : "Las comprobaciones se registran en Actividad; todavía no hay una revisión final aprobada.",
    pending,
  }}><Markdown text={run.summary || (run.error ? readableTeamError(run.error) : "Todavía no hay un informe técnico final.")} /></LeadReply>
}

function openSession(id: string, directory: string) {
  rememberSessionDirectory(id, directory)
  openEditor({ kind: "chat", sessionId: id })
}

const reviewLabels: Record<string, string> = { approved: "Aprobado", changes_requested: "Necesita una corrección", review_error: "No se pudo completar la revisión" }

function Results({ run, history }: { run: TeamRun; history: TeamRun[] }) {
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null)
  return <div className="team-results">
    <h3>{statusLabel[run.status]}</h3>
    <RunReply run={run} />
    <p className="team-note selectable">{run.evidenceDir}</p>
    <div className="team-actions"><button className="btn btn-sm" onClick={() => void teamCall("team_evidence_open", { runId: run.id })}><Icon name="folder-opened" /> Abrir carpeta</button></div>
    {run.evidenceExpiredAt && <p className="team-note">Las evidencias de esta entrega expiraron según la retención configurada. El historial del trabajo se conserva.</p>}
    <EvidenceComparison run={run} history={history} />
    {run.artifacts.map((a) => <article className="team-artifact" key={a.id}>
      <div><strong>{a.phase} · {a.kind}</strong><p>{a.relativePath || "Sin archivo de captura"}</p><small>{a.source} · {formatDateTime(a.capturedAt)}</small></div>
      {a.status === "captured" && a.kind !== "screenshot" ? <button className="btn btn-xs" onClick={() => void teamCall<string>("team_evidence_read", { runId: run.id, path: a.relativePath }).then((text) => { if (text !== null) setPreview({ title: a.relativePath, text }) })}>{a.kind === "diff" ? "Abrir diff" : "Ver evidencia"}</button> : a.status !== "captured" ? <p className="team-note">No disponible: {a.reason ? readableTeamError(a.reason) : "El archivo no está disponible."}</p> : <span className="team-note">Ver en el comparador</span>}
    </article>)}
    {preview && <section className="team-card"><div className="team-section-title"><h4>{preview.title}</h4><button className="btn btn-xs" onClick={() => setPreview(null)}>Cerrar</button></div><pre className="team-evidence-preview">{preview.text}</pre></section>}
  </div>
}

export function TeamChat({ chatId }: { chatId: string }) {
  const chat = useTeams((s) => s.chats.find((c) => c.id === chatId))
  const models = useAgent((s) => s.models)
  const [view, setView] = useState("Chat")
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const messages = chat?.messages ?? []
  useEffect(() => { if (view === "Chat") bottom.current?.scrollIntoView({ block: "nearest" }) }, [messages.length, messages.at(-1)?.status, view])
  useEffect(() => { if (view === "Configuración" && body.current) body.current.scrollTop = 0 }, [view, selectedRunId])
  if (!chat) return <div className="team-note">Cargando conversación de equipo…</div>
  const run = chat.runs.find((r) => r.id === selectedRunId) ?? chat.runs.at(-1)
  const roster = run?.team ?? chat.team
  const latest = chat.runs.at(-1)
  const runError = run?.error ?? ""
  const automaticPlanRecovery = /plan debe contener entre 1 y 100 tareas|respuesta estructurada inválida/i.test(runError)
  const budgetBlocked = /presupuesto|límite de tokens|duración máxima/i.test(runError)
  const modelBlocked = /modelo|proveedor|variante/i.test(runError) || isAccountLimitError(runError)
  const pendingReply = messages.some(m => m.status === "pending")
  const act = (action: string) => run && teamCall("team_runs_control", { runId: run.id, action })
  return <section className="team-chat">
    <header className="team-chat-header"><div className="team-section-title"><strong><Icon name="organization" /> {chat.title}</strong><button className="btn btn-xs" type="button" aria-label="Configuración del equipo" aria-pressed={view === "Configuración"} onClick={() => setView(view === "Configuración" ? "Chat" : "Configuración")}><Icon name="settings-gear" /> Configuración</button></div><p>{roster.members.length} integrantes · {run ? statusLabel[run.status] : "Listo para recibir tu objetivo"}</p>{roster.autonomous && <details className="team-roster"><summary>Equipo elegido por el Lead</summary>{roster.members.map(m => <p key={m.id}>{m.name} · {m.role}</p>)}</details>}</header>
    <nav className="team-chat-nav" aria-label="Vistas del equipo">{["Chat", "Tareas", "Actividad", "Resultados / Comportamientos"].map((v) => <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v}</button>)}</nav>
    {chat.runs.length > 1 && <label className="team-run-select">Entrega / ejecución<select value={run?.id} onChange={(e) => setSelectedRunId(e.target.value)}>{chat.runs.map((r, i) => <option value={r.id} key={r.id}>#{i + 1} · {formatDateTime(r.startedAt)} · {statusLabel[r.status]}</option>)}</select></label>}
    {run && <div className="team-run-controls">
      {["planning", "running"].includes(run.status) && <button className="btn btn-xs" onClick={() => void act("pause")}>Pausar nuevas tareas</button>}
      {run.status === "paused" && <button className="btn btn-xs" onClick={() => void act("resume")}>Reanudar</button>}
      {["blocked", "failed"].includes(run.status) && <button className="btn btn-xs" onClick={() => void act("retry")}>Continuar lo pendiente</button>}
      {(runActive(run.status) || run.status === "blocked") && run.status !== "cancelling" && <button className="btn btn-xs" onClick={() => void confirmAction("Cancelar ejecución", "Se abortan las sesiones y se conservan los cambios ya aplicados. Revisá Git antes de continuar.", "Cancelar ejecución", true).then((yes) => { if (yes) void act("cancel") })}>Cancelar ejecución</button>}
      {run.status === "awaiting_manual_qa" && <button className="btn btn-xs" onClick={() => void act("approve")}>Aprobar QA manual</button>}
    </div>}
    {run?.error && <div className="team-error" role="status">{automaticPlanRecovery ? "El Lead devolvió un plan incompleto. GuilleCode lo reparará al continuar." : runProblem(run)}</div>}
    {run && ["blocked", "failed"].includes(run.status) && <p className="team-note">{recoveryHint(run)}</p>}
    <div className="team-chat-body" ref={body}>
      {run?.status === "blocked" && budgetBlocked && <RunBudget key={run.id} run={run} />}
      {run?.status === "blocked" && modelBlocked && <details className="team-card"><summary>Cambiar el modelo que falló</summary><p className="team-note">La configuración original del chat y los intentos anteriores se conservan.</p>{run.team.members.map((a) => <label key={a.id}>{a.name} · {a.role}<select aria-label={`Modelo de ${a.name}`} value={modelKey(a.model)} onChange={(e) => {const m=models.find((v)=>modelKey(v)===e.target.value);if(m)void teamCall("team_runs_model",{runId:run.id,agentId:a.id,model:{providerID:m.providerID,modelID:m.modelID},variant:null})}}><option value={modelKey(a.model)}>{modelKey(a.model)}</option>{models.filter((m)=>modelKey(m)!==modelKey(a.model)).map((m)=><option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>)}</details>}
      {view === "Chat" && <>
        {!chat.runs.length && <div className="team-chat-welcome"><Icon name="organization" /><h2>{chat.team.autonomous ? "Contame qué querés hacer" : "Un objetivo para todo el equipo"}</h2><p>{chat.team.autonomous ? "Hablás con el Lead. Él decide cuántos especialistas necesita, reparte las tareas y pone a trabajar en paralelo lo que se pueda hacer a la vez." : "El Lead descubre el proyecto, delega y revisa. Vas a recibir una entrega con evidencias y QA manual pendiente."}</p><p className="team-note">Podés preguntar qué pasó o dar indicaciones mientras trabajan. Las consultas de estado usan el registro guardado.</p></div>}
        {[...chat.runs.map((r, i) => ({ at: r.startedAt, key: r.id, node: <article className="team-chat-message"><small>Objetivo {i + 1} · {formatDateTime(r.startedAt)}</small><p className="selectable">{r.goal}</p><ChatImages images={r.images} /><div className="team-lead-message"><strong>Team Lead · {statusLabel[r.status]}</strong><RunReply run={r} />{r.finishedAt && <button className="btn btn-xs" onClick={() => { setSelectedRunId(r.id); setView("Resultados / Comportamientos") }}>Ver entrega y evidencias</button>}</div></article> })), ...messages.filter(m => m.role !== "user" || !chat.runs.some(r => r.goal === m.text && Math.abs(r.startedAt - m.createdAt) < 30_000)).map(m => ({ at: m.createdAt, key: m.id, node: <article className={`team-chat-message team-conversation ${m.role}`}><small>{m.role === "user" ? "Vos" : "Lead"} · {formatDateTime(m.createdAt)}</small><div className={m.role === "assistant" ? "team-lead-message" : "selectable"}>{m.status === "pending" ? <p role="status">El Lead está trabajando…</p> : <Markdown text={m.text} />}<ChatImages images={m.images} />{m.sessionId && <button className="btn btn-xs" onClick={() => openSession(m.sessionId!, chat.team.projectRoot)}>Ver actividad y permisos del Lead</button>}</div></article> }))].sort((a, b) => a.at - b.at).map(item => <div key={item.key}>{item.node}</div>)}
        <div ref={bottom} />
      </>}
      {view === "Tareas" && (run ? <div className="team-task-list">{!run.tasks.length && <p className="team-note">El Lead está descubriendo el contexto y preparando un plan validado.</p>}{run.tasks.map((t) => <article className="team-card" key={t.id}><div className="team-section-title"><strong>{t.id} · {t.title}</strong><span className={`team-status ${t.status}`}>{statusLabel[t.status] ?? t.status}</span></div><p>{t.objective}</p><p className="team-note">{run.team.members.find((a) => a.id === t.assignedAgentId)?.name} · {t.attempts.length} intentos · depende de {t.dependencies.join(", ") || "ninguna"}</p><code>{t.repository}</code><p className="team-note">Escritura: {t.writePaths?.join(", ") || "carpeta exclusiva"}</p><ul>{t.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>{t.error && <p className="team-error">{taskProblem(t)}</p>}{run.status === "blocked" && t.status !== "completed" && <label>Reasignar modelo del responsable<select value={modelKey(run.team.members.find((m) => m.id === t.assignedAgentId)!.model)} onChange={(e) => { const model = models.find((m) => modelKey(m) === e.target.value); const member = run.team.members.find((m) => m.id === t.assignedAgentId); if (model && member) void teamCall("team_tasks_reassign", { runId: run.id, taskId: t.id, employee: { ...member, model: { providerID: model.providerID, modelID: model.modelID }, variant: null } }) }}><option value={modelKey(run.team.members.find((m) => m.id === t.assignedAgentId)!.model)}>Modelo actual</option>{models.map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>}</article>)}</div> : <p className="team-note">Enviá un objetivo para generar el plan.</p>)}
      {view === "Actividad" && messages.some(m => m.sessionId) && <section className="team-card"><h4>Actividad del chat con el Lead</h4>{messages.filter(m => m.sessionId).map(m => <p key={m.id}><button className="btn btn-xs" onClick={() => openSession(m.sessionId!, chat.team.projectRoot)}>Ver herramientas y permisos · {formatDateTime(m.createdAt)}</button></p>)}</section>}
      {view === "Actividad" && run && <>
        {run.planSessionId && <button className="btn btn-sm" onClick={() => openSession(run.planSessionId!, run.team.allowedRepositories[0])}>Abrir sesión del Lead</button>}
        {(run.coordination ?? []).map((request) => <article className="team-card" key={request.id}>
          <strong>{run.tasks.find((t) => t.id === request.fromTaskId)?.title ?? request.fromTaskId} → Lead</strong>
          <p className="team-note">{statusLabel[request.status] ?? request.status} · {formatDateTime(request.createdAt)}</p>
          <p className="selectable">{request.message}</p>
          {request.taskIds.length > 0 && <p className="team-note">Entregas relacionadas: {request.taskIds.map((id) => { const task = run.tasks.find((t) => t.id === id); return `${task?.title ?? id} (${statusLabel[task?.status ?? ""] ?? task?.status ?? "pendiente"})` }).join(", ")}</p>}
          {(request.replies?.length ? request.replies : request.summary ? [{ at: request.createdAt, summary: request.summary }] : []).map((reply, i) => <div className="team-lead-message" key={i}><strong>Lead → {run.team.members.find((a) => a.id === run.tasks.find((t) => t.id === request.fromTaskId)?.assignedAgentId)?.name ?? "agente"}</strong><small> · {formatDateTime(reply.at)}</small><p className="selectable">{reply.summary}</p></div>)}
          {request.sessions.map((session, i) => <button key={session} className="btn btn-xs" onClick={() => openSession(session, run.tasks.find((t) => t.id === request.fromTaskId)?.repository ?? run.team.allowedRepositories[0])}>Abrir coordinación del Lead {i + 1}</button>)}
        </article>)}
        {run.closingSessions?.map((session,i)=><button key={session} className="btn btn-sm" onClick={()=>openSession(session,run.team.allowedRepositories[0])}>Abrir revisión final {i+1}</button>)}
        {run.tasks.map((t) => t.attempts.map((a, i) => <article className="team-card" key={a.id}><h4>{t.title} · intento {i + 1}</h4><p>{a.agent.name} · {modelKey(a.agent.model)} {a.agent.variant ?? ""}</p><p className="team-note">{statusLabel[a.status] ?? a.status} · {formatDateTime(a.startedAt)}</p><div className="team-actions">{a.sessionId && <button className="btn btn-xs" onClick={() => openSession(a.sessionId!, t.repository)}>Abrir sesión del empleado / permisos</button>}{a.reviewSessionId && <button className="btn btn-xs" onClick={() => openSession(a.reviewSessionId!, t.repository)}>Abrir revisión del Lead</button>}</div>{a.summary && <p className="selectable">{a.summary}</p>}{a.review && <p>Revisión: {reviewLabels[a.review.status] ?? "Revisión pendiente"} · {a.review.summary}</p>}{a.error && <p className="team-error">{readableTeamError(a.error)}</p>}{a.declaredChecks?.length ? <details><summary>Pruebas informadas y resultados registrados</summary><ul>{a.declaredChecks.map(check => <li key={check}><code>{check}</code> · {a.commands.some(c => c.command === check && c.exitCode === 0) ? "Ejecución correcta registrada" : "Falta una ejecución correcta registrada"}</li>)}</ul></details> : null}{a.observations?.length ? <details><summary>Observaciones del navegador, la web y las apps</summary>{a.observations.map((observation, index) => <details key={index}><summary>{observation.tool}</summary><pre className="team-evidence-preview">{observation.output}</pre></details>)}</details> : null}{a.commands.map((c, i) => <details key={i}><summary>{c.command} · {c.exitCode === 0 ? "Correcto" : c.exitCode == null ? "Sin resultado" : `Falló (código ${c.exitCode})`}</summary><pre className="team-evidence-preview">{c.output}</pre></details>)}</article>))}
      </>}
      {view === "Configuración" && <TeamSettings team={chat.team} run={run} chatId={chat.id} pending={pendingReply} />}
      {view === "Resultados / Comportamientos" && (run ? <Results key={run.id} run={run} history={chat.runs} /> : <p className="team-note">Las evidencias aparecerán al iniciar una ejecución.</p>)}
    </div>
    {chat.archived ? <p className="team-note">Chat archivado. Restauralo desde Equipos IA para continuar.</p> : <TeamComposer key={chatId} chatId={chatId} label={latest?.status === "awaiting_manual_qa" || latest?.status === "qa_approved" ? "Feedback de QA / siguiente mensaje" : "Mensaje para el equipo"} pending={pendingReply} onSent={() => { setSelectedRunId(null); setView("Chat") }} />}
  </section>
}
