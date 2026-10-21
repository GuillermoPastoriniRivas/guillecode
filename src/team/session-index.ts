import type { Session } from "@opencode-ai/sdk"
import type { TeamChatRecord } from "./types.ts"

// Kept independent of React/UI imports so permission checks also work in the
// lightweight event/attention consumers. Native code remains authoritative.
let sessions = new Set<string>()

export function teamSessionOwners(chats: TeamChatRecord[]) {
  const owners = new Map<string, TeamChatRecord>()
  for (const chat of chats) {
    const add = (id: string | null | undefined) => { if (id) owners.set(id, chat) }
    for (const message of chat.messages ?? []) add(message.sessionId)
    for (const run of chat.runs) {
      add(run.planSessionId)
      for (const id of run.closingSessions ?? []) add(id)
      for (const request of run.coordination ?? []) for (const id of request.sessions) add(id)
      for (const task of run.tasks) for (const attempt of task.attempts) {
        add(attempt.sessionId)
        add(attempt.reviewSessionId)
      }
    }
  }
  return owners
}

export function indexTeamSessions(chats: TeamChatRecord[]) {
  sessions = new Set(teamSessionOwners(chats).keys())
}

export const isTeamSession = (id: string) => sessions.has(id)

export type TeamSessionGroup = { id: string; title: string; chat?: TeamChatRecord; sessions: Session[] }

// Registry IDs survive renames. Walk ancestors so nested engine sessions stay
// with their team even when the parent is outside the current filtered list.
export function groupTeamSessions(visible: Session[], chats: TeamChatRecord[], all: Session[] = visible) {
  const owners = teamSessionOwners(chats)
  const byId = new Map([...all, ...visible].map(s => [s.id, s]))
  const groups = new Map<string, TeamSessionGroup>()
  const normal: Session[] = []
  for (const session of visible) {
    let current: Session | undefined = session
    let owner: TeamChatRecord | undefined
    let internal = false
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      owner = owners.get(current.id)
      internal ||= current.title?.startsWith("Equipo · ") ?? false
      if (owner) break
      current = current.parentID ? byId.get(current.parentID) : undefined
    }
    if (!owner && !internal) { normal.push(session); continue }
    // Unregistered/legacy sessions remain inspectable in a separate folded
    // group; never guess between chats with identical team names.
    const id = owner?.id ?? "legacy-team-sessions"
    let group = groups.get(id)
    if (!group) {
      group = { id, title: owner?.title ?? "Otras sesiones de equipos", chat: owner, sessions: [] }
      groups.set(id, group)
    }
    group.sessions.push(session)
  }
  return { normal, groups: [...groups.values()] }
}
