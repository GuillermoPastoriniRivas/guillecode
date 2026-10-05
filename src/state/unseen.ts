import { create } from "zustand"
import type { Session, SessionStatus } from "@opencode-ai/sdk"
import { loadJson, saveJson } from "../lib/persist"
import { sessionWaiting, subscribeSessionFinished, useAgent, type PermissionRequest, type QuestionRequest } from "./agent"
import { tabId, useEditors } from "./editors"
import { useLayout } from "./layout"

type Unseen = Record<string, number>

const KEY = "agent.unseen"
const MAX = 200

export const useUnseen = create<{ ids: Unseen }>(() => ({ ids: loadJson<Unseen>(KEY, {}) }))

function persist(update: (stored: Unseen) => Unseen): void {
  const entries = Object.entries(update(loadJson<Unseen>(KEY, {})))
  saveJson(KEY, Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX)))
}

function mark(id: string): void {
  const at = Date.now()
  useUnseen.setState((s) => ({ ids: { ...s.ids, [id]: at } }))
  persist((stored) => ({ ...stored, [id]: at }))
}

function without(ids: Unseen, remove: string[]): Unseen {
  const next = { ...ids }
  for (const id of remove) delete next[id]
  return next
}

function clear(remove: string[]): void {
  if (remove.length === 0) return
  useUnseen.setState((s) => ({ ids: without(s.ids, remove) }))
  persist((stored) => without(stored, remove))
}

export function watchingSession(id: string): boolean {
  if (!document.hasFocus()) return false
  const layout = useLayout.getState()
  if (layout.agentVisible && useAgent.getState().activeSessionId === id) return true
  if (layout.focusChat) return false
  const tab = tabId({ kind: "chat", sessionId: id })
  return useEditors.getState().groups.some((g) => g.activeId === tab)
}

function sweep(): void {
  const ids = Object.keys(useUnseen.getState().ids)
  if (ids.length === 0) return
  const statuses = useAgent.getState().statuses
  clear(ids.filter((id) => (statuses[id] && statuses[id].type !== "idle") || watchingSession(id)))
}

function onFinished(id: string): void {
  const agent = useAgent.getState()
  const session = agent.allSessions.find((s) => s.id === id)
  if (!session || session.parentID) return
  if (sessionWaiting(agent, id) || watchingSession(id)) return
  mark(id)
}

export type SessionMark = "attention" | "busy" | "retry" | "unseen" | "idle"

type MarkSource = {
  allSessions: Session[]
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  statuses: Record<string, SessionStatus>
}

export function sessionMark(s: MarkSource, unseen: Unseen, id: string): SessionMark {
  if (sessionWaiting(s, id)) return "attention"
  const status = s.statuses[id]?.type ?? "idle"
  if (status !== "idle") return status
  return id in unseen ? "unseen" : "idle"
}

export function useSessionMark(id: string): SessionMark {
  const unseen = useUnseen((s) => s.ids)
  return useAgent((s) => sessionMark(s, unseen, id))
}

let off: (() => void) | null = null

export function initUnseen(): () => void {
  if (off) return off
  const offFinished = subscribeSessionFinished(onFinished)
  const offAgent = useAgent.subscribe((s, prev) => {
    if (s.activeSessionId !== prev.activeSessionId || s.statuses !== prev.statuses) sweep()
  })
  const offLayout = useLayout.subscribe((s, prev) => {
    if (s.agentVisible !== prev.agentVisible || s.focusChat !== prev.focusChat) sweep()
  })
  const offEditors = useEditors.subscribe((s, prev) => {
    if (s.groups !== prev.groups) sweep()
  })
  window.addEventListener("focus", sweep)
  off = () => {
    offFinished()
    offAgent()
    offLayout()
    offEditors()
    window.removeEventListener("focus", sweep)
    off = null
  }
  return off
}
