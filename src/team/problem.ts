import type { TeamRun, TeamTask } from "./types"
import type { TeamAttention } from "./attention.ts"
import { readableTeamError } from "../lib/provider-error.ts"
import { firstTeamSentence } from "../lib/team-response.ts"

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
  const coordination = run.coordination?.findLast(c => c.status === "blocked" || c.status === "checking" && ["blocked", "failed"].includes(run.status))
  if (coordination) {
    const lead = run.team.members.find(m => m.id === run.team.leadAgentId)?.name ?? "Lead"
    const task = run.tasks.find(t => t.id === coordination.fromTaskId)
    const worker = run.team.members.find(m => m.id === task?.assignedAgentId)?.name ?? "un integrante"
    return `${lead} se frenó al ayudar a ${worker}: ${readableTeamError(coordination.summary || run.error)}`
  }
  const task = run.tasks.find(t => ["blocked", "failed", "changes_requested", "review_error", "interrupted"].includes(t.status))
  if (task) {
    const responsible = task.attempts.at(-1)?.review?.status === "review_error" ? run.team.leadAgentId : task.assignedAgentId
    const name = run.team.members.find(m => m.id === responsible)?.name ?? "Un integrante"
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

export function problemHelp(item: TeamAttention): { text: string; model?: boolean } {
  const reason = item.reason.toLowerCase()
  if (item.kind === "permission") return { text: "Abrí el permiso de este agente y revisá la acción que pide autorizar. El equipo espera esa decisión." }
  if (item.kind === "question") return { text: "Abrí la pregunta de este agente y respondela. Esa respuesta le permite continuar." }
  if (item.kind === "waiting") return { text: "Esta espera la coordina el Lead. Consultá su estado; no hace falta repetir la tarea de este integrante." }
  if (/saldo|facturación|requisito de pago/.test(reason)) return { text: "Revisá el saldo o la facturación de esa cuenta, o elegí otro modelo con acceso disponible. Después continuá lo pendiente; reintentar por sí solo no resuelve el requisito de pago.", model: true }
  if (/límite de uso|límite de la cuenta|cuota/.test(reason)) return { text: "Esperá a que se renueve el límite o elegí un modelo con acceso disponible en Configuración. Después continuá lo pendiente; reintentar por sí solo no cambia el límite.", model: true }
  if (/cuenta|modelo.*(disponible|restringido)|reconect|variante/.test(reason)) return { text: "Revisá la conexión de esa cuenta o cambiá el modelo en Configuración. Después continuá lo pendiente.", model: true }
  if (/permiso|autorización|control.*apagado|ventana.*(navegador|elegida)/.test(reason)) return { text: "Revisá en Actividad qué acceso falta y habilitá solo lo que corresponda al pedido. Después pedile al Lead que continúe." }
  if (/conexión|inactiva|no respondió|motor|tiempo|minutos/.test(reason)) return { text: "Revisá la última actividad de esa sesión y la conexión del motor. Al continuar, el equipo comprobará lo ya ejecutado antes de retomar; tus cambios se conservan." }
  return { text: "Preguntale al Lead por este bloqueo o dale el dato que falta. Podés continuar lo pendiente para que revise el estado guardado y retome las tareas sin empezar de cero." }
}

export function problemBrief(item: TeamAttention, run?: TeamRun) {
  const short = (text: string, limit: number) => {
    const flat = text.replace(/\s+/g, " ").trim().replace(/[.!]$/, "")
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).replace(/\s+\S*$/, "")}…`
  }
  const tasks = run?.tasks.filter(t => t.assignedAgentId === item.agentId) ?? []
  const work = tasks.length ? tasks.slice(0, 2).map(t => short(t.title, 48)).join("; ") + (tasks.length > 2 ? ` y ${tasks.length - 2} más` : "")
    : run?.team?.leadAgentId === item.agentId && item.id.startsWith("coordination-") ? "Coordinar el equipo" : short(item.task, 90)
  const help = problemHelp(item)
  const reason = readableTeamError(item.reason)
  const payment = /saldo|facturación|requisito de pago/i.test(reason)
  const quota = /límite de uso|límite de la cuenta|cuota/i.test(reason)
  const because = payment ? "La cuenta necesita saldo o revisar su facturación" : quota ? "La cuenta llegó a su límite de uso" : short(firstTeamSentence(reason), 125)
  const next = item.kind === "permission" ? "Revisá el permiso que te pedí."
    : item.kind === "question" ? "Respondé la pregunta de mi sesión."
    : item.kind === "waiting" ? "El Lead está a cargo de coordinar esta espera."
    : payment ? "Revisá el saldo o elegí otro modelo con acceso."
    : quota ? "Cambiá el modelo o esperá a que se renueve el límite."
    : help.model ? "Revisá la cuenta o elegí otro modelo."
    : /conexión/.test(reason) ? "Revisá la conexión y pedime que continúe."
    : /prueba|verificación|comprobación/.test(reason) ? "Pedime que repita la prueba pendiente."
    : "Preguntame qué falta o pedime que continúe."
  return { work, blocked: short(item.task, 80), because, next }
}
