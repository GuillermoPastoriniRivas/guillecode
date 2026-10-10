import { test } from "node:test"
import assert from "node:assert/strict"
import { GuilleCodeResponses } from "../src-tauri/src/responses_guard.js"

test("Responses preserva bytes fragmentados y exige un terminal válido; cancela el lector", async () => {
  const original = globalThis.fetch
  const key = Symbol.for("guillecode.responses.guard")
  let response: Response
  try {
    globalThis.fetch = async () => response
    await GuilleCodeResponses()
    const once = globalThis.fetch
    await GuilleCodeResponses()
    assert.equal(globalThis.fetch, once, "El guard se instala una vez por proceso")
    const event = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`
    const delta = event({ type: "response.output_text.delta", delta: "á🙂 parcial" })
    const usage = { input_tokens: 1, output_tokens: 2 }
    const cases = [
      [event({ type: "response.completed", response: { usage } }), true],
      [event({ type: "response.incomplete", response: { usage, incomplete_details: { reason: "max_output_tokens" } } }), true],
      [event({ type: "response.failed", sequence_number: 4, response: { error: { message: "usage limit" } } }), true],
      ["", false], ["data: [DONE]\n\n", false],
      [event({ type: "response.completed", response: {} }), false],
      [event({ type: "response.failed", response: { error: { message: "missing sequence" } } }), false],
      ['data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}', false],
      [': comment mentions response.completed\n\ndata: {"type":"response.output_text.delta","delta":"response.completed"}\n\n', false],
    ]
    for (const [end, valid] of cases) {
      const bytes = new TextEncoder().encode(delta + end)
      let offset = 0
      response = new Response(new ReadableStream({ pull(controller) {
        if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset))
        else controller.close()
      } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } })
      const guarded = await fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" })
      const read = guarded.text()
      if (valid) assert.equal(await read, delta + end)
      else {
        const text = await read
        assert.ok(text.startsWith(delta + end))
        assert.match(text, /"code":"guillecode_interrupted_stream"/)
      }
    }
    response = new Response("unavailable", { status: 503 })
    assert.equal(await fetch("https://api.openai.com/v1/responses", { method: "POST" }), response)
    response = new Response("event stream", { headers: { "content-type": "text/event-stream" } })
    assert.equal(await fetch("https://local/global/event"), response)
    let readCount = 0
    response = new Response(new ReadableStream({ pull(controller) {
      if (readCount++ === 0) controller.enqueue(new TextEncoder().encode(delta))
      else controller.error(new TypeError("connection reset"))
    } }), { headers: { "content-type": "text/event-stream" } })
    const reset = await (await fetch("https://api.openai.com/v1/responses", { method: "POST" })).text()
    assert.ok(reset.startsWith(delta))
    assert.match(reset, /guillecode_interrupted_stream/)
    const abort = new AbortController()
    response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(delta)); controller.close()
    } }), { headers: { "content-type": "text/event-stream" } })
    const stopped = await fetch("https://api.openai.com/v1/responses", { method: "POST", signal: abort.signal })
    abort.abort()
    await assert.rejects(stopped.text(), { name: "AbortError" })
    let cancelled = false
    response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { "content-type": "text/event-stream" } })
    await (await fetch("https://api.openai.com/v1/responses", { method: "POST" })).body!.cancel()
    assert.equal(cancelled, true)
  } finally {
    globalThis.fetch = original
    delete globalThis[key]
  }
})
