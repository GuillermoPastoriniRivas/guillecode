import { test } from "node:test"
import assert from "node:assert/strict"
import { GuilleCodeResponses } from "../src-tauri/src/responses_guard.js"
import { budgetChatGPTRequest, CHATGPT_REQUEST_BUDGET } from "../src-tauri/src/responses-budget.js"

test("ChatGPT mide UTF-8 y preserva instrucciones, usuarios y pares de herramientas", () => {
  const input = [{ role: "user", content: "No borrar mis requisitos" }]
  for (let i = 0; i < 12; i++) {
    input.push({ role: "assistant", content: `Paso ${i}` })
    input.push({ type: "function_call", call_id: `call-${i}`, name: "read", arguments: "{}" })
    input.push({ type: "function_call_output", call_id: `call-${i}`, output: "á🙂".repeat(15000) })
  }
  const request = { instructions: "reglas", tools: [{ name: "read" }], input }
  const body = JSON.stringify(request)
  assert.ok(body.length < CHATGPT_REQUEST_BUDGET)
  assert.ok(Buffer.byteLength(body) > CHATGPT_REQUEST_BUDGET)
  const bounded = budgetChatGPTRequest(body)
  assert.ok(bounded)
  assert.ok(Buffer.byteLength(bounded) <= CHATGPT_REQUEST_BUDGET)
  const result = JSON.parse(bounded)
  assert.equal(result.instructions, request.instructions)
  assert.deepEqual(result.tools, request.tools)
  assert.deepEqual(result.input[0], input[0])
  assert.equal(result.input.length, input.length)
  assert.deepEqual(result.input.slice(-16), input.slice(-16))
  assert.match(result.input[3].output, /salida antigua abreviada/)
  assert.equal(JSON.stringify(request), body, "No mutar el historial original")
  assert.equal(budgetChatGPTRequest(bounded), bounded, "Idempotente")
  assert.equal(budgetChatGPTRequest(JSON.stringify({ input: [{ role: "user", content: "x".repeat(CHATGPT_REQUEST_BUDGET) }] })), null)
  assert.equal(budgetChatGPTRequest('{ "input": [] }'), '{ "input": [] }')
  const batch = input.filter((item) => item.type)
  assert.equal(budgetChatGPTRequest(JSON.stringify({ input: batch })), null, "No abreviar un lote paralelo actual aunque tenga más de ocho resultados")
})

test("ChatGPT no envía requests irreducibles; respeta Request, cancelación y otros proveedores", async () => {
  const original = globalThis.fetch
  const key = Symbol.for("guillecode.responses.guard")
  let calls = 0
  let sent
  try {
    globalThis.fetch = async (_input, init) => { calls++; sent = init; return new Response("ok") }
    await GuilleCodeResponses()
    const body = JSON.stringify({ input: [{ role: "user", content: "x".repeat(CHATGPT_REQUEST_BUDGET) }] })
    const response = await fetch(new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body }))
    assert.match(await response.text(), /guillecode_request_budget/)
    assert.equal(calls, 0)
    await fetch("https://api.openai.com/v1/responses", { method: "POST", body })
    assert.equal(calls, 1)
    const old = { type: "function_call_output", call_id: "old", output: "x".repeat(CHATGPT_REQUEST_BUDGET) }
    const recent = Array.from({ length: 8 }, (_, i) => ({ type: "function_call_output", call_id: `recent-${i}`, output: "ok" }))
    const reducible = JSON.stringify({ input: [old, { role: "assistant", content: "continuar" }, ...recent] })
    await fetch(new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: reducible, headers: { "content-length": String(Buffer.byteLength(reducible)), "authorization": "Bearer fake" } }))
    assert.ok(Buffer.byteLength(sent.body) <= CHATGPT_REQUEST_BUDGET)
    assert.equal(sent.headers.get("content-length"), null)
    assert.equal(sent.headers.get("authorization"), "Bearer fake")
    assert.equal(calls, 2)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body, signal: abort.signal }), { name: "AbortError" })
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = original
    delete globalThis[key]
  }
})

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
    const bufferError = "Insufficient Storage: exceeded request buffer limit while retrying upstream"
    response = new Response(bufferError, { status: 507, headers: { "content-type": "text/plain", "content-length": String(bufferError.length) } })
    const limited = await fetch("https://api.openai.com/v1/responses", { method: "POST" })
    assert.equal(limited.headers.get("content-type"), "text/event-stream")
    assert.equal(limited.headers.get("content-length"), null)
    const failure = await limited.text()
    assert.match(failure, /response.failed/)
    assert.match(failure, /guillecode_upstream_buffer_limit/)
    assert.match(failure, /HTTP 507/)
    assert.ok(failure.includes(bufferError))
    assert.ok(!failure.includes("response.completed"))
    response = new Response("Insufficient Storage", { status: 507 })
    assert.equal(await fetch("https://api.openai.com/v1/responses", { method: "POST" }), response, "No se transforma cualquier 507")
    response = new Response(bufferError, { status: 507 })
    assert.equal(await fetch("https://api.openai.com/v1/other", { method: "POST" }), response)
    assert.equal(await fetch("https://api.openai.com/v1/responses"), response)
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
