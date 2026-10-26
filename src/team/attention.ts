import type { TeamChatRecord, TeamRun } from "./types.ts"
import { readableTeamError } from "../lib/provider-error.ts"
import { taskProblem } from "./problem.ts"

export type WaitingRequest = { sessionID: string; kind: "permission" | "question"; detail?: string }
export type TeamAttention = { id: string; agentId: string | null; name: string; task: string; kind: "blocked" | "waiting" | "permission" | "question"; reason: string; sessionId: string | null; directory: string }

export function teamAttention(chat: TeamChatRecord, run: TeamRun | undefined, requests: WaitingRequest[] = []): TeamAttention[] {
  const items: TeamAttention[] = []
  const sessions = new Map<string, Pick<TeamAttention, "agentId" | "name" | "task" | "directory">>()
  const leadId = run?.team.leadAgentId ?? chat.team.leadAgentId
  const lead = run?.team.members.find(m => m.id === run.team.leadAgentId)?.name ?? "Lead"
  const addSession = (session: string | null | undefined, name: string, task: string, directory: string, agentId: string = leadId) => {
    if (session) sessions.set(session, { agentId, name, task, directory })
  }
  if (run && !["completed", "cancelled", "cancelling", "awaiting_manual_qa", "qa_approved"].includes(run.status)) {
    const root = run.team.allowedRepositories[0] ?? run.team.projectRoot
    addSession(run.planSessionId, lead, "Organizar el equipo", root)
    for (const session of run.closingSessions ?? []) addSession(session, lead, "Revisión final", root)
    for (const task of run.tasks) {
      if (["completed", "cancelled"].includes(task.status)) continue
      const attempt = task.attempts.at(-1)
      const name = attempt?.agent.name ?? run.team.members.find(m => m.id === task.assignedAgentId)?.name ?? "Un integrante"
      addSession(attempt?.sessionId, name, task.title, task.repository, task.assignedAgentId)
      addSession(attempt?.reviewSessionId, lead, `Revisar ${task.title}`, task.repository)
      const coordination = run.coordination?.findLast(c => c.fromTaskId === task.id && !["resolved", "cancelled"].includes(c.status))
      for (const session of coordination?.sessions ?? []) addSession(session, lead, `Ayudar a ${name}`, task.repository)
      if (coordination && (coordination.status === "blocked" || coordination.status === "checking" && ["blocked", "failed"].includes(run.status))) {
        items.push({ id: `coordination-${coordination.id}`, agentId: leadId, name: lead, task: `Destrabar a ${name} · ${task.title}`, kind: "blocked",
          reason: readableTeamError(coordination.summary || run.error || "El Lead no pudo terminar de revisar el pedido de este integrante."),
          sessionId: coordination.sessions.at(-1) ?? null, directory: task.repository })
        items.push({ id: task.id, agentId: task.assignedAgentId, name, task: task.title, kind: "waiting",
          reason: `Espera instrucciones del Lead. El problema está en la coordinación; su trabajo ya guardado se conserva.`, sessionId: attempt?.sessionId ?? null, directory: task.repository })
      } else if (["blocked", "failed", "review_error", "interrupted"].includes(task.status)) {
        const reviewFailed = attempt?.review?.status === "review_error"
        items.push({ id: task.id, agentId: reviewFailed ? leadId : task.assignedAgentId, name: reviewFailed ? lead : name, task: task.title, kind: "blocked",
          reason: task.error || attempt?.error || attempt?.review ? taskProblem(task) : "No quedó registrada la causa. Revisá su último paso en Actividad para poder ayudarlo.",
          sessionId: (reviewFailed ? attempt?.reviewSessionId : attempt?.sessionId) ?? null, directory: task.repository })
      } else if (task.status === "waiting_dependency") {
        const dependencies = (coordination?.taskIds ?? []).map(id => run.tasks.find(t => t.id === id)).filter(t => t && t.status !== "completed")
        const names = [...new Set(dependencies.map(t => run.team.members.find(m => m.id === t!.assignedAgentId)?.name ?? t!.title))]
        const context = coordination?.kind === "technical_blocker" ? "Pidió ayuda al Lead, que está buscando una solución." : names.length ? `Espera una entrega de ${names.join(", ")}.` : coordination?.status === "checking" ? "El Lead está revisando su pedido." : "Espera una respuesta del Lead."
        items.push({ id: task.id, agentId: task.assignedAgentId, name, task: task.title, kind: "waiting", reason: `${context}${coordination?.message ? ` ${readableTeamError(coordination.message)}` : ""}`,
          sessionId: attempt?.sessionId ?? null, directory: task.repository })
      }
    }
    if (!items.some(i => i.kind === "blocked") && ["blocked", "failed"].includes(run.status)) {
      const coordinationSession = run.coordination?.findLast(c => ["blocked", "checking"].includes(c.status))?.sessions.at(-1)
      items.push({ id: "lead", agentId: leadId, name: lead, task: run.tasks.length ? "Continuar la ejecución" : "Organizar el equipo", kind: "blocked",
        reason: run.error ? readableTeamError(run.error) : "La ejecución se detuvo sin registrar una causa. Revisá la actividad del Lead.",
        sessionId: coordinationSession ?? run.closingSessions?.at(-1) ?? run.planSessionId, directory: root })
    }
    // Older engines expose a waiting permission in run.error before its live
    // request arrives. Keep this visible while the run is still working.
    if (run.error && !["blocked", "failed"].includes(run.status) && /espera un permiso/i.test(run.error)) {
      const owner = run.team.members.find(m => m.name && run.error!.includes(m.name))
      items.push({ id: "permission-pending", agentId: owner?.id ?? null, name: owner?.name ?? "Un integrante", task: "Permiso pendiente", kind: "permission", reason: readableTeamError(run.error), sessionId: null, directory: root })
    }
  }
  const latestRun = chat.runs.at(-1)
  if (!run || run.id === latestRun?.id) {
    const messages = chat.messages ?? []
    for (const message of messages.filter(m => m.role === "assistant" && m.status === "pending")) {
      addSession(message.sessionId, "Lead", "Responder tu mensaje", chat.team.projectRoot)
    }
    const lastFailure = messages.findLast(m => m.role === "assistant" && ["error", "interrupted"].includes(m.status))
    // Answering "what failed?" is not evidence that the failed goal resumed.
    // A newer run (or its final delivery/cancellation) supersedes old failures.
    if (lastFailure && !messages.some(m => m.status === "pending")
      && (!run || lastFailure.createdAt >= (run.finishedAt ?? run.startedAt))) {
      items.push({ id: lastFailure.id, agentId: leadId, name: "Lead", task: "Responder tu mensaje", kind: "blocked", reason: readableTeamError(lastFailure.text), sessionId: lastFailure.sessionId, directory: chat.team.projectRoot })
    }
  }
  for (const request of requests) {
    const owner = sessions.get(request.sessionID)
    if (!owner) continue // Never surface another chat's requests here.
    const existing = items.findIndex(i => i.sessionId === request.sessionID)
    const item: TeamAttention = { id: request.sessionID, ...owner, kind: request.kind, sessionId: request.sessionID,
      reason: request.kind === "permission" ? `Espera tu autorización para ${request.detail || "continuar"}. Abrí el permiso y revisá lo que solicita.` : request.detail ? `Necesita tu respuesta: ${request.detail}` : "Te hizo una pregunta y necesita tu respuesta para continuar." }
    if (existing >= 0) items[existing] = item
    else items.push(item)
  }
  return items.filter(i => i.id !== "permission-pending" || !items.some(other => other.kind === "permission" && other.sessionId))
}

export function attentionLabel(items: TeamAttention[]): string {
  const blocked = items.filter(i => i.kind !== "waiting").length
  const waiting = items.length - blocked
  return [blocked ? `${blocked} ${blocked === 1 ? "bloqueo" : "bloqueos"}` : "", waiting ? `${waiting} en espera` : ""].filter(Boolean).join(" · ")
}
