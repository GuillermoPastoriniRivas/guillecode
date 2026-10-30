import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Icon } from "../components/ui"
import "./board.css"
import { boardColumns, movableTask, projectBoard, taskVerified, type BoardColumn } from "./board"
import { taskProblem } from "./problem"
import type { TeamRun, TeamTask } from "./types"
import { formatDateTime } from "../lib/time"

export type BoardPatch = { operationId: string; runId: string; expectedRevision: number; expectedDigest: string; reason: string; operations: Record<string, unknown>[] }
type Props = { run: TeamRun; onSession: (id: string, directory: string) => void; onEvidence: () => void; onPatch: (patch: BoardPatch) => Promise<unknown>; onRetry: () => Promise<unknown>; readOnly?: boolean }
type Card = ReturnType<typeof projectBoard>[number]

export function TeamBoard({ run, onSession, onEvidence, onPatch, onRetry, readOnly = false }: Props) {
  const [grouping, setGrouping] = useState("state")
  const [filter, setFilter] = useState("all")
  const [dense, setDense] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [tab, setTab] = useState("Tablero")
  const [agentFilter, setAgentFilter] = useState("")
  const detail = useRef<HTMLElement>(null)
  const origin = useRef<HTMLButtonElement | null>(null)
  const previous = useRef(new Map<string, BoardColumn>())
  const cards = useMemo(() => projectBoard(run), [run])
  const selected = run.tasks.find(t => t.id === selectedId)
  const verified = cards.filter(c => c.column === "verified").length
  useEffect(() => {
    const changes = cards.filter(c => previous.current.has(c.task.id) && previous.current.get(c.task.id) !== c.column)
    // oxlint-disable-next-line react/set-state-in-effect -- Announces external scheduler transitions to assistive technology.
    if (changes.length) setAnnouncement(changes.map(c => `${c.task.title}: ${boardColumns.find(col => col.id === c.column)?.label}`).join(". "))
    previous.current = new Map(cards.map(c => [c.task.id, c.column]))
  }, [cards]) // Render from the durable snapshot, never replay events as commands.
  useEffect(() => { if (selectedId) detail.current?.focus() }, [selectedId])

  const close = () => { setSelectedId(null); origin.current?.focus() }
  const open = (task: TeamTask, button?: HTMLButtonElement) => { origin.current = button ?? null; setSelectedId(task.id) }
  const mutate = async (task: TeamTask, operation: Record<string, unknown>, reason: string) => {
    if (!movableTask(run, task) || saving || readOnly) return
    setSaving(true)
    try {
    const result = await onPatch({
      operationId: crypto.randomUUID(), runId: run.id, expectedRevision: run.planV2!.revisionNumber,
      expectedDigest: run.planV2!.digest, reason, operations: [operation],
    })
    setAnnouncement(result ? "Cambio de plan aceptado y guardado." : "El cambio fue rechazado. Se conserva el estado del motor; revisá el aviso.")
    } catch (error) { setAnnouncement(String(error)) }
    finally { setSaving(false); setDragId(null) }
  }
  const prioritize = (task: TeamTask, before?: TeamTask) => mutate(task,
    { type: "REPRIORITIZE_PENDING", taskId: task.id, priority: Math.min(2147483646, (before?.priority ?? Math.max(0, ...run.tasks.map(t => t.priority ?? 0))) + 1) },
    `Priorizar la tarea pendiente ${task.id} desde el tablero`)
  const reassign = (task: TeamTask, agentId: string) => mutate(task,
    { type: "REASSIGN_PENDING", taskId: task.id, agentId }, `Reasignar la tarea pendiente ${task.id} desde el tablero`)
  const visible = cards.filter(c => (!agentFilter || c.task.assignedAgentId === agentFilter)
    && (filter === "all" || filter === "attention" && ["blocked", "needs_changes", "reconciling"].includes(c.column) || filter === "review" && c.column === "verifying"))
  const activeModels = (agentId: string) => [...new Set(cards.filter(c => c.task.assignedAgentId === agentId && ["running", "verifying"].includes(c.task.status) && c.attempt).map(c => `${c.attempt!.agent.model.providerID}/${c.attempt!.agent.model.modelID}`))].join(", ")

  function renderCard(card: Card) {
    const { task, agent, column, attempt } = card
    const canMove = movableTask(run, task) && !saving && !readOnly
    return <article key={task.id} className={`team-board-card is-${column}${dragId === task.id ? " dragging" : ""}`} data-task-id={task.id} data-column={column}
      draggable={canMove} onDragStart={e => { e.dataTransfer.setData("application/x-flufy-task", task.id); e.dataTransfer.effectAllowed = "move"; setDragId(task.id) }} onDragEnd={() => setDragId(null)}
      onDragOver={e => { if (dragId && canMove && dragId !== task.id) e.preventDefault() }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); const taskId = e.dataTransfer.getData("application/x-flufy-task"); const source = run.tasks.find(t => t.id === taskId); if (source && canMove && source.id !== task.id) void prioritize(source, task) }}>
      <div className="team-board-card-meta"><span>{task.id}</span><span>Prioridad {task.priority ?? 0}</span></div>
      <button className="team-board-card-title" onClick={e => open(task, e.currentTarget)} aria-label={`Abrir tarea ${task.id}: ${task.title}`}>{task.title}</button>
      <p className="team-board-owner"><span className="team-board-avatar" aria-hidden="true">{(agent?.name ?? "?").slice(0, 2).toUpperCase()}</span>{agent?.name ?? "Sin responsable"}{agent?.role.toLowerCase() !== agent?.name.toLowerCase() && <small>{agent?.role}</small>}</p>
      <span className="team-board-state"><Icon name={boardColumns.find(c => c.id === column)!.icon} /> {boardColumns.find(c => c.id === column)!.label}</span>
      {!dense && <>
        {attempt?.routing && <p className="team-note">{attempt.agent.model.providerID}/{attempt.agent.model.modelID} · {attempt.routing.category}</p>}
        {!!task.dependencies.length && <p className="team-note">Depende de {task.dependencies.join(", ")}</p>}
        {["blocked", "needs_changes"].includes(column) && <p className="team-board-cause">{task.status === "waiting_dependency" ? run.coordination?.findLast(c => c.fromTaskId === task.id && c.status !== "resolved")?.summary || "Espera una entrega o una respuesta del Lead." : taskProblem(task)}</p>}
        {column === "reconciling" && <p className="team-note">Esperando confirmar la sesión y su estado real.</p>}
        {column === "verifying" && <p className="team-note">Falta completar la verificación observada.</p>}
        {column === "verified" && <p className="team-note">Evidencia y revisión registradas</p>}
        {attempt?.sessionId && <button className="btn btn-xs" onClick={() => onSession(attempt.sessionId!, task.repository)}>Abrir sesión</button>}
      </>}
    </article>
  }

  function columns(lane: Card[], key: string) {
    return <div className="team-board-columns">{boardColumns.filter(column => ["todo", "ready", "running", "verifying", "verified"].includes(column.id) || lane.some(c => c.column === column.id)).map(column => {
      const content = lane.filter(c => c.column === column.id)
      const limit = limits[`${key}:${column.id}`] ?? 25
      return <section key={column.id} className={`team-board-column is-${column.id}`} aria-label={column.label}>
        <h4><Icon name={column.icon} /> {column.label}<span>{content.length}</span></h4>
        <div className="team-board-stack">{content.slice(0, limit).map(renderCard)}{!content.length && <p className="team-board-empty">Sin tareas</p>}</div>
        {content.length > limit && <button className="btn btn-xs" onClick={() => setLimits(v => ({ ...v, [`${key}:${column.id}`]: limit + 25 }))}>Mostrar {Math.min(25, content.length - limit)} más</button>}
      </section>
    })}</div>
  }

  return <section className={`team-board${dense ? " dense" : ""}`} aria-label="Tablero de tareas">
    <header className="team-board-header"><div><span className="team-board-eyebrow">{run.planV2?.enabled ? `PLAN VIVO · v${run.planV2.revisionNumber}` : "EJECUCIÓN GUARDADA"}</span><h3>{verified}/{cards.length} verificadas</h3><p className="team-note">{run.planV2?.enabled ? `Etapa: ${{ discovery: "Descubriendo", proposal: "Proponiendo", repair: "Reparando", validation: "Validando cobertura", plan_invalid: "Plan inválido", validated: "Plan validado", dispatch: "Ejecución" }[run.planV2.stage] ?? run.planV2.stage}` : "Estado derivado de tareas, sesiones y evidencias."} · Costo {Object.values(run.sessionUsage ?? {}).length && Object.values(run.sessionUsage ?? {}).every(v => typeof v.costUsd === "number") ? `USD ${Object.values(run.sessionUsage ?? {}).reduce((n, v) => n + (v.costUsd ?? 0), 0).toFixed(3)}` : "desconocido"}</p></div><button className="btn btn-xs" onClick={onEvidence}>Ver evidencias</button></header>
    <div className="team-board-tabs" role="group" aria-label="Vistas del plan">{["Tablero", "Árbol", "Dependencias", "Revisiones"].map(name => <button className="btn btn-xs" key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</div>
    <div className="team-board-toolbar">
      <label>Agrupar<select value={grouping} onChange={e => setGrouping(e.target.value)}><option value="state">Por estado</option><option value="agent">Por agente</option></select></label>
      <label>Mostrar<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Todas las tareas</option><option value="attention">Necesitan atención</option><option value="review">Con revisión pendiente</option></select></label>
      <label>Responsable<select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}><option value="">Todos</option>{run.team.members.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="team-board-density"><input type="checkbox" checked={dense} onChange={e => setDense(e.target.checked)} /> Compacto</label>
    </div>
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    {run.status === "planning_blocked" && <section className="team-error" role="alert"><strong>El plan necesita corrección. No se inició ningún trabajador.</strong><ul>{run.planV2?.validation?.issues.map((issue, i) => <li key={i}>{issue.code} · {issue.taskIds.join(", ")} {issue.message}</li>)}</ul><button className="btn btn-sm" disabled={readOnly || saving} onClick={() => { setSaving(true); void onRetry().catch(e => setAnnouncement(String(e))).finally(() => setSaving(false)) }}>Reintentar planificación</button></section>}
    {!cards.length && run.status !== "planning_blocked" && <p className="team-board-empty">{run.status === "planning" ? "El Lead está preparando el contrato. Las tarjetas aparecen después de validarlo." : "Esta ejecución todavía no tiene tareas."}</p>}
    {!!cards.length && !visible.length && tab === "Tablero" && <p className="team-board-empty">No hay tareas que coincidan con estos filtros.</p>}
    {tab === "Tablero" && (grouping === "state" ? columns(visible, "state") : <div className="team-board-lanes">{[...run.team.members].filter(a => !agentFilter || a.id === agentFilter).sort((a,b) => cards.filter(c => c.agent?.id === b.id).length - cards.filter(c => c.agent?.id === a.id).length).map(agent => <section key={agent.id} className="team-board-lane" aria-label={`Tareas de ${agent.name}`}
      onDragOver={e => { if (dragId && !saving) e.preventDefault() }} onDrop={e => { e.preventDefault(); const source = run.tasks.find(t => t.id === e.dataTransfer.getData("application/x-flufy-task")); if (source && source.assignedAgentId !== agent.id) void reassign(source, agent.id) }}>
      <h4>{agent.name} <small>{agent.role} · {activeModels(agent.id) || `Asignado: ${agent.model.providerID}/${agent.model.modelID}`} · {cards.some(c => c.agent?.id === agent.id && c.column === "running") ? "En curso" : "Sin ejecución observada"}</small></h4>
      {visible.some(c => c.agent?.id === agent.id) ? columns(visible.filter(c => c.agent?.id === agent.id), agent.id) : <p className="team-note">Sin tareas asignadas en esta vista.</p>}
    </section>)}</div>)}
    {tab === "Árbol" && <ul className="team-plan-tree">{run.tasks.filter(t => !t.parentTaskId).map(task => {
      const render = (task: TeamTask, depth: number): ReactNode => <li key={task.id}><button className="btn btn-xs" onClick={() => open(task)}>{task.id} · {task.title}</button><span>{task.taskKind === "group" ? `Grupo · ${run.tasks.filter(t => t.parentTaskId === task.id && taskVerified(t)).length}/${run.tasks.filter(t => t.parentTaskId === task.id).length} hijas verificadas` : boardColumns.find(c => c.id === cards.find(c => c.task.id === task.id)?.column)?.label}</span>{depth < 3 && <ul>{run.tasks.filter(t => t.parentTaskId === task.id).map(t => render(t, depth + 1))}</ul>}</li>
      return render(task, 0)
    })}</ul>}
    {tab === "Dependencias" && <div className="team-plan-dependencies">{visible.map(({ task, column }) => <article key={task.id}><button className="btn btn-xs" onClick={() => open(task)}>{task.id} · {task.title}</button><p>{boardColumns.find(c => c.id === column)?.label} ← {task.dependencies.length ? task.dependencies.join(" + ") : "Sin dependencias"}</p></article>)}</div>}
    {tab === "Revisiones" && <ol className="team-plan-revisions">{run.planV2?.revisions.map(revision => <li key={revision.id}><strong>Plan v{revision.number} · {revision.actor}</strong><p>{revision.reason}</p><small>{formatDateTime(revision.createdAt)} · {revision.operations.map(op => String(op.type)).join(", ")}</small><details><summary>Recibo de validación y hash</summary><code>{revision.resultingDigest}</code><p>{revision.validation.valid ? "Contrato validado" : "Contrato rechazado"}</p></details></li>)}{!run.planV2?.revisions.length && <li>No hay revisiones V2 en esta ejecución histórica.</li>}</ol>}
    {selected && <aside className="team-board-detail" ref={detail} tabIndex={-1} aria-label={`Detalle de ${selected.id}`} onKeyDown={e => { if (e.key === "Escape") close() }}>
      <header><h3>{selected.id} · {selected.title}</h3><button className="btn btn-xs" onClick={close}>Cerrar detalle</button></header>
      <p>{selected.objective}</p><p>{run.team.members.find(a => a.id === selected.assignedAgentId)?.name} · Riesgo: {selected.risk ?? "sin clasificar"}</p>
      <h4>Criterios de aceptación</h4><ul>{selected.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
      <h4>Verificación prevista</h4><ul>{selected.verificationPlan?.map((step, i) => <li key={i}><code>{step.command ?? "Observación"}</code> · {step.expected}</li>)}</ul>
      <p className="selectable">Escritura: {selected.writePaths?.join(", ") || "Carpeta exclusiva"}</p><p>Depende de {selected.dependencies.join(", ") || "ninguna tarea"}</p>
      {movableTask(run, selected) && <div className="team-board-edit"><button className="btn btn-sm" disabled={saving || readOnly} onClick={() => void prioritize(selected)}>Priorizar tarea pendiente</button><label>Reasignar tarea pendiente<select disabled={saving || readOnly} value={selected.assignedAgentId} onChange={e => void reassign(selected, e.target.value)}>{run.team.members.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label></div>}
      {selected.attempts.filter(a => a.routing).map(a => <details key={`routing-${a.id}`}><summary>Ruteo: {a.routing!.category} · {a.routing!.policy}</summary><p>{a.routing!.selected.runtimeId} · {a.routing!.selected.capabilityScope} · {a.routing!.selected.modelId}</p><ul>{a.routing!.considered.map((c, i) => <li key={i}>{c.candidate.providerId}/{c.candidate.modelId}: {c.reason}</li>)}</ul><p>Cuota restante: desconocida · Costo estimado: desconocido</p></details>)}
      {selected.attempts.map((attempt, i) => <section key={attempt.id}><h4>Intento {i + 1} · {attempt.agent.name}</h4><p>{attempt.agent.model.providerID}/{attempt.agent.model.modelID} · {attempt.finishedAt ? formatDateTime(attempt.finishedAt) : "Sin cierre observado"}</p><p>{attempt.summary}</p>{attempt.sessionId && <button className="btn btn-xs" onClick={() => onSession(attempt.sessionId!, selected.repository)}>Abrir sesión del intento</button>}{attempt.reviewSessionId && <button className="btn btn-xs" onClick={() => onSession(attempt.reviewSessionId!, selected.repository)}>Abrir revisión</button>}{attempt.review && <p>Revisión: {attempt.review.summary}</p>}{attempt.commands.map((command, index) => <details key={index}><summary>{command.command} · {command.exitCode == null ? "Sin resultado" : command.exitCode === 0 ? "Ejecución correcta" : `Falló (${command.exitCode})`}</summary><pre>{command.output}</pre></details>)}</section>)}
    </aside>}
  </section>
}
