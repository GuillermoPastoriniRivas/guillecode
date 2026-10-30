import { taskVerified } from "../../src/team/board.ts"
import type { TeamRun } from "../../src/team/types.ts"

// This verdict must come from independent tests/review, never the agent's
// completion text. Its file is bound to an exact exported Run by SHA-256.
export type Verdict = { caseId: string; runSha256: string; evaluator: string; objectivePassed: boolean; requirements: { id: string; passed: boolean; evidence: string }[]; scopeViolations: number | null; duplicateEffects: number | null }
export function evaluate(run: TeamRun, requirements: string[], verdict: Verdict | null) {
  const atomic = run.tasks.filter(t => t.taskKind !== "group" && t.status !== "cancelled")
  const receipts = atomic.length > 0 && atomic.every(taskVerified)
  const observed = !!verdict?.evaluator && requirements.every(id => verdict.requirements.some(r => r.id === id && !!r.evidence))
  const covered = observed ? requirements.filter(id => verdict!.requirements.some(r => r.id === id && r.passed && !!r.evidence)).length : null
  return {
    objectiveVerified: observed ? receipts && verdict!.objectivePassed && covered === requirements.length && !(verdict!.scopeViolations! > 0) && !(verdict!.duplicateEffects! > 0) : null,
    coveredRequirements: covered, agreedRequirements: requirements.length,
    attempts: atomic.reduce((n, t) => n + t.attempts.length, 0), revisions: run.planV2?.revisions.length ?? null,
    routingDecisions: atomic.flatMap(t => t.attempts).filter(a => a.routing).length,
    scopeViolations: observed ? verdict!.scopeViolations : null,
    duplicateEffects: observed ? verdict!.duplicateEffects : null,
    costUsd: Object.keys(run.sessionUsage ?? {}).length > 0 && Object.values(run.sessionUsage!).every(s => typeof s.costUsd === "number") ? Object.values(run.sessionUsage!).reduce((n, s) => n + s.costUsd!, 0) : null,
  }
}
