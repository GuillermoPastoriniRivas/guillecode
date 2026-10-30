import { useAgent } from "../state/agent"
import { modelKey } from "../lib/opencode"
import { variantLabel } from "../state/agent"
import type { Employee, Team, TeamRun } from "./types"
import { ModelRouting } from "./ModelRouting"
import { teamCall } from "../state/teams"

function ModelDetails({ agent }: { agent: Employee }) {
  const models = useAgent(s => s.models)
  const model = models.find(m => modelKey(m) === modelKey(agent.model))
  return <dl className="team-model-details">
    <div><dt>Proveedor</dt><dd>{model?.providerName ?? agent.model.providerID}</dd></div>
    <div><dt>Modelo</dt><dd>{model?.name ?? agent.model.modelID}<code>{modelKey(agent.model)}</code></dd></div>
    <div><dt>Razonamiento</dt><dd>{agent.variant ? variantLabel(agent.variant) : "Automático"}{agent.variant && <code>{agent.variant}</code>}</dd></div>
    {model && <div><dt>Imágenes</dt><dd>{model.image ? "Admite imágenes" : "El catálogo no informa soporte de imágenes"}</dd></div>}
  </dl>
}

export function TeamSettings({ team, run, chatId, pending }: { team: Team; run?: TeamRun; chatId: string; pending: boolean }) {
  const models = useAgent(s => s.models)
  const roster = run?.team ?? team
  return <section className="team-settings">
    <h3>Configuración del equipo</h3>
    <section className="team-card"><h4>Plan Vivo V2 · experimental</h4>
      <p className="team-note">Se aplica a los próximos objetivos. Cada ejecución conserva su planificador original. Desactivado inicialmente.</p>
      <label className="team-board-density"><input type="checkbox" disabled={pending} checked={team.planV2?.enabled ?? false} onChange={e => void teamCall("team_chats_planner", { chatId, config: { ...team.planV2, enabled: e.target.checked, reviewBeforeStart: team.planV2?.reviewBeforeStart ?? false } })} /> Activar Plan Vivo V2</label>
      <label className="team-board-density"><input type="checkbox" disabled={pending || !team.planV2?.enabled} checked={team.planV2?.reviewBeforeStart ?? false} onChange={e => void teamCall("team_chats_planner", { chatId, config: { ...team.planV2, enabled: team.planV2?.enabled ?? false, reviewBeforeStart: e.target.checked } })} /> Revisar plan antes de iniciar</label>
    </section>
    <ModelRouting team={team} chatId={chatId} pending={pending} />
    <p className="team-note">El Lead y los especialistas pueden consultar la web, usar el navegador elegido en este chat y manejar apps con el control de la PC activado. Las acciones y sus resultados se pueden abrir desde Actividad.</p>
    <p className="team-note">{run ? "Modelos asignados en esta ejecución. Los intentos conservan el modelo con el que comenzaron." : "Modelos del equipo antes de empezar."}</p>
    {roster.autonomous && <p className="team-note">El Lead elige los especialistas al organizar tu pedido. Los nuevos integrantes heredan su modelo y razonamiento.</p>}
    {roster.members.map(agent => <article className="team-card" key={agent.id}>
      <h4>{agent.name} · {agent.role}</h4>
      <ModelDetails agent={agent} />
      {run?.tasks.filter(t => t.assignedAgentId === agent.id).flatMap(t => t.attempts.filter(a => ["running", "verifying", "waiting_dependency"].includes(a.status)).map(a => <details key={a.id}><summary>Modelo del intento en curso · {t.title}</summary><ModelDetails agent={a.agent} /></details>))}
    </article>)}
    <details className="team-card" open={!run}><summary>Modelo para los próximos mensajes</summary>
      <p className="team-note">Se aplica a tus siguientes pedidos en este chat. Los modelos de las ejecuciones e intentos anteriores se conservan. En modo automático, los nuevos especialistas heredan el modelo del Lead.</p>
      {team.members.map(agent => <label key={agent.id}>{agent.name}<select disabled={pending} aria-label={`Modelo de ${agent.name} para nuevos mensajes`} value={modelKey(agent.model)} onChange={e => {
        const model = models.find(m => modelKey(m) === e.target.value)
        if (model) void teamCall("team_chats_model", { chatId, agentId: agent.id, model: { providerID: model.providerID, modelID: model.modelID }, variant: null })
      }}><option value={modelKey(agent.model)}>{models.find(m => modelKey(m) === modelKey(agent.model))?.name ?? modelKey(agent.model)}</option>{models.filter(m => modelKey(m) !== modelKey(agent.model)).map(m => <option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>)}
      {pending && <p className="team-note">Esperá o detené la respuesta del Lead para cambiar el modelo.</p>}
    </details>
    {run && <details className="team-card"><summary>Modelos usados en los intentos</summary>{run.tasks.map(task => <section key={task.id}><h4>{task.title}</h4>{task.attempts.length ? task.attempts.map((attempt, i) => <details key={attempt.id}><summary>Intento {i + 1} · {attempt.agent.name}</summary><ModelDetails agent={attempt.agent} /></details>) : <p className="team-note">Todavía no comenzó.</p>}</section>)}</details>}
  </section>
}
