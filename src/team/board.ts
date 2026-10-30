import type { TeamRun, TeamTask } from "./types.ts"

export type BoardColumn = "todo" | "ready" | "running" | "verifying" | "verified" | "blocked" | "needs_changes" | "cancelled" | "reconciling"
export const boardColumns: { id: BoardColumn; label: string; icon: string }[] = [
  { id: "todo", label: "Por hacer", icon: "list-unordered" },
  { id: "ready", label: "Listas", icon: "circle-outline" },
  { id: "running", label: "En curso", icon: "play" },
  { id: "verifying", label: "Verificando", icon: "search" },
  { id: "verified", label: "Verificadas", icon: "check" },
  { id: "blocked", label: "Bloqueadas", icon: "lock" },
  { id: "needs_changes", label: "Necesitan corrección", icon: "warning" },
  { id: "reconciling", label: "Reconciliando", icon: "sync" },
  { id: "cancelled", label: "Canceladas", icon: "circle-slash" },
]

export function taskVerified(task: TeamTask): boolean {
  const attempt = task.attempts.at(-1)
  if (task.status !== "completed" || !attempt?.sessionId || !attempt.reviewSessionId || !attempt.finishedAt || attempt.status !== "completed"
    || attempt.review?.status !== "approved" || !attempt.review.criteriaSatisfied) return false
  const observedChecks = !!attempt.declaredChecks?.length && attempt.declaredChecks.every(check => attempt.commands.some(c => c.command === check && c.exitCode === 0))
  const observedUi = !task.expectedFiles.length && !attempt.declaredChecks?.length && !!attempt.observations?.length
  const planned = !task.verificationPlan?.length || task.verificationPlan.every(step => step.kind === "command"
    ? attempt.commands.some(c => c.command === step.command && c.exitCode === 0)
    : !task.expectedFiles.length && !!attempt.observations?.length)
  return (observedChecks || observedUi) && planned
}

export function boardColumn(run: TeamRun, task: TeamTask): BoardColumn {
  const attempt = task.attempts.at(-1)
  if (task.status === "cancelled") return "cancelled"
  if (attempt?.status === "waiting_model") return "blocked"
  if (task.status === "completed") return taskVerified(task) ? "verified" : "verifying"
  if (["changes_requested", "failed"].includes(task.status) || attempt?.review?.status === "changes_requested") return "needs_changes"
  if (["blocked", "waiting_dependency", "review_error"].includes(task.status)) return "blocked"
  if (task.status === "interrupted" || run.status === "blocked" && attempt?.finishedAt == null && attempt?.sessionId) return "reconciling"
  if (task.status === "verifying") return "verifying"
  if (task.status === "running") return attempt?.id && attempt.sessionId ? "running" : "reconciling"
  if (task.status === "pending") return task.dependencies.every(id => {
    const dependency = run.tasks.find(t => t.id === id)
    // Group completion is derived by the scheduler from all children.
    return dependency?.taskKind === "group" ? dependency.status === "completed" : !!dependency && taskVerified(dependency)
  }) ? "ready" : "todo"
  return "reconciling"
}

export function movableTask(run: TeamRun, task: TeamTask): boolean {
  return !!run.planV2?.enabled && !!run.planV2.revisionNumber && ["running", "paused", "blocked", "plan_ready"].includes(run.status)
    && task.status === "pending" && task.attempts.length === 0 && task.taskKind !== "group"
}

export function projectBoard(run: TeamRun) {
  return run.tasks.filter(t => t.taskKind !== "group").map(task => ({
    task, column: boardColumn(run, task), agent: run.team.members.find(a => a.id === task.assignedAgentId),
    attempt: task.attempts.at(-1), sequence: run.planV2?.sequence ?? 0, revision: run.planV2?.revisionNumber ?? 0,
  })).sort((a,b) => (b.task.priority ?? 0) - (a.task.priority ?? 0))
}
