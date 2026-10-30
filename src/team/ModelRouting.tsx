import { useCallback, useEffect, useState } from "react"
import { teamCall } from "../state/teams"
import type { AvailableRouteModel, ModelCandidate, RouteCategory, RoutingConfig, Team } from "./types"

const categories: { id: RouteCategory; label: string }[] = [
  { id: "code", label: "Código" }, { id: "quick", label: "Rápidas" }, { id: "deep", label: "Razonamiento" },
  { id: "visual", label: "Interfaz y visión" }, { id: "review", label: "Revisión" }, { id: "local", label: "Local" },
]
const initial = (): RoutingConfig => ({ enabled: false, routes: [], pinnedAgents: [], maxWorkersPerProvider: 2 })
const key = (m: ModelCandidate) => JSON.stringify([m.runtimeId, m.providerId, m.modelId])

export function ModelRouting({ team, chatId, pending }: { team: Team; chatId: string; pending: boolean }) {
  const [config, setConfig] = useState<RoutingConfig>(() => team.planV2?.routing ?? initial())
  const [models, setModels] = useState<AvailableRouteModel[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const load = useCallback(async () => { const result = await teamCall<AvailableRouteModel[]>("team_routing_catalog", { chatId }); setModels(result ?? []); setLoading(false) }, [chatId])
  // oxlint-disable-next-line react/set-state-in-effect -- Synchronizes the external catalog; setters run after IPC resolves.
  useEffect(() => { void load() }, [load])
  const choose = (category: RouteCategory, index: number, value: string) => {
    setConfig(current => {
      let candidates = [...(current.routes.find(r => r.category === category)?.candidates ?? [])]
      const selected = models.find(m => key(m) === value)
      if (selected) {
        const { runtimeId, providerId, modelId, capabilityScope } = selected
        candidates[index] = { runtimeId, providerId, modelId, capabilityScope, variant: null }
      } else candidates = candidates.slice(0, index)
      candidates = candidates.filter((m, i) => candidates.findIndex(other => key(other) === key(m)) === i)
      return { ...current, routes: [...current.routes.filter(r => r.category !== category), ...(candidates.length ? [{ category, candidates }] : [])] }
    })
  }
  return <details className="team-card team-routing"><summary>Ruteo automático de modelos</summary>
    <p className="team-note">Se aplica a objetivos nuevos de Plan Vivo V2. Sin una cadena configurada, elige por capacidades dentro del proveedor del integrante. Las alternativas entre proveedores requieren tu selección explícita. Una sesión iniciada conserva su modelo.</p>
    <label className="team-board-density"><input type="checkbox" disabled={pending || !team.planV2?.enabled} checked={config.enabled} onChange={e => setConfig(v => ({ ...v, enabled: e.target.checked }))} /> Elegir modelos automáticamente</label>
    <label>Trabajadores simultáneos por proveedor<input type="number" min={1} max={16} value={config.maxWorkersPerProvider} onChange={e => setConfig(v => ({ ...v, maxWorkersPerProvider: Number(e.target.value) }))} /></label>
    <button className="btn btn-xs" disabled={loading} onClick={() => { setLoading(true); void load() }}>{loading ? "Consultando catálogo…" : "Actualizar modelos habilitados"}</button>
    {!loading && !models.length && <p className="team-note">No se pudo observar un catálogo habilitado. No se inventan modelos ni capacidades; revisá la conexión.</p>}
    {categories.map(category => {
      const candidates = config.routes.find(r => r.category === category.id)?.candidates ?? []
      const eligible = models.filter(m => m.tools === true && (category.id !== "visual" || m.vision === true) && (category.id !== "deep" || m.reasoning === true) && (category.id !== "local" || m.providerId.startsWith("ollama")))
      return <fieldset key={category.id}><legend>{category.label}</legend><div className="team-form-grid">{[0, 1, 2].map(index => <label key={index}>{index ? `Alternativa ${index}` : "Modelo principal"}<select disabled={!config.enabled || pending || index > candidates.length} value={candidates[index] ? key(candidates[index]) : ""} onChange={e => choose(category.id, index, e.target.value)}>
        <option value="">{index ? "Sin alternativa" : "Automático en el proveedor actual"}</option>
        {candidates[index] && !eligible.some(m => key(m) === key(candidates[index])) && <option value={key(candidates[index])}>{candidates[index].providerId}/{candidates[index].modelId} · no disponible</option>}
        {eligible.map(m => <option key={key(m)} value={key(m)}>{m.providerId} · {m.name}</option>)}
      </select></label>)}</div></fieldset>
    })}
    <fieldset><legend>Conservar selección manual</legend>{team.members.map(agent => <label className="team-board-density" key={agent.id}><input type="checkbox" disabled={pending} checked={config.pinnedAgents.includes(agent.id)} onChange={e => setConfig(v => ({ ...v, pinnedAgents: e.target.checked ? [...v.pinnedAgents, agent.id] : v.pinnedAgents.filter(id => id !== agent.id) }))} /> Fijar el modelo de {agent.name}</label>)}</fieldset>
    <p className="team-note">Capacidades desconocidas no habilitan selección automática. Cuota, costo y latencia no observados se mantienen desconocidos. El límite de trabajadores no incluye las llamadas de supervisión. Errores de credenciales o de una sesión iniciada se resuelven con la recuperación existente.</p>
    <button className="btn btn-sm" disabled={pending || saving || !Number.isInteger(config.maxWorkersPerProvider) || config.maxWorkersPerProvider < 1 || config.maxWorkersPerProvider > 16} onClick={async () => { setSaving(true); await teamCall("team_chats_planner", { chatId, config: { enabled: team.planV2?.enabled ?? false, reviewBeforeStart: team.planV2?.reviewBeforeStart ?? false, routing: config } }); setSaving(false) }}>Guardar ruteo para próximos objetivos</button>
  </details>
}
