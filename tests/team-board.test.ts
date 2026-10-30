import { test } from "node:test"
import assert from "node:assert/strict"
import { boardColumn, movableTask, projectBoard, taskVerified } from "../src/team/board.ts"
import type { TeamRun, TeamTask } from "../src/team/types.ts"

const task = (id: string): TeamTask => ({ id, title: id, objective: "Entrega comprobable", assignedAgentId: "lead", repository: "D:/repo", dependencies: [], expectedFiles: ["src/main.ts"], writePaths: ["src/"], acceptanceCriteria: ["El test negativo rechaza entradas inválidas"], status: "pending", attempts: [], error: null, verificationPlan: [{ kind: "command", command: "node --test", expected: "exitCode=0" }] })
const run = (): TeamRun => ({ id: "r", goal: "goal", team: { id: "t", name: "t", projectRoot: "D:/repo", allowedRepositories: ["D:/repo"], leadAgentId: "lead", members: [{ id: "lead", name: "Lead", role: "Lead", model: { providerID: "p", modelID: "m" }, variant: null, tools: [], instructions: "", skillRefs: [], maxConcurrentTasks: 1 }], maxParallelTasks: 2, maxRetriesPerTask: 1, updatedAt: 0 }, skills: [], status: "running", startedAt: 1, finishedAt: null, planSessionId: null, tasks: [task("a"), task("b")], summary: "", error: null, evidenceDir: "", artifacts: [], notified: false, planV2: { enabled: true, reviewBeforeStart: false, stage: "validated", revisionNumber: 1, digest: "digest", sequence: 1, revisions: [], validation: { valid: true, issues: [] }, discovery: [] } })

function completed(r: TeamRun, t: TeamTask) {
  t.status = "completed"
  t.attempts = [{ id: "attempt", agent: r.team.members[0], sessionId: "observed-session", reviewSessionId: "review", startedAt: 1, finishedAt: 2, status: "completed", summary: "Terminé", error: null, review: { status: "approved", criteriaSatisfied: true, summary: "Criterios comprobados" }, declaredChecks: ["node --test"], commands: [{ command: "node --test", exitCode: 0, output: "passed" }] }]
}

test("un reporte de terminado sin sesión, test y revisión observados nunca se presenta como verificado", () => {
  const r = run(), t = r.tasks[0]
  assert.equal(boardColumn(r, t), "ready")
  t.status = "running"
  assert.equal(boardColumn(r, t), "reconciling")
  t.status = "completed"
  assert.equal(boardColumn(r, t), "verifying")
  completed(r, t)
  assert.equal(boardColumn(r, t), "verified")
  t.attempts[0].reviewSessionId = null
  assert.equal(boardColumn(r, t), "verifying")
  t.attempts[0].reviewSessionId = "review"
  t.attempts[0].commands[0].exitCode = 1
  assert.equal(taskVerified(t), false)
  assert.equal(boardColumn(r, t), "verifying")
  t.status = "blocked"; t.attempts[0].review!.status = "changes_requested"
  assert.equal(boardColumn(r, t), "needs_changes")
})

test("una sesión observada mueve la tarjeta una vez y un snapshot reconstruye la misma proyección", () => {
  const r = run(), t = r.tasks[0]
  completed(r, t); t.status = "running"; t.attempts[0].finishedAt = null; t.attempts[0].status = "running"; t.attempts[0].review = null
  assert.equal(boardColumn(r, t), "running")
  assert.deepEqual(projectBoard(structuredClone(r)), projectBoard(r))
  assert.equal(projectBoard(r).filter(c => c.task.id === t.id).length, 1)
  r.status = "blocked"
  assert.equal(boardColumn(r, t), "reconciling")
})

test("los dependientes esperan evidencia y el arrastre no modifica tareas con intentos ni concede aprobación", () => {
  const r = run()
  r.tasks[1].dependencies = ["a"]
  assert.equal(boardColumn(r, r.tasks[1]), "todo")
  r.tasks[0].status = "completed"
  assert.equal(boardColumn(r, r.tasks[1]), "todo")
  completed(r, r.tasks[0])
  assert.equal(boardColumn(r, r.tasks[1]), "ready")
  assert.equal(movableTask(r, r.tasks[1]), true)
  assert.equal(movableTask(r, r.tasks[0]), false)
  r.tasks[1].status = "cancelled"
  assert.equal(boardColumn(r, r.tasks[1]), "cancelled")
  assert.equal(movableTask(r, r.tasks[1]), false)
})

test("cien tarjetas conservan identidad y prioridad sin generar actividad o sesiones", () => {
  const r = run()
  r.tasks = Array.from({ length: 100 }, (_, i) => ({ ...task(`t${i}`), priority: i }))
  const before = structuredClone(r)
  const cards = projectBoard(r)
  assert.equal(cards.length, 100)
  assert.equal(cards[0].task.id, "t99")
  assert.equal(new Set(cards.map(c => c.task.id)).size, 100)
  assert.deepEqual(r, before)
  assert(cards.every(c => !c.attempt))
})
