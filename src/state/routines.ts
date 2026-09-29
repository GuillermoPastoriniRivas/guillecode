import { create } from "zustand"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"
import { notify } from "./toasts"
import { openEditor, removeTabs, tabId } from "./editors"
import { confirmAction } from "../components/Dialog"

export type Schedule =
  | { kind: "interval"; hours: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }

export type RoutineRun = {
  id: string
  startedAt: number
  finishedAt: number | null
  sessionId: string | null
  status: string
  summary: string
  error: string | null
  manual: boolean
}

export type Routine = {
  id: string
  name: string
  project: string
  prompt: string
  schedule: Schedule
  agent: string | null
  model: { providerID: string; modelID: string } | null
  variant: string | null
  enabled: boolean
  createdAt: number
  runs: RoutineRun[]
  nextRun: number | null
}

export type RoutineDraft = Omit<Routine, "createdAt" | "runs" | "nextRun">

type RoutinesState = { items: Routine[]; loaded: boolean }

export const useRoutines = create<RoutinesState>(() => ({ items: [], loaded: false }))

export const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]

export function scheduleLabel(s: Schedule): string {
  if (s.kind === "interval") return s.hours === 1 ? "Cada hora" : `Cada ${s.hours} horas`
  if (s.kind === "daily") return `Todos los días a las ${s.time}`
  const days = [...s.days].sort((a, b) => a - b)
  if (days.length === 5 && days.every((d, i) => d === i)) return `Lunes a viernes a las ${s.time}`
  return `${days.map((d) => WEEKDAYS[d]).join(", ")} a las ${s.time}`
}

export function runStatusLabel(run: RoutineRun | undefined): { label: string; tone: string } {
  if (!run) return { label: "Nunca corrió", tone: "" }
  switch (run.status) {
    case "corriendo":
      return { label: "Corriendo", tone: "busy" }
    case "esperando":
      return { label: "Espera tu respuesta", tone: "warn" }
    case "ok":
      return { label: "Terminó bien", tone: "ok" }
    case "timeout":
      return { label: "Se pasó de tiempo", tone: "error" }
    case "interrumpida":
      return { label: "Interrumpida", tone: "error" }
    default:
      return { label: "Falló", tone: "error" }
  }
}

export async function loadRoutines(): Promise<void> {
  if (!isTauri) return
  try {
    const items = await call<Routine[]>("routines_list")
    useRoutines.setState({ items: items.sort((a, b) => a.name.localeCompare(b.name)), loaded: true })
  } catch (e) {
    notify.error("No se pudieron cargar las rutinas", errorMessage(e))
  }
}

let listening = false

export function startRoutines(): void {
  if (listening || !isTauri) return
  listening = true
  void loadRoutines()
  onEvent("routines://changed", () => void loadRoutines())
}

export async function saveRoutine(draft: RoutineDraft): Promise<Routine | null> {
  try {
    const saved = await call<Routine>("routines_save", { routine: draft })
    await loadRoutines()
    return saved
  } catch (e) {
    notify.error("No se pudo guardar la rutina", errorMessage(e))
    return null
  }
}

export async function deleteRoutine(id: string): Promise<void> {
  await call("routines_delete", { id })
  await loadRoutines()
}

export function openRoutine(id: string): void {
  openEditor({ kind: "routine", id })
}

export async function confirmDeleteRoutine(routine: Routine): Promise<void> {
  if (!(await confirmAction("Eliminar rutina", `"${routine.name}" deja de correr y se borra su historial.`, "Eliminar", true))) return
  await deleteRoutine(routine.id)
  const id = tabId({ kind: "routine", id: routine.id })
  removeTabs((t) => t.id === id)
}

export async function setRoutineEnabled(id: string, enabled: boolean): Promise<void> {
  await call("routines_set_enabled", { id, enabled })
  await loadRoutines()
}

export async function runRoutineNow(id: string): Promise<void> {
  try {
    await call("routines_run_now", { id })
    notify.info("Rutina en marcha", "Te aviso cuando termine.")
  } catch (e) {
    notify.error("No se pudo correr la rutina", errorMessage(e))
  }
}
