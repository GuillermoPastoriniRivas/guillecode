import { create } from "zustand"

export type ToastKind = "info" | "success" | "warning" | "error" | "progress"

export type ToastAction = { label: string; run: () => void; primary?: boolean }

export type Toast = {
  id: number
  kind: ToastKind
  title: string
  detail?: string
  actions?: ToastAction[]
  sticky?: boolean
}

type ToastState = {
  toasts: Toast[]
  push: (toast: Omit<Toast, "id">) => number
  update: (id: number, patch: Partial<Omit<Toast, "id">>) => void
  dismiss: (id: number) => void
}

let nextId = 1
const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  info: 4200,
  success: 3200,
  warning: 7000,
  error: 9000,
  progress: 0,
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...toast, id }] }))
    const ms = AUTO_DISMISS_MS[toast.kind]
    if (!toast.sticky && ms > 0) setTimeout(() => get().dismiss(id), ms)
    return id
  },
  update: (id, patch) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    const kind = patch.kind
    if (kind && kind !== "progress" && !patch.sticky) setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS[kind])
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const notify = {
  info: (title: string, detail?: string) => useToasts.getState().push({ kind: "info", title, detail }),
  success: (title: string, detail?: string) => useToasts.getState().push({ kind: "success", title, detail }),
  warning: (title: string, detail?: string) => useToasts.getState().push({ kind: "warning", title, detail }),
  error: (title: string, detail?: string) => useToasts.getState().push({ kind: "error", title, detail }),
}

export async function withProgress<T>(title: string, work: () => Promise<T>, done?: string): Promise<T> {
  const store = useToasts.getState()
  const id = store.push({ kind: "progress", title })
  try {
    const result = await work()
    if (done) store.update(id, { kind: "success", title: done })
    else store.dismiss(id)
    return result
  } catch (e) {
    store.update(id, { kind: "error", title: `${title}: falló`, detail: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
