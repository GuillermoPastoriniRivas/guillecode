import { create } from "zustand"
import { call, isTauri, onEvent } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { notify } from "./toasts"

type ApprovalsState = {
  autoApprove: boolean
  loaded: boolean
  failed: string[]
}

export const useApprovals = create<ApprovalsState>(() => ({
  autoApprove: !isTauri ? loadJson("approvals.autoApprove", false) : false,
  loaded: false,
  failed: [],
}))

export async function loadApprovals(): Promise<void> {
  if (!isTauri) {
    useApprovals.setState({ loaded: true })
    return
  }
  try {
    const on = await call<boolean>("approvals_get")
    useApprovals.setState({ autoApprove: !!on, loaded: true })
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

export async function setAutoApprove(on: boolean): Promise<void> {
  const prev = useApprovals.getState().autoApprove
  useApprovals.setState({ autoApprove: on })
  saveJson("approvals.autoApprove", on)
  if (isTauri) {
    try {
      await call<boolean>("approvals_set", { autoApprove: on })
    } catch (e) {
      useApprovals.setState({ autoApprove: prev })
      saveJson("approvals.autoApprove", prev)
      notify.error("No se pudo cambiar la aprobación automática", e instanceof Error ? e.message : String(e))
      return
    }
  }
  notify.info(
    on ? "Aprobación automática activada" : "Aprobación automática desactivada",
    on ? "El agente aprueba solo los permisos y no te interrumpe." : "El agente te vuelve a pedir autorización.",
  )
}
