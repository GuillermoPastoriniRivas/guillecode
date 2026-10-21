import { test } from "node:test"
import assert from "node:assert/strict"
import { attentionLabel, teamAttention } from "../src/team/attention.ts"
import { memberState } from "../src/team/member-state.ts"
import type { TeamChatRecord, TeamRun } from "../src/team/types.ts"

function fixture() {
  const members = ["lead", "frontend", "backend"].map(id => ({ id, name: id === "lead" ? "Lead" : id === "frontend" ? "Frontend" : "Backend", role: id, model: { providerID: "qa", modelID: "qa" }, variant: null, instructions: "", tools: [], skillRefs: [], maxConcurrentTasks: 1 }))
  const team = { id: "team", name: "Equipo", projectRoot: "C:/demo", allowedRepositories: ["C:/demo"], leadAgentId: "lead", members, maxParallelTasks: 2, maxRetriesPerTask: 1, updatedAt: 1 }
  const run: TeamRun = { id: "run", goal: "demo", team, skills: [], status: "running", startedAt: 1, finishedAt: null, planSessionId: "plan", tasks: members.slice(1).map(agent => ({ id: agent.id, title: `Crear ${agent.name}`, objective: "demo", assignedAgentId: agent.id, repository: "C:/demo", dependencies: [], expectedFiles: [], acceptanceCriteria: [], status: "running", error: null, attempts: [{ id: `attempt-${agent.id}`, agent, sessionId: `session-${agent.id}`, reviewSessionId: null, startedAt: 1, finishedAt: null, status: "running", summary: "", error: null, review: null, commands: [] }] })), summary: "", error: null, evidenceDir: "", artifacts: [], notified: false }
  const chat: TeamChatRecord = { id: "chat", title: "Equipo", team, skills: [], archived: false, createdAt: 1, messages: [], runs: [run] }
  return { chat, run }
}

test("la lista distingue al Lead listo, respondiendo y planificando", () => {
  const { chat, run } = fixture()
  const lead = chat.team.members[0]
  chat.runs = []
  assert.deepEqual(memberState(lead, chat, undefined, []), { label: "Listo", detail: "Esperando tu objetivo.", tone: "idle", needsHelp: false })
  chat.messages = [{ id: "reply", role: "assistant", text: "", createdAt: 2, status: "pending", runId: null, sessionId: "reply" }]
  assert.equal(memberState(lead, chat, undefined, []).label, "Respondiendo")
  chat.messages = []; chat.runs = [run]; run.status = "planning"
  assert.equal(memberState(lead, chat, run, []).label, "Planificando")
})

test("el Lead informa que está separando un ciclo sin pedir ayuda prematuramente", () => {
  const { chat, run } = fixture()
  run.coordination = [{ id: "cycle", fromTaskId: "frontend", message: "Falta contrato", taskIds: ["backend"], cycleTaskIds: ["frontend", "backend"], status: "checking", summary: "Detecté una espera circular. Estoy separando el contrato de la integración.", createdAt: 2, sessions: ["coordination"] }]
  const lead = memberState(run.team.members[0], chat, run, teamAttention(chat, run))
  assert.equal(lead.label, "Destrabando equipo")
  assert.match(lead.detail, /espera circular/)
  assert.equal(lead.needsHelp, false)
})

test("un fallo técnico se deriva al Lead y no se presenta como ayuda humana", () => {
  const { chat, run } = fixture()
  run.tasks[0].status = "waiting_dependency"
  run.coordination = [{ id: "help", kind: "technical_blocker", fromTaskId: "frontend", message: "Falta ejecutar una comprobación HTTP válida", taskIds: [], status: "pending", summary: "", createdAt: 2, sessions: [] }]
  const items = teamAttention(chat, run)
  assert.equal(items[0].kind, "waiting")
  assert.match(items[0].reason, /Pidió ayuda al Lead/)
  assert.equal(memberState(run.team.members[0], chat, run, items).label, "Resolviendo bloqueos")
  assert.equal(memberState(run.team.members[1], chat, run, items).label, "Esperando al Lead")
  assert.equal(memberState(run.team.members[1], chat, run, items).needsHelp, false)
  assert.equal(memberState(run.team.members[2], chat, run, items).label, "Trabajando")
  run.coordination[0].status = "blocked"; run.coordination[0].summary = "Necesito acceso a la cuenta de prueba"; run.tasks[0].status = "blocked"; run.tasks[0].error = run.coordination[0].summary
  assert.equal(memberState(run.team.members[1], chat, run, teamAttention(chat, run)).needsHelp, true)
})

test("cada integrante conserva su estado cuando otro necesita ayuda, incluso con nombres iguales", () => {
  const { chat, run } = fixture()
  const [lead, front, back] = run.team.members
  front.name = back.name = "Especialista"
  run.tasks[0].status = "blocked"; run.tasks[0].error = "Falta configurar la API local."
  let attention = teamAttention(chat, run)
  assert.equal(memberState(front, chat, run, attention).needsHelp, true)
  assert.match(memberState(front, chat, run, attention).detail, /API local/)
  assert.equal(memberState(back, chat, run, attention).label, "Trabajando")
  assert.equal(memberState(back, chat, run, attention).needsHelp, false)
  run.tasks[0].status = "running"
  attention = teamAttention(chat, run, [{ sessionID: "session-frontend", kind: "permission" }])
  assert.equal(memberState(front, chat, run, attention).label, "Espera un permiso")
  assert.equal(memberState(back, chat, run, attention).label, "Trabajando")
  assert.equal(memberState(front, chat, run, teamAttention(chat, run)).needsHelp, false)
  run.tasks[1].attempts[0].reviewSessionId = "review"
  attention = teamAttention(chat, run, [{ sessionID: "review", kind: "question" }])
  assert.equal(memberState(lead, chat, run, attention).label, "Espera tu respuesta")
  assert.equal(memberState(back, chat, run, attention).needsHelp, false)
})

test("las dependencias y revisiones no piden ayuda al usuario salvo al fallar la revisión del Lead", () => {
  const { chat, run } = fixture()
  const [lead, front] = run.team.members
  run.tasks[0].status = "waiting_dependency"
  assert.equal(memberState(front, chat, run, teamAttention(chat, run)).needsHelp, false)
  run.tasks[0].status = "verifying"
  assert.equal(memberState(front, chat, run, []).label, "Esperando revisión")
  assert.equal(memberState(lead, chat, run, []).label, "Revisando")
  run.tasks[0].status = "review_error"
  run.tasks[0].attempts[0].review = { status: "review_error", summary: "El modelo de revisión no está disponible.", criteriaSatisfied: false }
  const attention = teamAttention(chat, run)
  assert.equal(memberState(lead, chat, run, attention).needsHelp, true)
  assert.equal(memberState(front, chat, run, attention).needsHelp, false)
  run.status = "cancelled"
  assert.equal(memberState(lead, chat, run, teamAttention(chat, run)).label, "Cancelado")
  run.status = "awaiting_manual_qa"
  assert.equal(memberState(lead, chat, run, teamAttention(chat, run)).label, "Espera tu revisión")
  run.status = "qa_approved"
  assert.equal(memberState(lead, chat, run, teamAttention(chat, run)).needsHelp, false)
})

test("un integrante bloqueado se ve aunque el equipo siga trabajando y no tenga error general", () => {
  const { chat, run } = fixture()
  run.tasks[0].status = "blocked"
  run.tasks[0].error = JSON.stringify({ data: { message: "The usage limit has been reached", responseHeaders: { cookie: "PRIVATE" } } })
  const items = teamAttention(chat, run)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, "Frontend")
  assert.match(items[0].reason, /límite de uso/)
  assert.doesNotMatch(items[0].reason, /PRIVATE|responseHeaders/)
  assert.equal(items[0].sessionId, "session-frontend")
  assert.equal(attentionLabel(items), "1 bloqueo")
  run.tasks[0].status = "running"
  assert.deepEqual(teamAttention(chat, run), [])
})

test("esperar una entrega se diferencia de un fallo y desaparece al resolverla", () => {
  const { chat, run } = fixture()
  run.tasks[0].status = "waiting_dependency"
  run.coordination = [{ id: "request", fromTaskId: "frontend", message: "Necesito el contrato de la API.", taskIds: ["backend"], status: "waiting", summary: "", createdAt: 2, sessions: ["coordination"] }]
  const items = teamAttention(chat, run)
  assert.equal(items[0].kind, "waiting")
  assert.match(items[0].reason, /entrega de Backend.*contrato de la API/)
  assert.equal(attentionLabel(items), "1 en espera")
  run.tasks[0].status = "pending"
  run.coordination[0].status = "resolved"
  assert.deepEqual(teamAttention(chat, run), [])
})

test("los permisos y preguntas muestran al responsable real y excluyen otros chats", () => {
  const { chat, run } = fixture()
  run.tasks[1].attempts[0].reviewSessionId = "review-backend"
  const items = teamAttention(chat, run, [{ sessionID: "session-frontend", kind: "permission" }, { sessionID: "review-backend", kind: "question" }, { sessionID: "foreign", kind: "permission" }])
  assert.deepEqual(items.map(i => [i.name, i.kind]), [["Frontend", "permission"], ["Lead", "question"]])
  assert.match(items[0].reason, /autorización/)
  assert.equal(attentionLabel(items), "2 bloqueos")
  assert.deepEqual(teamAttention(chat, run), [])
})

test("no atribuye esperas normales, trabajo terminado ni cancelaciones a un bloqueo", () => {
  const { chat, run } = fixture()
  run.tasks[0].status = "completed"
  run.tasks[0].error = "Un error antiguo"
  run.tasks[1].status = "pending"
  run.tasks[1].dependencies = ["frontend"]
  assert.deepEqual(teamAttention(chat, run, [{ sessionID: "session-frontend", kind: "permission" }]), [])
  run.tasks[1].status = "blocked"
  run.status = "cancelled"
  assert.deepEqual(teamAttention(chat, run), [])
})

test("el Lead puede necesitar ayuda antes de planificar y se ve su permiso pendiente", () => {
  const { chat } = fixture()
  chat.runs = []
  chat.messages = [{ id: "reply", role: "assistant", text: "El modelo no está disponible. Elegí otro modelo.", createdAt: 2, status: "error", runId: null, sessionId: "lead-chat" }]
  assert.equal(teamAttention(chat, undefined)[0].name, "Lead")
  chat.messages.push({ id: "diagnosis", role: "assistant", text: "El último pedido falló antes de organizar tareas.", createdAt: 3, status: "complete", runId: null, sessionId: null })
  assert.equal(teamAttention(chat, undefined).length, 1, "answering a status question must not hide the unresolved failure")
  chat.messages[0].status = "pending"
  const items = teamAttention(chat, undefined, [{ sessionID: "lead-chat", kind: "permission" }])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "permission")
  assert.equal(items[0].sessionId, "lead-chat")
})
