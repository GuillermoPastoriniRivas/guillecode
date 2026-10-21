import type { ReactNode } from "react"
import { Icon } from "../components/ui"
import { selectTeamChat } from "../state/teams"
import { runStatusLabel } from "./types"
import type { TeamSessionGroup } from "./session-index"

export function TeamSessionHistory({ group, children }: { group: TeamSessionGroup; children: ReactNode }) {
  return <details className="team-session-history">
    <summary><Icon name="organization" /><span>{group.title}</span><small>{group.sessions.length} sesiones</small></summary>
    <div className="team-session-history-body">
      {group.chat && <div className="team-session-history-lead">
        <span>{runStatusLabel(group.chat.runs.at(-1)?.status ?? "") ?? "Listo para tu objetivo"}</span>
        <button type="button" className="btn btn-xs" onClick={() => selectTeamChat(group.chat!.id)}>Hablar con el Lead</button>
      </div>}
      {children}
    </div>
  </details>
}
