import { useEffect } from "react"
import { Icon, IconButton } from "../components/ui"
import { openContextMenu } from "../components/ContextMenu"
import { useProject } from "../state/project"
import { samePath } from "../lib/paths"
import { deleteTeam, duplicateTeam, newTeamChat, openTeam, renameChat, selectTeamChat, startTeams, teamCall, useTeams } from "../state/teams"
import { runStatusLabel } from "../team/types"

export function TeamsView() {
  const { teams, chats, loaded, error } = useTeams()
  const root = useProject((s) => s.root)
  useEffect(() => startTeams(), [])
  const mine = teams.filter((t) => root && samePath(t.projectRoot, root))
  const openTeamChat = (teamId: string) => {
    const existing = chats.slice().reverse().find((chat) => chat.team.id === teamId && !chat.archived)
    if (existing) selectTeamChat(existing.id)
    else void newTeamChat(teamId)
  }
  return <div className="view teams-view">
    <div className="view-header"><span className="view-title">Equipos IA</span><IconButton icon="add" title="Crear equipo" onClick={() => openTeam()} /></div>
    {error && <p className="team-error">{error}</p>}
    {!root ? <p className="team-note">Abrí un proyecto para crear sus equipos.</p> : <div className="team-sidebar-list">
      <button className="btn btn-primary" onClick={() => void newTeamChat()}><Icon name="organization" /> Modo equipo</button>
      {loaded && !mine.length && <p className="team-note">Escribí el objetivo. El Lead elige cuántos agentes necesita y los pone a trabajar en paralelo. También podés crear una plantilla manual.</p>}
      {mine.map((t) => <article key={t.id} className="team-sidebar-card" onContextMenu={(e) => openContextMenu(e, [
        { label: "Editar / renombrar", icon: "edit", run: () => openTeam(t.id) },
        { label: "Duplicar", icon: "copy", run: () => void duplicateTeam(t) },
        { label: "Eliminar plantilla", icon: "trash", danger: true, run: () => void deleteTeam(t) },
      ])}>
        <button className="team-link" onClick={() => openTeamChat(t.id)}><Icon name="organization" /> <strong>{t.name}</strong></button>
        <p>{t.members.length} integrantes · {t.members.map((m) => m.role).join(", ")}</p>
        <div className="team-actions"><button className="btn btn-xs" onClick={() => openTeamChat(t.id)}>Abrir chat</button><button className="btn btn-xs" onClick={() => openTeam(t.id)}>Configurar</button></div>
      </article>)}
      <h3>Historial de Team Chats</h3>
      {chats.filter((c) => root && samePath(c.team.projectRoot, root)).slice().reverse().map((c) => <article className="team-sidebar-card" key={c.id}>
        <button className="team-link" onClick={() => selectTeamChat(c.id)}><Icon name={c.archived ? "archive" : "organization"} /> {c.title}</button>
        <p>{runStatusLabel(c.runs.at(-1)?.status ?? "") ?? "Sin objetivo todavía"}</p>
        <div className="team-actions"><button className="btn btn-xs" onClick={() => void renameChat(c)}>Renombrar</button><button className="btn btn-xs" onClick={() => void teamCall("team_chats_edit", { id: c.id, title: c.title, archived: !c.archived })}>{c.archived ? "Restaurar" : "Archivar"}</button></div>
      </article>)}
    </div>}
  </div>
}
