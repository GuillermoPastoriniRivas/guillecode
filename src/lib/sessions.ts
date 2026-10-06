import type { Session } from "@opencode-ai/sdk"

// The engine supports this field, but the legacy SDK's Session type omits it.
export function isArchivedSession(session: Pick<Session, "time">): boolean {
  return !!(session.time as Session["time"] & { archived?: number }).archived
}

export function archivedSessionOwner(session: Session | null, sessions: Session[]): Session | null {
  let owner: Session | null = null
  const seen = new Set<string>()
  while (session && !seen.has(session.id)) {
    seen.add(session.id)
    if (isArchivedSession(session)) owner = session
    session = sessions.find((s) => s.id === session?.parentID) ?? null
  }
  return owner
}

export function sessionTreeIds(sessions: Session[], roots: string[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = children.get(session.parentID) ?? []
    list.push(session.id)
    children.set(session.parentID, list)
  }
  const ids = new Set(roots)
  for (const id of ids) {
    for (const child of children.get(id) ?? []) ids.add(child)
  }
  return ids
}

export function archivedSessionIds(sessions: Session[]): Set<string> {
  return sessionTreeIds(sessions, sessions.filter(isArchivedSession).map((s) => s.id))
}

export function unarchivedSessions(sessions: Session[]): Session[] {
  const archived = archivedSessionIds(sessions)
  return sessions.filter((s) => !archived.has(s.id))
}
