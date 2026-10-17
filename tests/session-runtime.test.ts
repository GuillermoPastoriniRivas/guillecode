import { test } from "node:test"
import assert from "node:assert/strict"

test("drafts survive storage failures and malformed data; separate windows have separate new drafts", async () => {
  const data = new Map<string, string>()
  let fail = false
  Object.assign(globalThis, { window: { addEventListener() {} }, localStorage: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (fail) throw new Error("quota"); data.set(key, value) },
  } })
  const { sessionRuntime, patchSessionRuntime, draftRuntimeKey } = await import("../src/state/session-runtime.ts")
  data.set("guillecode:session-runtime:broken", "null")
  assert.deepEqual(sessionRuntime("broken"), {})
  patchSessionRuntime("s", { draft: "antes" })
  fail = true
  assert.equal(patchSessionRuntime("s", { draft: "no perder este texto" }), false)
  assert.equal(sessionRuntime("s").draft, "no perder este texto")
  fail = false
  assert.equal(patchSessionRuntime("s", { agent: "escritorio" }), true)
  assert.equal(JSON.parse(data.get("guillecode:session-runtime:s")!).draft, "no perder este texto")
  assert.notEqual(draftRuntimeKey("C:/project", "main"), draftRuntimeKey("C:/project", "w-2"))
})

test("handoff drain waits for pending transcription and submit", async () => {
  const { registerPendingInput, finishPendingInput } = await import("../src/lib/pending-input.ts")
  let release!: () => void
  let completed = false
  const pending = new Promise<void>(resolve => { release = resolve })
  const unregister = registerPendingInput("audio-session", () => pending)
  const drain = finishPendingInput("audio-session").then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  release()
  await drain
  assert.equal(completed, true)
  unregister()
  await finishPendingInput("audio-session")
})
