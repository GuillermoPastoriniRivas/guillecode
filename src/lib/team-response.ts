type RecordValue = Record<string, unknown>
export type ChatSummary = { done: string; tested: string; pending: string }
export type TeamResponse = {
  title: string
  summary: string
  tasks: { title: string; objective: string }[]
  checks: string[]
  limitations: string[]
  request?: string
  findings?: string[]
  criteria?: { requirement: string; status: string; evidence: string }[]
  chatSummary: ChatSummary
}

const labels: Record<string, string> = {
  approved: "Revisión aprobada", changes_requested: "Hay correcciones pendientes", review_error: "No se pudo completar la revisión",
  completed: "Trabajo informado por el agente", blocked: "El agente necesita ayuda para continuar", failed: "La tarea no pudo completarse",
  waiting_dependency: "El agente necesita una entrega de otro integrante", resume: "El agente puede continuar", wait: "Esperando otra entrega",
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) : []

const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length <= 200 ? line : `${line.slice(0, 197).replace(/\s+\S*$/, "")}…`
}

// A missing brief in older runs must never turn into invented test results.
export function compactTeamReply(value: unknown, fallback: ChatSummary): ChatSummary {
  const record = value && typeof value === "object" ? value as RecordValue : {}
  return Object.fromEntries(Object.entries(fallback).map(([key, text]) => [key, short(typeof record[key] === "string" && record[key].trim() ? record[key] as string : text)])) as ChatSummary
}

export function firstTeamSentence(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/u)
  const first = sentences[0] ?? ""
  return short(/^(terminamos|listo|completado|trabajo completado)[.!]?$/i.test(first.trim()) && sentences[1] ? `${first} ${sentences[1]}` : first)
}

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
  if (typeof value.summary === "string" && !value.status && Array.isArray(value.findings) && typeof value.nextStep === "string") {
    return {title:"Informe del Solucionador",summary:readableTeamSummary(value.summary),tasks:[],checks:[],limitations:[],findings:strings(value.findings),request:value.nextStep,chatSummary:{done:firstTeamSentence(value.summary),tested:"Los hechos y las fuentes de la investigación están en los detalles.",pending:short(`Propuesta al Lead: ${value.nextStep}`)}}
  }
  if (typeof value.summary === "string" && !value.status && Array.isArray(value.criteria) && typeof value.criteriaSatisfied === "boolean") {
    const criteria=value.criteria.filter((c):c is RecordValue=>!!c && typeof c==="object" && typeof c.requirement==="string" && typeof c.evidence==="string" && typeof c.status==="string").map(c=>({requirement:c.requirement as string,status:c.status as string,evidence:c.evidence as string}))
    const met=value.criteriaSatisfied && criteria.length>0 && criteria.length===value.criteria.length && criteria.every(c=>c.status==="met" && !!c.evidence.trim())
    return {title:"Análisis del Supervisor",summary:readableTeamSummary(value.summary),tasks:[],checks:[],criteria,limitations:criteria.filter(c=>c.status!=="met").map(c=>c.requirement),chatSummary:{done:firstTeamSentence(value.summary),tested:`Contrasté ${criteria.length} requisitos con la evidencia registrada en los detalles.`,pending:met?"Informe enviado al Lead para su revisión final.":"El Lead debe resolver los requisitos faltantes o sin verificar antes de cerrar."}}
  }
  const tasks = Array.isArray(value.tasks) ? value.tasks.filter((v): v is RecordValue => !!v && typeof v === "object" && typeof v.title === "string" && typeof v.objective === "string").map(v => ({ title: v.title as string, objective: v.objective as string })) : []
  const status = typeof value.status === "string" ? value.status : ""
  const label = Object.hasOwn(labels, status) ? labels[status] : undefined
  if ((!label || typeof value.summary !== "string") && !(Array.isArray(value.tasks) && !status)) return null
  const limitations = strings(value.limitations)
  if (status === "approved" && value.criteriaSatisfied !== true) limitations.unshift("El Lead no confirmó que se cumplan todos los criterios. Esta respuesta no acredita una aprobación.")
  const chatSummary = compactTeamReply(value.chatSummary, {
    done: !status ? `Organicé ${tasks.length} tareas para el equipo.` : firstTeamSentence(value.summary as string),
    tested: "Las comprobaciones informadas están en los detalles; esta respuesta por sí sola no las confirma.",
    pending: limitations.length ? limitations[0] : value.request ? "El agente necesita una respuesta del Lead." : status === "approved" && value.criteriaSatisfied === true ? "Revisá la entrega y el QA pendiente en el chat del equipo." : "Consultá el estado del equipo antes de dar el trabajo por terminado.",
  })
  // Structural warnings take precedence over a model's optimistic short reply.
  if (limitations.length) chatSummary.pending = short(limitations[0])
  if (value.request) chatSummary.pending = short(typeof (value.request as RecordValue).message === "string" ? (value.request as RecordValue).message as string : chatSummary.pending)
  return {
    title: status === "approved" && value.criteriaSatisfied !== true ? "Revisión sin aprobación confirmada" : label ?? "Plan de trabajo del equipo",
    summary: readableTeamSummary(typeof value.summary === "string" ? value.summary : "El Lead organizó estas tareas para el equipo."),
    tasks, checks: strings(value.checks), limitations, chatSummary,
    request: value.request && typeof value.request === "object" && typeof (value.request as RecordValue).message === "string" ? (value.request as RecordValue).message as string : undefined,
  }
}
