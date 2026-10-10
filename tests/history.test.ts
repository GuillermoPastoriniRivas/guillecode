import { test } from "node:test"
import assert from "node:assert/strict"
import { reconcileHistory } from "../src/lib/history.ts"

const message = (id, text, time = 1) => ({ info: { id, time: { created: time } }, parts: [{ text }] })

test("REST atrasado no borra SSE nuevo ni resucita mensajes eliminados", () => {
  const stale = message("a", "viejo"), removed = message("b", "eliminado", 2)
  const current = message("a", "SSE nuevo"), added = message("c", "nuevo", 3)
  const result = reconcileHistory([stale, removed], [current, added], () => true)
  assert.deepEqual(result, [current, added])
  assert.deepEqual(reconcileHistory([stale], [current], () => false), [stale])
})

test("una admisión aún no persistida se conserva y REST incorpora mensajes omitidos por SSE", () => {
  const accepted = message("pending", "enviado", 2), fetched = message("a", "REST", 1)
  assert.deepEqual(reconcileHistory([fetched], [accepted], () => false, (id) => id === "pending"), [fetched, accepted])
})
