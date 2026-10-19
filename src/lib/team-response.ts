type RecordValue = Record<string, unknown>
export type TeamResponse = {
  title: string
  summary: string
  tasks: { title: string; objective: string }[]
  checks: string[]
  limitations: string[]
  request?: string
}

const labels: Record<string, string> = {
  approved: "Revisión aprobada", changes_requested: "Hay correcciones pendientes", review_error: "No se pudo completar la revisión",
  completed: "Trabajo informado por el agente", blocked: "El agente necesita ayuda para continuar", failed: "La tarea no pudo completarse",
  waiting_dependency: "El agente necesita una entrega de otro integrante", resume: "El agente puede continuar", wait: "Esperando otra entrega",
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) : []

export function readableTeamSummary(text: string): string {
  if (text.length < 500 || /\n/.test(text)) return text
  const paragraphs: string[] = []
  for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/u)) {
    if (!paragraphs.length || paragraphs.at(-1)!.length + sentence.length > 450) paragraphs.push(sentence)
    else paragraphs[paragraphs.length - 1] += ` ${sentence}`
  }
  return paragraphs.join("\n\n")
}

// Only use this decoder in sessions created by the team runner. Ordinary JSON
// answers and the original engine history must remain untouched.
export function decodeTeamResponse(text: string): TeamResponse | null {
  let value: RecordValue
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```$/, ""))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    value = parsed
  } catch { return null }
  const tasks = Array.isArray(value.tasks) ? value.tasks.filter((v): v is RecordValue => !!v && typeof v === "object" && typeof v.title === "string" && typeof v.objective === "string").map(v => ({ title: v.title as string, objective: v.objective as string })) : []
  const status = typeof value.status === "string" ? value.status : ""
  if ((!labels[status] || typeof value.summary !== "string") && !(Array.isArray(value.tasks) && !status)) return null
  const limitations = strings(value.limitations)
  if (status === "approved" && value.criteriaSatisfied !== true) limitations.unshift("El Lead no confirmó que se cumplan todos los criterios. Esta respuesta no acredita una aprobación.")
  return {
    title: status === "approved" && value.criteriaSatisfied !== true ? "Revisión sin aprobación confirmada" : labels[status] ?? "Plan de trabajo del equipo",
    summary: readableTeamSummary(typeof value.summary === "string" ? value.summary : "El Lead organizó estas tareas para el equipo."),
    tasks, checks: strings(value.checks), limitations,
    request: value.request && typeof value.request === "object" && typeof (value.request as RecordValue).message === "string" ? (value.request as RecordValue).message as string : undefined,
  }
}
