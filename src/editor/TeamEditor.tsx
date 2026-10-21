import { useState } from "react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { useTeams, teamCall, saveSkill, newTeamChat } from "../state/teams"
import { useAgent } from "../state/agent"
import { useProject } from "../state/project"
import { activeWorkspace } from "../state/features"
import { oneShot } from "../lib/ai"
import { modelKey } from "../lib/opencode"
import { openEditor } from "../state/editors"
import { promptInput } from "../state/quickinput"
import { notify } from "../state/toasts"
import { errorMessage } from "../lib/tauri"
import { Icon } from "../components/ui"
import { latestSkills, type Employee, type Skill, type Team } from "../team/types"
import { EvidenceSettings } from "../team/EvidenceSettings"
import { applySkillProfile, profileSkills, skillProfiles } from "../team/profiles"

function employee(name: string, role: string): Employee {
  return { id: crypto.randomUUID(), name, role, model: { ...useAgent.getState().model }, variant: null, skillRefs: profileSkills(role, useTeams.getState().skills), instructions: "", tools: ["read", "glob", "grep", "edit", "write", "apply_patch", "bash"], maxConcurrentTasks: 1 }
}
function blank(): Team {
  const root = useProject.getState().root ?? ""
  const members = [
    employee("Team Lead", "Lead"),
    employee("QA", "QA"),
    employee("Backend", "Backend"),
    employee("Frontend", "Frontend"),
  ]
  const repos = activeWorkspace()?.repos.map((r) => r.path) ?? []
  return { id: "", name: "Team 1", projectRoot: root, allowedRepositories: repos.length ? repos : [root], leadAgentId: members[0].id, members, maxParallelTasks: 3, maxRetriesPerTask: 1, updatedAt: 0 }
}

function SkillEditor({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const [draft, setDraft] = useState<Skill>(skill ? structuredClone(skill) : { id: "", version: 1, name: "", description: "", instructions: "", verificationGuidelines: [] })
  const [saving, setSaving] = useState(false)
  return <section className="team-card team-skill-editor"><h3>{skill ? `Editar ${skill.name} · nueva versión` : "Skill personalizada"}</h3>
    <label>Nombre de skill<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
    <label>Descripción<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
    <label>Instrucciones de skill<textarea rows={5} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></label>
    <label>Comprobaciones (una por línea)<textarea rows={3} value={draft.verificationGuidelines.join("\n")} onChange={(e) => setDraft({ ...draft, verificationGuidelines: e.target.value.split("\n") })} /></label>
    <div className="team-actions"><button className="btn btn-primary" disabled={saving || !draft.name.trim() || !draft.instructions.trim()} onClick={() => { setSaving(true); void saveSkill({ ...draft, verificationGuidelines: draft.verificationGuidelines.filter(Boolean) }).then((s) => { setSaving(false); if (s) onClose() }) }}>Guardar versión de skill</button><button className="btn" onClick={onClose}>Cerrar</button></div>
  </section>
}

export function TeamEditor({ id }: { id: string }) {
  const loaded = useTeams((s) => s.loaded)
  const error = useTeams((s) => s.error)
  if (error) return <div className="team-error">{error}</div>
  if (!loaded) return <div className="team-note">Cargando equipos…</div>
  return <TeamEditorForm id={id} />
}

function TeamEditorForm({ id }: { id: string }) {
  const original = useTeams((s) => s.teams.find((t) => t.id === id))
  const skills = useTeams((s) => s.skills)
  const models = useAgent((s) => s.models)
  const [draft, setDraft] = useState<Team>(() => original ? structuredClone(original) : blank())
  const [editingSkill, setEditingSkill] = useState<Skill | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)
  const latest = latestSkills(skills)
  const patch = (p: Partial<Team>) => { setDraft((d) => ({ ...d, ...p })); setChanged(true) }
  const patchEmployee = (id: string, p: Partial<Employee>) => patch({ members: draft.members.map((m) => m.id === id ? { ...m, ...p } : m) })
  const save = async (chat: boolean) => {
    setBusy(true)
    const team = await teamCall<Team>("teams_save", { team: draft })
    setBusy(false)
    if (team) { setDraft(team); setChanged(false); if (chat) await newTeamChat(team.id); else { openEditor({ kind: "team", id: team.id }); notify.success("Equipo guardado") } }
  }
  const propose = async () => {
    const goal = await promptInput({ title: "Propuesta asistida de equipo", prompt: "Describí el proyecto y las especialidades que necesitás." })
    if (!goal) return
    setBusy(true)
    try {
      const reply = await oneShot("Propuesta de equipo", `Necesidad: ${goal}\nSkills: ${JSON.stringify(latest.map((s) => ({ id: s.id, name: s.name, description: s.description })))}\nModelos disponibles: ${models.map((m) => modelKey(m)).join(", ")}`, 'Proponé entre 1 y 8 empleados para un equipo de desarrollo. Primero el Lead. No ejecutes tareas. Respondé solo JSON: {"name":"nombre","members":[{"name":"nombre","role":"rol","model":"provider/model disponible","skills":["id existente"]}]}')
      const raw: unknown = JSON.parse(reply.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""))
      if (!raw || typeof raw !== "object" || !("members" in raw) || !Array.isArray(raw.members) || !raw.members.length || raw.members.length > 8) throw new Error("La propuesta no contiene integrantes válidos")
      const members = raw.members.map((m: unknown) => {
        if (!m || typeof m !== "object" || !("name" in m) || !("role" in m) || typeof m.name !== "string" || typeof m.role !== "string") throw new Error("Integrante inválido")
        const value = employee(m.name, m.role)
        const selected = models.find((v) => "model" in m && modelKey(v) === m.model)
        if (selected) value.model = { providerID: selected.providerID, modelID: selected.modelID }
        value.skillRefs = latest.filter((s) => "skills" in m && Array.isArray(m.skills) && m.skills.includes(s.id)).map((s) => ({ id: s.id, version: s.version }))
        return value
      })
      patch({ name: "name" in raw && typeof raw.name === "string" ? raw.name : draft.name, members, leadAgentId: members[0].id })
      notify.info("Propuesta lista para revisar", "Revisá integrantes, modelos y skills, y guardá el equipo.")
    } catch (e) { notify.error("No se pudo proponer el equipo", errorMessage(e)) }
    finally { setBusy(false) }
  }
  return <div className="team-editor">
    <header className="team-editor-header"><Icon name="organization" /><div><h2>{draft.id ? draft.name : "Crear equipo IA"}</h2><p>Vos definís el objetivo. El Lead coordina el trabajo y las comprobaciones hasta completar la entrega.</p></div></header>
    <div className="team-editor-body">
      <EvidenceSettings team={draft} update={patch} />
      <section className="team-card">
        <div className="team-form-grid"><label>Nombre del equipo<input value={draft.name} onChange={(e) => patch({ name: e.target.value })} /></label><label>Concurrencia total<input type="number" min={1} max={16} value={draft.maxParallelTasks} onChange={(e) => patch({ maxParallelTasks: Number(e.target.value) })} /></label><label>Reintentos automáticos por tarea<input type="number" min={0} max={5} value={draft.maxRetriesPerTask} onChange={(e) => patch({ maxRetriesPerTask: Number(e.target.value) })} /></label></div>
        <p className="team-note">Proyecto: {draft.projectRoot}</p>
        <h3>Repositorios autorizados</h3>
        <p className="team-note">Podés trabajar en cualquier carpeta del proyecto, con o sin Git. Se registra el estado inicial de los archivos para comparar cambios; no se inicializa Git por su cuenta.</p>
        {draft.allowedRepositories.map((r) => <div className="team-actions" key={r}><code>{r}</code><button className="btn btn-xs" disabled={draft.allowedRepositories.length === 1} onClick={() => patch({ allowedRepositories: draft.allowedRepositories.filter((v) => v !== r) })}>Quitar</button></div>)}
        <button className="btn btn-sm" onClick={() => void openDialog({ directory: true, title: "Autorizar carpeta para este equipo" }).then((p) => { if (typeof p === "string" && !draft.allowedRepositories.includes(p)) patch({ allowedRepositories: [...draft.allowedRepositories, p] }) })}>Agregar carpeta…</button>
        <p className="team-note">Frontend, Backend y QA pueden avanzar a la vez en archivos propios. El Lead reparte la escritura y revisa los pedidos entre agentes; los archivos compartidos esperan su turno. El shell conserva los permisos de OpenCode; el revisor usa solo lectura. Límite: 45 minutos por sesión. La ejecución requiere el motor local activo.</p>
      </section>
      <div className="team-section-title"><h3>Integrantes</h3><div className="team-actions"><button className="btn btn-sm" disabled={busy} onClick={() => void propose()}><Icon name="sparkle" /> Propuesta con IA</button><button className="btn btn-sm" onClick={() => patch({ members: [...draft.members, employee(`Especialista ${draft.members.length}`, "Especialista")] })}>Agregar especialista</button></div></div>
      {draft.members.map((m) => {
        const model = models.find((v) => modelKey(v) === modelKey(m.model))
        return <section key={m.id} className="team-card team-employee">
          <div className="team-section-title"><label className="team-check"><input type="radio" name={`lead-${id}`} checked={draft.leadAgentId === m.id} onChange={() => patch({ leadAgentId: m.id })} /> Team Lead</label><button className="btn btn-xs" disabled={m.id === draft.leadAgentId} onClick={() => patch({ members: draft.members.filter((v) => v.id !== m.id) })}>Quitar integrante</button></div>
          <div className="team-form-grid"><label>Nombre del integrante<input value={m.name} onChange={(e) => patchEmployee(m.id, { name: e.target.value })} /></label><label>Rol<input value={m.role} onChange={(e) => patchEmployee(m.id, { role: e.target.value })} /></label><label>Modelo del integrante<select value={modelKey(m.model)} onChange={(e) => { const selected = models.find((v) => modelKey(v) === e.target.value); if (selected) patchEmployee(m.id, { model: { providerID: selected.providerID, modelID: selected.modelID }, variant: null }) }}>{!model && <option value={modelKey(m.model)}>{modelKey(m.model) || "Seleccioná modelo"} · no disponible</option>}{models.map((v) => <option key={modelKey(v)} value={modelKey(v)}>{v.providerName} · {v.name}</option>)}</select></label>
          <label>Variante<select aria-label="Variante" value={m.variant ?? ""} onChange={(e) => patchEmployee(m.id, { variant: e.target.value || null })}><option value="">Predeterminada</option>{model?.variants.map((v) => <option key={v}>{v}</option>)}</select></label><label>Tareas simultáneas<input type="number" min={1} max={16} value={m.maxConcurrentTasks} onChange={(e) => patchEmployee(m.id, { maxConcurrentTasks: Number(e.target.value) })} /></label></div>
          {!model && <p className="team-error">El modelo asignado no está disponible. Elegí otro o reconectá su cuenta.</p>}
          <label>Aplicar perfil de skills<select value="" onChange={(e) => { if (e.target.value) patchEmployee(m.id, applySkillProfile(m, e.target.value, skills)) }}><option value="">Elegí una especialidad…</option>{skillProfiles.map((p) => <option key={p.role} value={p.role}>{p.name}</option>)}</select></label>
          <p className="team-note">El perfil agrega skills con guardas y conserva las selecciones adicionales. Los permisos efectivos se controlan por separado; Code Review quita las herramientas de edición.</p>
          <h4>Skills combinables</h4><div className="team-skill-list">{latest.map((s) => {
            const ref = m.skillRefs.find((r) => r.id === s.id)
            return <label key={s.id} className="team-check"><input type="checkbox" checked={!!ref} onChange={(e) => patchEmployee(m.id, { skillRefs: e.target.checked ? [...m.skillRefs, { id: s.id, version: s.version }] : m.skillRefs.filter((r) => r.id !== s.id) })} />{s.name} v{ref?.version ?? s.version}{ref && ref.version !== s.version && <button className="team-link" type="button" onClick={() => patchEmployee(m.id, { skillRefs: m.skillRefs.map((r) => r.id === s.id ? { id: s.id, version: s.version } : r) })}>Actualizar a v{s.version}</button>}</label>
          })}</div>
          <label>Instrucciones adicionales<textarea rows={2} value={m.instructions} onChange={(e) => patchEmployee(m.id, { instructions: e.target.value })} /></label>
          <details><summary>Herramientas permitidas</summary><div className="team-skill-list">{["read", "glob", "grep", "edit", "write", "apply_patch", "bash"].map((tool) => <label key={tool} className="team-check"><input type="checkbox" checked={m.tools.includes(tool)} onChange={(e) => patchEmployee(m.id, { tools: e.target.checked ? [...m.tools, tool] : m.tools.filter((t) => t !== tool) })} />{tool}{tool === "bash" ? " (permiso de OpenCode)" : ""}</label>)}</div></details>
        </section>
      })}
      <section className="team-card"><div className="team-section-title"><h3>Registro de skills</h3><button className="btn btn-sm" onClick={() => setEditingSkill(null)}>Crear skill</button></div><p className="team-note">Las versiones guardadas se conservan. Los chats usan su snapshot; editar la plantilla afecta solo a chats nuevos.</p><div className="team-skill-list">{latest.map((s) => <button className="btn btn-xs" key={s.id} onClick={() => setEditingSkill(s)}>{s.name} v{s.version} · editar</button>)}</div></section>
      {editingSkill !== undefined && <SkillEditor key={`${editingSkill?.id ?? "new"}-${editingSkill?.version ?? 0}`} skill={editingSkill} onClose={() => setEditingSkill(undefined)} />}
    </div>
    <footer className="team-editor-footer"><span>{changed ? "Cambios sin guardar" : "Plantilla de equipo"}</span><button className="btn" disabled={busy || !draft.name.trim()} onClick={() => void save(false)}>Guardar equipo</button><button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={() => void save(true)}>Guardar y abrir Team Chat</button></footer>
  </div>
}
