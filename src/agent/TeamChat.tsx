import { useState } from "react"
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

function openSession(id: string, directory: string) {
  rememberSessionDirectory(id, directory)
  openEditor({ kind: "chat", sessionId: id })
}

function Results({ run, history }: { run: TeamRun; history: TeamRun[] }) {
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null)
  return <div className="team-results">
    <h3>{statusLabel[run.status]}</h3>
    <Markdown text={run.summary || "La entrega aún no está lista."} />
    <p className="team-note selectable">{run.evidenceDir}</p>
    <div className="team-actions"><button className="btn btn-sm" onClick={() => void teamCall("team_evidence_open", { runId: run.id })}><Icon name="folder-opened" /> Abrir carpeta</button></div>
    {run.evidenceExpiredAt && <p className="team-note">Las evidencias de esta entrega expiraron según la retención configurada. El historial del trabajo se conserva.</p>}
    <EvidenceComparison run={run} history={history} />
    {run.artifacts.map((a) => <article className="team-artifact" key={a.id}>
      <div><strong>{a.phase} · {a.kind}</strong><p>{a.relativePath || "Sin archivo de captura"}</p><small>{a.source} · {formatDateTime(a.capturedAt)}</small></div>
      {a.status === "captured" && a.kind !== "screenshot" ? <button className="btn btn-xs" onClick={() => void teamCall<string>("team_evidence_read", { runId: run.id, path: a.relativePath }).then((text) => { if (text !== null) setPreview({ title: a.relativePath, text }) })}>{a.kind === "diff" ? "Abrir diff" : "Ver evidencia"}</button> : a.status !== "captured" ? <p className="team-note">No disponible: {a.reason}</p> : <span className="team-note">Ver en el comparador</span>}
    </article>)}
    {preview && <section className="team-card"><div className="team-section-title"><h4>{preview.title}</h4><button className="btn btn-xs" onClick={() => setPreview(null)}>Cerrar</button></div><pre className="team-evidence-preview">{preview.text}</pre></section>}
  </div>
}

export function TeamChat({ chatId }: { chatId: string }) {
  const chat = useTeams((s) => s.chats.find((c) => c.id === chatId))
  const models = useAgent((s) => s.models)
  const [view, setView] = useState("Chat")
  const [text, setText] = useState("")
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!chat) return <div className="team-note">Cargando conversación de equipo…</div>
  const run = chat.runs.find((r) => r.id === selectedRunId) ?? chat.runs.at(-1)
  const latest = chat.runs.at(-1)
  const usage = Object.values(run?.sessionUsage ?? {}).reduce((sum, v) => ({ tokens: sum.tokens + v.tokens, costUsd: sum.costUsd + v.costUsd }), { tokens: 0, costUsd: 0 })
  const busy = !!latest && (runActive(latest.status) || latest.status === "blocked")
  const act = (action: string) => run && teamCall("team_runs_control", { runId: run.id, action })
  const submit = async () => {
    if (!text.trim() || sending || busy) return
    setSending(true)
    const id = await teamCall<string>("team_runs_start", { chatId, goal: text.trim() })
    setSending(false)
    if (id) { setSelectedRunId(null); setText(""); setView("Tareas") }
  }
  return <section className="team-chat">
    <header className="team-chat-header"><div><strong><Icon name="organization" /> {chat.title}</strong><p>{chat.team.members.length} integrantes · {run ? statusLabel[run.status] : "Listo para recibir tu objetivo"}</p></div></header>
    <nav className="team-chat-nav" aria-label="Vistas del equipo">{["Chat", "Tareas", "Actividad", "Resultados / Comportamientos"].map((v) => <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v}</button>)}</nav>
    {chat.runs.length > 1 && <label className="team-run-select">Entrega / ejecución<select value={run?.id} onChange={(e) => setSelectedRunId(e.target.value)}>{chat.runs.map((r, i) => <option value={r.id} key={r.id}>#{i + 1} · {formatDateTime(r.startedAt)} · {statusLabel[r.status]}</option>)}</select></label>}
    {run && <div className="team-run-controls">
      {["planning", "running"].includes(run.status) && <button className="btn btn-xs" onClick={() => void act("pause")}>Pausar nuevas tareas</button>}
      {run.status === "paused" && <button className="btn btn-xs" onClick={() => void act("resume")}>Reanudar</button>}
      {["blocked", "failed"].includes(run.status) && <button className="btn btn-xs" onClick={() => void act("retry")}>Reconciliar y reintentar</button>}
      {(runActive(run.status) || run.status === "blocked") && run.status !== "cancelling" && <button className="btn btn-xs" onClick={() => void confirmAction("Cancelar ejecución", "Se abortan las sesiones y se conservan los cambios ya aplicados. Revisá Git antes de continuar.", "Cancelar ejecución", true).then((yes) => { if (yes) void act("cancel") })}>Cancelar ejecución</button>}
      {run.status === "awaiting_manual_qa" && <button className="btn btn-xs" onClick={() => void act("approve")}>Aprobar QA manual</button>}
    </div>}
    {run?.error && <div className="team-error" role="status">{run.error}</div>}
    {run && Object.keys(run.sessionUsage ?? {}).length > 0 && <p className="team-note team-usage">Uso informado por el motor: {usage.tokens.toLocaleString()} tokens · USD {usage.costUsd.toFixed(4)}. Algunos proveedores no informan costo.</p>}
    <div className="team-chat-body">
      {run?.status === "blocked" && <RunBudget key={run.id} run={run} />}
      {run?.status === "blocked" && <details className="team-card"><summary>Reasignar modelos de esta ejecución</summary><p className="team-note">La configuración original del chat y los intentos anteriores se conservan. Reconciliá las sesiones antes de reintentar.</p>{run.team.members.map((a) => <label key={a.id}>{a.name} · {a.role}<select aria-label={`Modelo de ${a.name}`} value={modelKey(a.model)} onChange={(e) => {const m=models.find((v)=>modelKey(v)===e.target.value);if(m)void teamCall("team_runs_model",{runId:run.id,agentId:a.id,model:{providerID:m.providerID,modelID:m.modelID},variant:null})}}><option value={modelKey(a.model)}>{modelKey(a.model)}</option>{models.filter((m)=>modelKey(m)!==modelKey(a.model)).map((m)=><option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>)}</details>}
      {view === "Chat" && <>
        {!chat.runs.length && <div className="team-chat-welcome"><Icon name="organization" /><h2>Un objetivo para todo el equipo</h2><p>El Lead descubre el proyecto, delega y revisa. Vas a recibir una entrega con evidencias y QA manual pendiente.</p><p className="team-note">Solo se ejecuta con el motor local encendido. La pausa deja terminar los intentos en curso.</p></div>}
        {chat.runs.map((r, i) => <article className="team-chat-message" key={r.id}><small>Objetivo {i + 1} · {formatDateTime(r.startedAt)}</small><p className="selectable">{r.goal}</p><div className="team-lead-message"><strong>Team Lead · {statusLabel[r.status]}</strong>{r.summary ? <Markdown text={r.summary} /> : <p>{r.error ?? "La ejecución está registrada; consultá Tareas y Actividad."}</p>}{r.finishedAt && <button className="btn btn-xs" onClick={() => { setSelectedRunId(r.id); setView("Resultados / Comportamientos") }}>Ver entrega y evidencias</button>}</div></article>)}
      </>}
      {view === "Tareas" && (run ? <div className="team-task-list">{!run.tasks.length && <p className="team-note">El Lead está descubriendo el contexto y preparando un plan validado.</p>}{run.tasks.map((t) => <article className="team-card" key={t.id}><div className="team-section-title"><strong>{t.id} · {t.title}</strong><span className={`team-status ${t.status}`}>{statusLabel[t.status] ?? t.status}</span></div><p>{t.objective}</p><p className="team-note">{run.team.members.find((a) => a.id === t.assignedAgentId)?.name} · {t.attempts.length} intentos · depende de {t.dependencies.join(", ") || "ninguna"}</p><code>{t.repository}</code><ul>{t.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>{t.error && <p className="team-error">{t.error}</p>}{run.status === "blocked" && t.status !== "completed" && <label>Reasignar modelo del responsable<select value={modelKey(run.team.members.find((m) => m.id === t.assignedAgentId)!.model)} onChange={(e) => { const model = models.find((m) => modelKey(m) === e.target.value); const member = run.team.members.find((m) => m.id === t.assignedAgentId); if (model && member) void teamCall("team_tasks_reassign", { runId: run.id, taskId: t.id, employee: { ...member, model: { providerID: model.providerID, modelID: model.modelID }, variant: null } }) }}><option value={modelKey(run.team.members.find((m) => m.id === t.assignedAgentId)!.model)}>Modelo actual</option>{models.map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>}</article>)}</div> : <p className="team-note">Enviá un objetivo para generar el plan.</p>)}
      {view === "Actividad" && run && <>
        {run.planSessionId && <button className="btn btn-sm" onClick={() => openSession(run.planSessionId!, run.team.allowedRepositories[0])}>Abrir sesión del Lead</button>}
        {run.closingSessions?.map((session,i)=><button key={session} className="btn btn-sm" onClick={()=>openSession(session,run.team.allowedRepositories[0])}>Abrir revisión final {i+1}</button>)}
        {run.tasks.map((t) => t.attempts.map((a, i) => <article className="team-card" key={a.id}><h4>{t.title} · intento {i + 1}</h4><p>{a.agent.name} · {modelKey(a.agent.model)} {a.agent.variant ?? ""}</p><p className="team-note">{statusLabel[a.status] ?? a.status} · {formatDateTime(a.startedAt)}</p><div className="team-actions">{a.sessionId && <button className="btn btn-xs" onClick={() => openSession(a.sessionId!, t.repository)}>Abrir sesión del empleado / permisos</button>}{a.reviewSessionId && <button className="btn btn-xs" onClick={() => openSession(a.reviewSessionId!, t.repository)}>Abrir revisión del Lead</button>}</div>{a.summary && <p className="selectable">{a.summary}</p>}{a.review && <p>Revisión: {a.review.status} · {a.review.summary}</p>}{a.error && <p className="team-error">{a.error}</p>}{a.commands.map((c, i) => <details key={i}><summary>{c.command} · exit {c.exitCode ?? "desconocido"}</summary><pre className="team-evidence-preview">{c.output}</pre></details>)}</article>))}
      </>}
      {view === "Resultados / Comportamientos" && (run ? <Results key={run.id} run={run} history={chat.runs} /> : <p className="team-note">Las evidencias aparecerán al iniciar una ejecución.</p>)}
    </div>
    {chat.archived ? <p className="team-note">Chat archivado. Restauralo desde Equipos IA para continuar.</p> : <form className="team-composer" onSubmit={(e) => { e.preventDefault(); void submit() }}><label htmlFor={`team-goal-${chatId}`}>{latest?.status === "awaiting_manual_qa" || latest?.status === "qa_approved" ? "Feedback de QA / siguiente objetivo" : "Objetivo del equipo"}</label><textarea id={`team-goal-${chatId}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Implementen… El Lead coordina las tareas y la entrega." onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit() } }} /><button className="btn btn-primary" type="submit" disabled={sending || busy || !text.trim()}>{sending ? "Iniciando…" : latest?.finishedAt ? "Enviar al Lead" : "Iniciar equipo"}</button></form>}
  </section>
}
