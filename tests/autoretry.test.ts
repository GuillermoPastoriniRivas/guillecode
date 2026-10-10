import { test } from "node:test"
import assert from "node:assert/strict"
import {
  AUTO_RETRY_MAX,
  autoRetryDelayMs,
  isRetryableProviderError,
  lastVisibleUserMessage,
  latestFailedAssistant,
  retryPromptParts,
  CONTINUE_INTERRUPTED_TURN,
  shouldAutoRetry,
  turnExecutedTools,
} from "../src/lib/autoretry.ts"

const user = (id, parts) => ({ info: { id, role: "user" }, parts })
const assistant = (id, parentID, parts = []) => ({ info: { id, role: "assistant", parentID, time: {} }, parts })
const text = (value, synthetic = false) => ({ type: "text", text: value, synthetic })
const tool = () => ({ type: "tool" })

test("reconoce solo el error de proveedor reintentable", () => {
  assert.equal(isRetryableProviderError({ name: "APIError", data: { isRetryable: true } }), true)
  assert.equal(isRetryableProviderError({ name: "APIError", data: { isRetryable: false } }), false)
  assert.equal(isRetryableProviderError({ name: "ProviderAuthError", data: {} }), false)
  assert.equal(isRetryableProviderError(undefined), false)
})

test("elige el último mensaje del usuario con contenido visible", () => {
  const messages = [
    user("u1", [text("hola")]),
    user("ctx", [text("# Memoria fluws", true)]),
    assistant("a1", "u1"),
    user("u2", [text("   ", true)]),
    user("u3", [text("seguí")]),
  ]
  assert.equal(lastVisibleUserMessage(messages)?.info.id, "u3")
  assert.equal(lastVisibleUserMessage([assistant("a1", "u1")]), null)
})

test("no reintenta un turno que ya ejecutó herramientas", () => {
  const clean = [user("u1", [text("hola")]), assistant("a1", "u1", [text("respuesta")])]
  assert.equal(turnExecutedTools(clean, "u1"), false)
  assert.equal(shouldAutoRetry(clean, "u1"), true)

  const usedTool = [user("u1", [text("hola")]), assistant("a1", "u1", [tool()]), assistant("a2", "u1", [text("listo")])]
  assert.equal(turnExecutedTools(usedTool, "u1"), true)
  assert.equal(shouldAutoRetry(usedTool, "u1"), false)

  // Tools from a previous turn don't block a clean retry.
  const later = [user("u1", [text("a")]), assistant("a1", "u1", [tool()]), user("u2", [text("b")]), assistant("a2", "u2")]
  assert.equal(shouldAutoRetry(later, "u2"), true)
  // A missing parent is treated as unsafe.
  assert.equal(shouldAutoRetry(later, "nope"), false)
})

test("el backoff crece y se mantiene acotado", () => {
  assert.ok(autoRetryDelayMs(0) < autoRetryDelayMs(1))
  assert.equal(autoRetryDelayMs(AUTO_RETRY_MAX), autoRetryDelayMs(99))
  assert.equal(AUTO_RETRY_MAX, 3)
})

test("solo recupera el error terminal, no errores históricos ni respuestas incompletas", () => {
  const failed = { info: { id: "a1", role: "assistant", time: { completed: 1 }, error: { name: "APIError" } }, parts: [] }
  assert.equal(latestFailedAssistant([failed]), failed)
  assert.equal(latestFailedAssistant([failed, user("u2", [text("seguí")])]), null)
  assert.equal(latestFailedAssistant([failed, assistant("a2", "u2")]), null)
  assert.equal(latestFailedAssistant([{ ...failed, info: { ...failed.info, time: {} } }]), null)
})

test("reintento manual continúa el trabajo si hubo herramientas o falta el padre visible", () => {
  const clean = [user("u1", [text("hacé el trabajo"), text("contexto", true)]), assistant("a1", "u1")]
  assert.deepEqual(retryPromptParts(clean, "u1"), [{ type: "text", text: "hacé el trabajo" }])
  const continuation = [{ type: "text", text: CONTINUE_INTERRUPTED_TURN }]
  assert.deepEqual(retryPromptParts([...clean, assistant("a2", "u1", [tool()])], "u1"), continuation)
  assert.deepEqual(retryPromptParts([assistant("a1", "u1")], "u1"), continuation)
  assert.deepEqual(retryPromptParts([user("ctx", [text("# Memoria fluws", true)]), assistant("a1", "ctx")], "ctx"), continuation)
})
