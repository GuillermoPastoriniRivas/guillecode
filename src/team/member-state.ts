import type { Employee, TeamChatRecord, TeamRun } from "./types.ts"
import type { TeamAttention } from "./attention.ts"

type MemberState = { label: string; detail: string; needsHelp: boolean; tone: "idle" | "working" | "waiting" | "blocked" | "done" }
const state = (label: string, detail: string, tone: MemberState["tone"] = "idle", needsHelp = false): MemberState => ({ label, detail, tone, needsHelp })

export function memberState(member: Employee, chat: TeamChatRecord, run: TeamRun | undefined, attention: TeamAttention[]): MemberState {
  const own = attention.filter(item => item.agentId === member.id)
  const blocked = own.find(item => item.kind !== "waiting")
  if (blocked) return state(blocked.kind === "permission" ? "Espera un permiso" : blocked.kind === "question" ? "Espera tu respuesta" : "Bloqueado", blocked.reason, "blocked", true)
  if (own.length) return state(run?.coordination?.some(c => c.fromTaskId === own[0].id && c.kind === "technical_blocker" && ["pending", "checking", "waiting"].includes(c.status)) ? "Esperando al Lead" : "En espera", own[0].reason, "waiting")
  const isLead = member.id === (run?.team.leadAgentId ?? chat.team.leadAgentId)
  if (isLead && (!run || run.id === chat.runs.at(-1)?.id) && chat.messages?.some(m => m.role === "assistant" && m.status === "pending")) {
    return state("Respondiendo", "Está atendiendo tu mensaje.", "working")
  }
  if (!run) return state("Listo", isLead ? "Esperando tu objetivo." : "Todavía no tiene una tarea asignada.")
  if (run.status === "cancelled") return state("Cancelado", "La ejecución terminó; se conservaron los cambios.")
  if (run.status === "cancelling") return state("Deteniéndose", "Se están cerrando las sesiones de esta ejecución.", "waiting")
  if (isLead) {
    if (run.status === "planning") return state("Planificando", "Está organizando las tareas y eligiendo los especialistas.", "working")
    if (run.status === "delivering") return state("Preparando entrega", "Está guardando los resultados y sus evidencias.", "working")
    if (["completed", "awaiting_manual_qa"].includes(run.status)) return state("Espera tu revisión", "Todos terminaron el trabajo y sus pruebas. Podés decir «trabajo completado» o pedir mejoras.", "waiting")
    if (run.status === "qa_approved") return state("Completado", "La entrega fue aprobada.", "done")
    const coordination = run.coordination?.find(c => c.status === "checking") ?? run.coordination?.find(c => c.kind === "technical_blocker" && c.status === "pending")
    if (coordination?.cycleTaskIds?.length) return state("Destrabando equipo", coordination.summary || "Está separando una espera circular para que los integrantes puedan avanzar.", "working")
    if (coordination?.kind === "technical_blocker") return state("Resolviendo bloqueos", "Está revisando el problema del agente y preparando instrucciones para continuar.", "working")
    if (coordination) return state("Coordinando", "Está revisando un pedido de otro integrante.", "working")
    if (run.tasks.some(t => t.status === "verifying")) return state("Revisando", "Está comprobando las entregas de los especialistas.", "working")
  }
  const tasks = run.tasks.filter(t => t.assignedAgentId === member.id)
  const working = tasks.filter(t => t.status === "running")
  if (working.length) return state("Trabajando", working.map(t => t.title).join(" · "), "working")
  if (tasks.some(t => t.status === "verifying")) return state("Esperando revisión", "Terminó su parte; el Lead está revisando el resultado.", "waiting")
  if (tasks.some(t => t.attempts.at(-1)?.review?.status === "review_error" && t.status === "review_error")) return state("Esperando revisión", "El Lead necesita resolver un problema con la revisión de su entrega.", "waiting")
  if (tasks.length && tasks.every(t => t.status === "completed")) return state("Completado", "Terminó las tareas que tenía asignadas.", "done")
  if (run.status === "paused") return state("En pausa", "La ejecución está pausada para nuevas tareas.", "waiting")
  if (tasks.some(t => t.status === "pending" && t.dependencies.some(id => run.tasks.find(d => d.id === id)?.status !== "completed"))) {
    return state("Esperando dependencias", "Su siguiente tarea necesita una entrega de otro integrante.", "waiting")
  }
  if (tasks.some(t => t.status === "pending")) return state("En cola", "Espera un turno para comenzar su siguiente tarea.", "waiting")
  if (isLead && run.status === "running") return state("Coordinando", "Está siguiendo el trabajo del equipo.", "working")
  return state("Listo", run.status === "planning" ? "Esperando que el Lead le asigne una tarea." : "No tiene tareas en curso.")
}
