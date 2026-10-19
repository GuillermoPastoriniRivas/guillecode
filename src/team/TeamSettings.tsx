import { useAgent } from "../state/agent"
import { modelKey } from "../lib/opencode"
import { variantLabel } from "../state/agent"
import type { Employee, Team, TeamRun } from "./types"

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

export function TeamSettings({ team, run }: { team: Team; run?: TeamRun }) {
  const roster = run?.team ?? team
  return <section className="team-settings">
    <h3>Configuración del equipo</h3>
    <p className="team-note">{run ? "Modelos asignados en esta ejecución. Los intentos conservan el modelo con el que comenzaron." : "Modelos del equipo antes de empezar."}</p>
    {roster.autonomous && <p className="team-note">El Lead elige los especialistas al organizar tu pedido. Los nuevos integrantes heredan su modelo y razonamiento.</p>}
    {roster.members.map(agent => <article className="team-card" key={agent.id}>
      <h4>{agent.name} · {agent.role}</h4>
      <ModelDetails agent={agent} />
      {run?.tasks.filter(t => t.assignedAgentId === agent.id).flatMap(t => t.attempts.filter(a => ["running", "verifying", "waiting_dependency"].includes(a.status)).map(a => <details key={a.id}><summary>Modelo del intento en curso · {t.title}</summary><ModelDetails agent={a.agent} /></details>))}
    </article>)}
    {run && <details className="team-card"><summary>Modelos usados en los intentos</summary>{run.tasks.map(task => <section key={task.id}><h4>{task.title}</h4>{task.attempts.length ? task.attempts.map((attempt, i) => <details key={attempt.id}><summary>Intento {i + 1} · {attempt.agent.name}</summary><ModelDetails agent={attempt.agent} /></details>) : <p className="team-note">Todavía no comenzó.</p>}</section>)}</details>}
  </section>
}
