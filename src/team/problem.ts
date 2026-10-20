import type { TeamRun, TeamTask } from "./types"
import { readableTeamError } from "../lib/provider-error"
import { firstTeamSentence } from "../lib/team-response"

export function taskProblem(task: TeamTask): string {
  const last = task.attempts.at(-1)
  const error = task.error || last?.error
  if (error && !/falta una comprobación satisfactoria observada|no pudimos confirmar/i.test(error)) return readableTeamError(error)
  const missing = last?.declaredChecks?.filter(check => !last.commands.some(c => c.command === check && c.exitCode === 0)) ?? []
  if (missing.length) return `Falta registrar el resultado correcto de ${missing.length === 1 ? "una prueba que el agente dio" : `${missing.length} pruebas que el agente dio`} por aprobada${missing.length === 1 ? "" : "s"}. Hay que ejecutarla${missing.length === 1 ? "" : "s"} y revisar el resultado.`
  if (last?.review && last.review.status !== "approved") return firstTeamSentence(last.review.summary)
  if (error) return "El agente informó pruebas aprobadas, pero su ejecución satisfactoria no quedó registrada. Falta repetir esa verificación."
  return "La tarea todavía no tiene una revisión aprobada."
}

export function runProblem(run: TeamRun): string {
  const task = run.tasks.find(t => ["blocked", "failed", "changes_requested", "review_error"].includes(t.status))
  if (task) {
    const name = run.team.members.find(m => m.id === task.assignedAgentId)?.name ?? "Un integrante"
    return `${name} · ${task.title}: ${taskProblem(task)}`
  }
  return run.error ? readableTeamError(run.error) : ""
}

export function recoveryHint(run: TeamRun): string {
  const errors = [run.error, ...run.tasks.map(t => t.error)].filter(Boolean).join(" ")
  if (/usage_limit|quota|límite de uso|límite de la cuenta|falta de saldo|facturación|payment|402/i.test(errors)) {
    return "Reintentar no restablece el saldo ni el límite de la cuenta. Esperá a que se renueve o cambiá el modelo y después continuá. Las tareas terminadas se conservan."
  }
  if (/authentication|unauthorized|volver a conectarse|reconect|no está disponible|variante no disponible|free tier can only|restringido a la aplicación OpenCode/i.test(errors)) {
    return "Revisá la cuenta o cambiá el modelo antes de continuar. Las tareas terminadas se conservan."
  }
  return "Podés preguntarle al Lead qué falló o pedirle que continúe. Al continuar se revisa el estado guardado y se retoma lo pendiente; las tareas terminadas se conservan."
}
