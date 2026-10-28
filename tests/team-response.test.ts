import { test } from "node:test"
import assert from "node:assert/strict"
import { compactTeamReply, decodeTeamResponse, readableTeamSummary, firstTeamSentence } from "../src/lib/team-response.ts"

test("convierte el cierre del Lead sin perder reservas ni aprobar criterios falsos", () => {
  const result = decodeTeamResponse(JSON.stringify({ status: "approved", summary: "La integración HTTP pasó. La prueba visual sigue pendiente.", criteriaSatisfied: true, tasks: [] }))!
  assert.equal(result.title, "Revisión aprobada")
  assert.match(result.summary, /prueba visual sigue pendiente/)
  for (const criteriaSatisfied of [false, undefined]) {
    const unconfirmed = decodeTeamResponse(JSON.stringify({ status: "approved", summary: "Revisión", criteriaSatisfied }))!
    assert.match(unconfirmed.title, /sin aprobación confirmada/)
    assert.match(unconfirmed.limitations[0], /no acredita una aprobación/)
  }
})

test("separa plan, comprobaciones informadas y pedidos al Lead", () => {
  const plan = decodeTeamResponse('```json\n{"tasks":[{"title":"Crear frontend","objective":"Mostrar el saludo","assignedAgentId":"internal-id"}]}\n```')!
  assert.deepEqual(plan.tasks, [{ title: "Crear frontend", objective: "Mostrar el saludo" }])
  const worker = decodeTeamResponse(JSON.stringify({ status: "waiting_dependency", summary: "La pantalla está preparada.", checks: ["node --check app.js"], limitations: ["Falta probar la API."], request: { message: "Necesito el endpoint del backend", taskIds: ["T2"] } }))!
  assert.match(worker.title, /necesita una entrega/)
  assert.equal(worker.request, "Necesito el endpoint del backend")
  assert.deepEqual(worker.checks, ["node --check app.js"])
  assert.deepEqual(worker.limitations, ["Falta probar la API."])
  for (const invalid of ['{"status":"approved",', '{"message":"JSON normal"}', '{"status":"unknown","summary":"x"}', '{"status":"__proto__","summary":"x"}', '{"status":"constructor","summary":"x"}', '[]', 'null']) assert.equal(decodeTeamResponse(invalid), null)
})

test("divide párrafos largos conservando exactamente las palabras de la revisión", () => {
  const summary = "El backend responde correctamente. La integración pasó y se conservó el perfil. ".repeat(12).trim()
  const formatted = readableTeamSummary(summary)
  assert.ok(formatted.includes("\n\n"))
  assert.equal(formatted.replace(/\s+/g, " "), summary)
})

test("el resumen breve conserva pendientes y no inventa pruebas en el historial anterior", () => {
  const brief = { done: "Creé el saludo y su API.", tested: "La integración pasó.", pending: "Nada pendiente." }
  const result = decodeTeamResponse(JSON.stringify({ status: "approved", criteriaSatisfied: false, summary: "Informe largo", chatSummary: brief }))!
  assert.equal(result.chatSummary.done, brief.done)
  assert.match(result.chatSummary.pending, /no confirmó/)
  const old = decodeTeamResponse('{"status":"completed","summary":"Terminé."}')!
  assert.match(old.chatSummary.tested, /por sí sola no las confirma/)
  const capped = compactTeamReply({ done: "dato ".repeat(300), tested: null }, brief)
  assert.ok(capped.done.length <= 200)
  assert.equal(capped.tested, brief.tested)
})

test("a generic completion opener retains the concrete result sentence",()=>{
  assert.equal(firstTeamSentence("Terminamos. Implementé la pantalla y la API. Detalles largos."),"Terminamos. Implementé la pantalla y la API.")
})

test("informes de Solucionador y Supervisor se leen como chat y no confirman una entrega por sí solos",()=>{
  const solver=decodeTeamResponse(JSON.stringify({summary:"Encontré el contrato pendiente.",findings:["La API expone el saludo."],nextStep:"Reanudar Frontend con el contrato."}))!
  assert.equal(solver.title,"Informe del Solucionador");assert.match(solver.chatSummary.pending,/Propuesta al Lead/)
  const analysis=decodeTeamResponse(JSON.stringify({summary:"Falta integrar",criteriaSatisfied:true,criteria:[{requirement:"Integración",status:"unverified",evidence:"Sin ejecución observada"}]}))!
  assert.equal(analysis.title,"Análisis del Supervisor");assert.match(analysis.chatSummary.pending,/faltantes o sin verificar/)
})
