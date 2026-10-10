import { create } from "zustand"
import { call, isTauri, onEvent } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { notify } from "./toasts"
import { DRAFT_TAB } from "./agent"

type ApprovalsView = { autoApprove: boolean; sessions: Record<string, boolean> }

type ApprovalsState = {
  autoApprove: boolean
  sessions: Record<string, boolean>
  loaded: boolean
  failed: string[]
}

export const useApprovals = create<ApprovalsState>(() => ({
  autoApprove: false,
  sessions: !isTauri ? loadJson("approvals.sessions", {}) : {},
  loaded: false,
  failed: [],
}))

export function approveFor(sessionId: string | null | undefined): boolean {
  const s = useApprovals.getState()
  const key = sessionId ?? DRAFT_TAB
  return key in s.sessions ? s.sessions[key] : s.autoApprove
}

export async function loadApprovals(): Promise<void> {
  if (!isTauri) {
    useApprovals.setState({ loaded: true })
    return
  }
  try {
    const view = await call<ApprovalsView>("approvals_get")
    useApprovals.setState({ autoApprove: !!view?.autoApprove, sessions: view?.sessions ?? {}, loaded: true })
  } catch {
    useApprovals.setState({ loaded: true })
  }
}

export function markApprovalFailed(id: string): void {
  useApprovals.setState((s) => (s.failed.includes(id) ? s : { failed: [...s.failed, id] }))
}

export function clearApprovalFailed(id: string): void {
  useApprovals.setState((s) => (s.failed.includes(id) ? { failed: s.failed.filter((x) => x !== id) } : s))
}

export function initApprovals(): void {
  if (isTauri) {
    onEvent<{ id?: string }>("approvals://auto-failed", (payload) => {
      if (payload?.id) markApprovalFailed(payload.id)
    })
  }
  void loadApprovals()
}

export function setApprovalForSession(sessionId: string, enabled: boolean): void {
  useApprovals.setState((s) => ({ sessions: { ...s.sessions, [sessionId]: enabled } }))
  saveJson("approvals.sessions", useApprovals.getState().sessions)
  if (isTauri && sessionId && sessionId !== DRAFT_TAB) {
    void call("approvals_set_session", { session: sessionId, enabled }).catch(() => undefined)
  }
}

export async function setAutoApprove(on: boolean): Promise<void> {
  const prev = useApprovals.getState().autoApprove
  useApprovals.setState({ autoApprove: on })
  if (isTauri) {
    try {
      await call("approvals_set", { autoApprove: on })
    } catch (e) {
      useApprovals.setState({ autoApprove: prev })
      notify.error("No se pudo cambiar la aprobación automática", e instanceof Error ? e.message : String(e))
      return
    }
  }
  notify.info(
    on ? "Aprobación automática por defecto: activada" : "Aprobación automática por defecto: desactivada",
    on ? "Las conversaciones nuevas arrancan sin pedir permiso (podés apagarlo por chat)." : "Las conversaciones nuevas te vuelven a pedir autorización.",
  )
}
