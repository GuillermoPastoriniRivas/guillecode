import assert from "node:assert/strict"
import { test } from "node:test"
import type { Part } from "@opencode-ai/sdk"
import { planIsCurrent, type PlanTurnMessage } from "../src/lib/plan.ts"

const user = (id: string): PlanTurnMessage => ({ info: { id, role: "user" }, parts: [] })
const assistant = (id: string, tools: string[] = []): PlanTurnMessage => ({
  info: { id, role: "assistant" },
  parts: tools.map((tool, i) => ({ id: `${id}-${i}`, type: "tool", tool }) as unknown as Part),
})

test("muestra el plan escrito durante el turno actual", () => {
  const messages = [user("u1"), assistant("a1", ["todowrite"]), assistant("a2", ["bash"])]
  assert.equal(planIsCurrent(messages), true)
})

test("oculta el plan cuando el usuario ya empezó otra tarea", () => {
  const messages = [user("u1"), assistant("a1", ["todowrite"]), user("u2"), assistant("a2", ["bash"])]
  assert.equal(planIsCurrent(messages), false)
})

test("vuelve a mostrar el plan si el agente lo escribe en el turno nuevo", () => {
  const messages = [user("u1"), assistant("a1", ["todowrite"]), user("u2"), assistant("a2", ["todowrite"])]
  assert.equal(planIsCurrent(messages), true)
})

test("un mensaje en cola no oculta el plan que se está ejecutando", () => {
  const messages = [user("u1"), assistant("a1", ["todowrite"]), user("u2")]
  assert.equal(planIsCurrent(messages, new Set(["u2"])), true)
})

test("sin mensajes del usuario cargados conserva el plan de la ventana", () => {
  assert.equal(planIsCurrent([assistant("a1", ["bash"])]), true)
})
