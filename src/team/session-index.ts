import type { TeamChatRecord } from "./types"

// Kept independent of React/UI imports so permission checks also work in the
// lightweight event/attention consumers. Native code remains authoritative.
let sessions = new Set<string>()

export function indexTeamSessions(chats: TeamChatRecord[]) {
  const next = new Set<string>()
  for (const chat of chats) for (const message of chat.messages ?? []) if (message.sessionId) next.add(message.sessionId)
  for (const chat of chats) for (const run of chat.runs) {
    if (run.planSessionId) next.add(run.planSessionId)
    for (const id of run.closingSessions ?? []) next.add(id)
    for (const request of run.coordination ?? []) for (const id of request.sessions) next.add(id)
    for (const task of run.tasks) for (const attempt of task.attempts) {
      if (attempt.sessionId) next.add(attempt.sessionId)
      if (attempt.reviewSessionId) next.add(attempt.reviewSessionId)
    }
  }
  sessions = next
}

export const isTeamSession = (id: string) => sessions.has(id)
