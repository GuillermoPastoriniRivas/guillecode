import { useEffect, useRef, useState } from "react"
import { teamCall, useTeams } from "../state/teams"
import { pendingRequests, useAgent } from "../state/agent"
import { useApprovals } from "../state/approvals"
import { modelKey, rememberSessionDirectory } from "../lib/opencode"
import { openEditor } from "../state/editors"
import { confirmAction } from "../components/Dialog"
import { Icon } from "../components/ui"
import { Markdown } from "./Markdown"
import { statusLabel, runStatusLabel, runActive, type TeamRun } from "../team/types"
import { formatDateTime } from "../lib/time"
import { EvidenceComparison } from "../team/EvidenceComparison"
import { RunBudget } from "../team/RunBudget"
import { isAccountLimitError, readableTeamError } from "../lib/provider-error"
import { LeadReply } from "./LeadReply"
import { firstTeamSentence } from "../lib/team-response"
import { runProblem, taskProblem } from "../team/problem"
import { ChatImages } from "../team/ChatImages"
import { TeamComposer, type TeamComposerHandle } from "../team/TeamComposer"
import { TeamSettings } from "../team/TeamSettings"
import { attentionLabel, teamAttention } from "../team/attention"
import { leadRecovery, memberState } from "../team/member-state"
import { TeamProblems } from "../team/TeamProblems"
import { SupportReports, GoalAnalysis } from "../team/SupportReports"
import { LeadMessage } from "../team/LeadMessage"
import { TeamBrowser } from "../team/TeamBrowser"
import { TeamFolderConflicts } from "../team/TeamFolderConflicts"
import { TeamBoard } from "../team/TeamBoard"

function GoalText({ text }: { text: string }) {
  if (text.length < 240) return <p className="selectable">{text}</p>
  return <details className="team-goal-details"><summary><span>{text.slice(0,140).trimEnd()}…</span><small>Ver pedido completo</small></summary><p className="selectable">{text}</p></details>
}

function RunReply({ run }: { run: TeamRun }) {
  const blockedTask = run.tasks.find(t => ["blocked", "failed", "review_error", "interrupted"].includes(t.status))
  const pending = run.error || blockedTask ? runProblem(run) : ["completed", "awaiting_manual_qa"].includes(run.status) ? "Ahora revisá la entrega. Decime «trabajo completado» para aprobarla, o pedime mejoras y las implementamos." : run.status === "qa_approved" ? "Entrega aprobada. Podés enviar el siguiente pedido." : "El equipo todavía está trabajando."
  const brief = run.chatSummary ? { ...run.chatSummary, pending: run.error || blockedTask || ["completed", "awaiting_manual_qa", "qa_approved"].includes(run.status) ? pending : run.chatSummary.pending } : undefined
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
    <h3>{runStatusLabel(run.status)}</h3>
    <RunReply run={run} />
    <GoalAnalysis run={run} />
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
  const permissions = useAgent(s => s.permissions)
  const questions = useAgent(s => s.questions)
  const allSessions = useAgent(s => s.allSessions)
  const approvals = useApprovals()
  const [viewChoice, setViewChoice] = useState<{ runId?: string; view: string | null } | null>(null)
  const viewRun = chat?.runs.at(-1)
  const view = (viewChoice?.runId === viewRun?.id ? viewChoice?.view : null) ?? (viewRun?.planV2?.enabled ? "Tablero" : "Chat")
  const setView = (view: string | null) => setViewChoice({ runId: viewRun?.id, view })
  const [expanded, setExpanded] = useState(false)
  const selectedRunId=useTeams(s=>s.selectedRunIds[chatId] ?? null)
  const setSelectedRunId=(id:string|null)=>useTeams.setState(s=>({selectedRunIds:{...s.selectedRunIds,[chatId]:id}}))
  const bottom = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const body = useRef<HTMLDivElement>(null)
  const problems = useRef<HTMLDivElement>(null)
  const composer = useRef<TeamComposerHandle>(null)
  const modelSettings = useRef<HTMLDetailsElement>(null)
  const messages = chat?.messages ?? []
  const lastMessageStatus = messages.at(-1)?.status
  useEffect(() => { followLatest.current = true }, [chatId])
  useEffect(() => { if (view === "Chat" && followLatest.current) bottom.current?.scrollIntoView({ block: "nearest" }) }, [messages.length, lastMessageStatus, view, chatId])
  useEffect(() => { if (view === "Configuración" && body.current) body.current.scrollTop = 0 }, [view, selectedRunId])
  if (!chat) return <div className="team-note">Cargando conversación de equipo…</div>
  const run = chat.runs.find((r) => r.id === selectedRunId) ?? chat.runs.at(-1)
  const roster = run?.team ?? chat.team
  const runError = run?.error ?? ""
  const folderFailure = messages.at(-1)?.status === "error" ? messages.at(-1)!.text : runError
  const budgetBlocked = /presupuesto|límite de tokens|duración máxima/i.test(runError)
  const modelBlocked = /modelo|proveedor|variante/i.test(runError) || isAccountLimitError(runError)
  const pendingReply = messages.some(m => m.status === "pending")
  const requests = pendingRequests({ permissions, questions, allSessions }, approvals)
  const attention = teamAttention(chat, run, [
    ...requests.permissions.map(r => ({ sessionID: r.sessionID, kind: "permission" as const, detail: `${({ bash: "ejecutar el comando", edit: "editar el archivo", read: "leer el archivo", external_directory: "acceder a la carpeta", webfetch: "consultar la página" } as Record<string, string>)[r.permission] ?? r.permission}${r.patterns?.length ? `: ${r.patterns.join(", ").slice(0,180)}` : " (el motor no indicó la ruta ni el comando)"}` })),
    ...requests.questions.map(r => ({ sessionID: r.sessionID, kind: "question" as const, detail: r.questions[0]?.question?.slice(0, 240) })),
  ])
  const attentionText = attentionLabel(attention)
  const needsUserHelp = attention.some(item => item.kind !== "waiting")
  const activeSupport=run?.supportReports?.findLast(s=>s.finishedAt==null)
  const headerStatus = !needsUserHelp && activeSupport ? activeSupport.kind === "plan_change" ? "Revisando tu indicación para actualizar el plan" : activeSupport.kind==="investigation" ? "El Solucionador está investigando para el Lead" : activeSupport.kind==="goal_analysis" ? "El Supervisor compara el objetivo y el resultado" : "El Supervisor está revisando entregas" : !needsUserHelp && leadRecovery(run) ? "El Lead está resolviendo un bloqueo" : run ? runStatusLabel(run.status) : attention.length ? "Necesita tu ayuda" : pendingReply ? "El Lead está trabajando" : "Listo para recibir tu objetivo"
  const act = (action: string) => run && teamCall("team_runs_control", { runId: run.id, action })
  return <section className={`team-chat${expanded ? " team-chat-expanded" : ""}${view === "Tablero" ? " team-board-mode" : ""}`}>
    <header className="team-chat-header"><div className="team-section-title"><strong><Icon name="organization" /> {chat.title}</strong><div className="team-header-actions"><button type="button" className="btn btn-xs" aria-label={expanded ? "Restaurar tamaño del chat" : "Ampliar chat del equipo"} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><Icon name={expanded ? "screen-normal" : "screen-full"} />{expanded ? "Restaurar" : "Ampliar"}</button><button className="btn btn-xs" type="button" aria-label="Configuración del equipo" aria-pressed={view === "Configuración"} onClick={() => setView(view === "Configuración" ? "Chat" : "Configuración")}><Icon name="settings-gear" /> Configuración</button></div></div><p>{roster.members.length} integrantes · {headerStatus}{attentionText && <span className="team-attention-badge" aria-live="polite"> · {attentionText}</span>}</p>
      {attention.length > 0 && <button className="team-attention-summary" onClick={() => { followLatest.current = false; if (view === "Tablero") { setView("Chat"); requestAnimationFrame(() => problems.current?.scrollIntoView({ block: "start" })) } else problems.current?.scrollIntoView({ block: "start" }) }}><Icon name="warning" /><span>{attention.filter(i => i.kind !== "waiting").map(i => i.name).filter((name, i, names) => names.indexOf(name) === i).join(", ") || "Integrantes en espera"}</span><strong>{needsUserHelp ? "Ver qué pasó y cómo ayudar" : "Ver cómo sigue el equipo"}</strong></button>}
    </header>

    {view !== "Configuración" && /carpeta.*ocupada|equipo o una sesión pendiente|otro equipo.*carpetas/i.test(folderFailure) && <TeamFolderConflicts chatId={chatId} failure={folderFailure} />}
    <nav className="team-chat-nav" aria-label="Vistas del equipo">{["Chat", "Tablero", "Navegador", "Tareas", "Actividad", "Resultados / Comportamientos"].map((v) => <button key={v} className={view === v ? "active" : ""} onClick={() => {setView(v);if(v==="Navegador")setExpanded(true)}}>{v}</button>)}</nav>
    <div className={`team-chat-body${view === "Navegador" ? " team-browser-body" : ""}`} ref={body} onScroll={() => { const el = body.current; if (el) followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {view !== "Navegador" && view !== "Tablero" && attention.length > 0 && <div ref={problems}><TeamProblems items={attention} run={run} pending={pendingReply} onInspect={item => item.sessionId ? openSession(item.sessionId, item.directory) : setView("Actividad")} onSettings={() => { if (modelSettings.current) { modelSettings.current.open = true; modelSettings.current.scrollIntoView({ block: "start" }) } else setView("Configuración") }} onAsk={() => { setView("Chat"); composer.current?.write(needsUserHelp ? "¿Quién está bloqueado, por qué y qué ayuda necesitás de mí?" : "¿Cómo va el estado y qué está resolviendo el Lead?") }} onContinue={() => void act("retry")} /></div>}
    {view !== "Chat" && view !== "Navegador" && chat.runs.length > 1 && <label className="team-run-select">Entrega / ejecución<select value={run?.id} onChange={(e) => setSelectedRunId(e.target.value)}>{chat.runs.map((r, i) => <option value={r.id} key={r.id}>#{i + 1} · {formatDateTime(r.startedAt)} · {runStatusLabel(r.status)}</option>)}</select></label>}
    {view !== "Navegador" && run && <div className="team-run-controls">
      {["planning", "running"].includes(run.status) && <button className="btn btn-xs" onClick={() => void act("pause")}>Pausar nuevas tareas</button>}
      {run.status === "paused" && <button className="btn btn-xs" onClick={() => void act("resume")}>Reanudar</button>}
      {run.status === "plan_ready" && <button className="btn btn-xs" onClick={() => void act("start_plan")}>Iniciar plan validado</button>}
      {run.status === "planning_blocked" && view !== "Tablero" && <button className="btn btn-xs" onClick={() => void act("retry")}>Reintentar planificación</button>}
      {(runActive(run.status) || ["blocked","planning_blocked"].includes(run.status)) && run.status !== "cancelling" && <button className="btn btn-xs" onClick={() => void confirmAction("Cancelar ejecución", "Se abortan las sesiones y se conservan los cambios ya aplicados. Revisá Git antes de continuar.", "Cancelar ejecución", true).then((yes) => { if (yes) void act("cancel") })}>Cancelar ejecución</button>}
      {view === "Resultados / Comportamientos" && ["completed", "awaiting_manual_qa"].includes(run.status) && <button className="btn btn-xs" onClick={() => void act("approve")}>Trabajo completado</button>}
    </div>}
      {["Tareas", "Configuración"].includes(view) && roster.autonomous && <details className="team-roster"><summary>Equipo elegido por el Lead</summary><ul aria-label="Estado de los integrantes">{roster.members.map(m => {
        const current = memberState(m, chat, run, attention)
        return { m, current, priority: current.needsHelp ? 3 : m.id === roster.leadAgentId ? 2 : current.tone === "waiting" ? 1 : 0 }
      }).sort((a, b) => b.priority - a.priority).map(({ m, current }) => {
        return <li className="team-member" key={m.id}>
          <div><strong>{m.name}</strong>{m.name.toLowerCase() !== m.role.toLowerCase() && <span> · {m.role}</span>}<span className={`team-member-status ${current.tone}`}>{current.label}</span></div>
          <small className={current.needsHelp ? "team-member-help" : "team-note"}>{current.needsHelp ? "Necesita tu ayuda" : "Sin pedidos de ayuda"}</small>
          <p>{current.detail}</p>
        </li>
      })}</ul></details>}
      {run?.status === "blocked" && budgetBlocked && <RunBudget key={run.id} run={run} />}
      {run?.status === "blocked" && modelBlocked && <details ref={modelSettings} className="team-card"><summary>Cambiar el modelo que falló</summary><p className="team-note">La configuración original del chat y los intentos anteriores se conservan.</p>{run.team.members.map((a) => <label key={a.id}>{a.name} · {a.role}<select aria-label={`Modelo de ${a.name}`} value={modelKey(a.model)} onChange={(e) => {const m=models.find((v)=>modelKey(v)===e.target.value);if(m)void teamCall("team_runs_model",{runId:run.id,agentId:a.id,model:{providerID:m.providerID,modelID:m.modelID},variant:null})}}><option value={modelKey(a.model)}>{modelKey(a.model)}</option>{models.filter((m)=>modelKey(m)!==modelKey(a.model)).map((m)=><option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>)}</details>}
      {view === "Tablero" && (run ? <TeamBoard key={run.id} run={run} onSession={openSession} onEvidence={() => setView("Resultados / Comportamientos")} onPatch={patch => teamCall("apply_plan_patch", { patch })} onRetry={() => teamCall("team_runs_control", { runId: run.id, action: "retry" })} /> : <p className="team-note">Enviá un objetivo para generar el tablero.</p>)}
      {view === "Chat" && <>
        {!chat.runs.length && <div className="team-chat-welcome"><Icon name="organization" /><h2>{chat.team.autonomous ? "Contame qué querés hacer" : "Un objetivo para todo el equipo"}</h2><p>{chat.team.autonomous ? "Hablás con el Lead. Él decide cuántos especialistas necesita, reparte las tareas y pone a trabajar en paralelo lo que se pueda hacer a la vez." : "El Lead descubre el proyecto, delega y revisa. El equipo completa las comprobaciones y entrega el resultado con evidencias; solo te consulta si necesita una decisión o un permiso."}</p><p className="team-note">Si falta algo imprescindible, el Lead te pregunta al principio. Después, el equipo trabaja y comprueba la entrega; te avisa al terminar para que la revises. Podés consultar cómo va mientras trabajan.</p></div>}
        {[...chat.runs.map((r, i) => ({ at: r.startedAt, key: r.id, node: <article className="team-chat-message"><small>Objetivo {i + 1} · {formatDateTime(r.startedAt)}</small><GoalText text={r.goal} /><ChatImages images={r.images} /><div className="team-lead-message"><p>{r.chatSummary?.done || (r.finishedAt ? "La entrega está lista para revisar." : "El equipo está trabajando en tu pedido.")}</p><details className="lead-details"><summary>Qué se hizo y probó</summary><RunReply run={r} /></details>{r.finishedAt && <button className="btn btn-xs" onClick={() => { setSelectedRunId(r.id); setView("Resultados / Comportamientos") }}>Ver entrega y evidencias</button>}</div></article> })), ...messages.filter(m => m.role !== "user" || !chat.runs.some(r => r.goal === m.text && Math.abs(r.startedAt - m.createdAt) < 30_000)).map(m => ({ at: m.createdAt, key: m.id, node: <article className={`team-chat-message team-conversation ${m.role}`}><small>{m.role === "user" ? "Vos" : "Lead"} · {formatDateTime(m.createdAt)}</small><div className={m.role === "assistant" ? "team-lead-message" : "selectable"}>{m.status === "pending" ? <p role="status">El Lead está trabajando…</p> : m.role === "assistant" ? <LeadMessage text={["error", "interrupted"].includes(m.status) ? readableTeamError(m.text) : m.text} /> : <Markdown text={m.text} />}<ChatImages images={m.images} /></div></article> }))].sort((a, b) => a.at - b.at).map(item => <div key={item.key}>{item.node}</div>)}
        <div ref={bottom} />
      </>}
      {view === "Navegador" && <TeamBrowser chatId={chatId} names={Object.fromEntries([...messages.filter(m=>m.sessionId).map(m=>[m.sessionId!,"Lead"]),...(run?.tasks ?? []).flatMap(t=>t.attempts.filter(a=>a.sessionId).map(a=>[a.sessionId!,a.agent.name]))])} />}
      {view === "Tareas" && (run ? <div className="team-task-list">{!run.tasks.length && <p className="team-note">El Lead está descubriendo el contexto y preparando un plan validado.</p>}{run.tasks.map((t) => <article className="team-card" key={t.id}><div className="team-section-title"><strong>{t.id} · {t.title}</strong><span className={`team-status ${t.status}`}>{statusLabel[t.status] ?? t.status}</span></div><p>{t.objective}</p><p className="team-note">{run.team.members.find((a) => a.id === t.assignedAgentId)?.name} · {t.attempts.length} intentos · depende de {t.dependencies.join(", ") || "ninguna"}</p><code>{t.repository}</code><p className="team-note">Escritura: {t.writePaths?.join(", ") || "carpeta exclusiva"}</p><ul>{t.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>{t.error && <p className="team-error">{taskProblem(t)}</p>}{run.status === "blocked" && !run.planV2?.enabled && t.status !== "completed" && <label>Reasignar modelo del responsable<select value={modelKey(run.team.members.find((m) => m.id === t.assignedAgentId)!.model)} onChange={(e) => { const model = models.find((m) => modelKey(m) === e.target.value); const member = run.team.members.find((m) => m.id === t.assignedAgentId); if (model && member) void teamCall("team_tasks_reassign", { runId: run.id, taskId: t.id, employee: { ...member, model: { providerID: model.providerID, modelID: model.modelID }, variant: null } }) }}><option value={modelKey(run.team.members.find((m) => m.id === t.assignedAgentId)!.model)}>Modelo actual</option>{models.map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>}</article>)}</div> : <p className="team-note">Enviá un objetivo para generar el plan.</p>)}
      {view === "Actividad" && messages.some(m => m.sessionId) && <section className="team-card"><h4>Actividad del chat con el Lead</h4>{messages.filter(m => m.sessionId).map(m => <p key={m.id}><button className="btn btn-xs" onClick={() => openSession(m.sessionId!, chat.team.projectRoot)}>Ver herramientas y permisos · {formatDateTime(m.createdAt)}</button></p>)}</section>}
      {view === "Actividad" && run && <>
        <SupportReports run={run} onOpen={openSession} />
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
        {run.tasks.map((t) => t.attempts.map((a, i) => <article className="team-card" key={a.id}><h4>{t.title} · intento {i + 1}</h4><p>{a.agent.name} · {modelKey(a.agent.model)} {a.agent.variant ?? ""}</p><p className="team-note">{statusLabel[a.status] ?? a.status} · {formatDateTime(a.startedAt)}</p><div className="team-actions">{a.sessionId && <button className="btn btn-xs" onClick={() => openSession(a.sessionId!, t.repository)}>Abrir sesión del empleado / permisos</button>}{a.reviewSessionId && <button className="btn btn-xs" onClick={() => openSession(a.reviewSessionId!, t.repository)}>{run.supportReports?.find(s=>s.sessionId===a.reviewSessionId)?.agent.name === "Supervisor" ? "Abrir revisión del Supervisor" : "Abrir revisión del Lead"}</button>}</div>{a.summary && <p className="selectable">{a.summary}</p>}{a.review && <p>Revisión: {reviewLabels[a.review.status] ?? "Revisión pendiente"} · {a.review.summary}</p>}{a.error && <p className="team-error">{readableTeamError(a.error)}</p>}{a.declaredChecks?.length ? <details><summary>Pruebas informadas y resultados registrados</summary><ul>{a.declaredChecks.map(check => <li key={check}><code>{check}</code> · {a.commands.some(c => c.command === check && c.exitCode === 0) ? "Ejecución correcta registrada" : "Falta una ejecución correcta registrada"}</li>)}</ul></details> : null}{a.observations?.length ? <details><summary>Observaciones del navegador, la web y las apps</summary>{a.observations.map((observation, index) => <details key={index}><summary>{observation.tool}</summary><pre className="team-evidence-preview">{observation.output}</pre></details>)}</details> : null}{a.commands.map((c, i) => <details key={i}><summary>{c.command} · {c.exitCode === 0 ? "Correcto" : c.exitCode == null ? "Sin resultado" : `Falló (código ${c.exitCode})`}</summary><pre className="team-evidence-preview">{c.output}</pre></details>)}</article>))}
      </>}
      {view === "Configuración" && <><TeamFolderConflicts chatId={chatId} failure={runError} /><TeamSettings team={chat.team} run={run} chatId={chat.id} pending={pendingReply} /></>}
      {view === "Resultados / Comportamientos" && (run ? <Results key={run.id} run={run} history={chat.runs} /> : <p className="team-note">Las evidencias aparecerán al iniciar una ejecución.</p>)}
    </div>
    {view === "Navegador" ? null : chat.archived ? <p className="team-note">Chat archivado. Restauralo desde Equipos IA para continuar.</p> : <TeamComposer ref={composer} key={chatId} chat={chat} label="Mensaje para el equipo" onBrowser={() => {setView("Navegador");setExpanded(true)}} pending={pendingReply} onSent={() => { setSelectedRunId(null); setView("Chat"); followLatest.current = true; requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "nearest" })) }} />}
  </section>
}
