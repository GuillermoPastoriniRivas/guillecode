import { test } from "node:test"
import assert from "node:assert/strict"
import { FlufyResponses } from "../src-tauri/src/responses_guard.js"
import { budgetChatGPTRequest, CHATGPT_REQUEST_BUDGET } from "../src-tauri/src/responses-budget.js"
import { desktopCaptureMarker } from "../src/lib/internal-context.ts"

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
  const irreducible = JSON.stringify({ input: [{ role: "user", content: "x".repeat(CHATGPT_REQUEST_BUDGET) }] })
  assert.equal(budgetChatGPTRequest(irreducible), irreducible, "Un texto de usuario irreducible se envía igual, nunca falla localmente")
  assert.equal(budgetChatGPTRequest('{ "input": [] }'), '{ "input": [] }')
  const batch = input.filter((item) => item.type)
  const forced = budgetChatGPTRequest(JSON.stringify({ input: batch }))
  assert.ok(forced, "Un lote paralelo actual se recorta en vez de fallar")
  assert.ok(Buffer.byteLength(forced) <= CHATGPT_REQUEST_BUDGET)
  const forcedInput = JSON.parse(forced).input
  assert.deepEqual(forcedInput.at(-1), batch.at(-1), "La salida más reciente sobrevive al recorte forzado")
  assert.match(forcedInput.find((item) => item.type === "function_call_output").output, /salida antigua abreviada/)
  const latestOutput = JSON.stringify({ input: [
    { type: "function_call", call_id: "latest", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "latest", output: "x".repeat(CHATGPT_REQUEST_BUDGET) },
  ] })
  assert.equal(budgetChatGPTRequest(latestOutput), latestOutput, "La última salida se conserva y se envía aunque por sí sola supere el presupuesto")
})

test("ChatGPT omite capturas identificadas de más vieja a nueva sin campos de imagen residuales", async () => {
  const image = "data:image/jpeg;base64," + "A".repeat(120000)
  const input: unknown[] = []
  for (let i = 0; i < 9; i++) {
    const url = image + i
    input.push({ role: "user", content: [{ type: "input_image", image_url: url, detail: "high" }, { type: "input_text", text: `Paso ${i}\n${await desktopCaptureMarker(url)}` }] })
  }
  input.push({ role: "user", content: [{ type: "input_image", image_url: image }, { type: "input_text", text: await desktopCaptureMarker(image) }] })
  const request = { instructions: "reglas", tools: [{ name: "read" }], input }
  const body = JSON.stringify(request)
  assert.ok(Buffer.byteLength(body) > CHATGPT_REQUEST_BUDGET)
  const bounded = budgetChatGPTRequest(body)
  assert.ok(bounded)
  assert.ok(Buffer.byteLength(bounded) <= CHATGPT_REQUEST_BUDGET)
  const result = JSON.parse(bounded)
  const parts = result.input.flatMap((item: { content?: { type: string; text?: string; image_url?: string }[] }) => Array.isArray(item.content) ? item.content : [])
  const kept = parts.filter((part) => part.type === "input_image")
  assert.ok(kept.length < 10, "Omite capturas antiguas hasta entrar en el presupuesto")
  assert.ok(kept.length >= 1, "Nunca omite la observación actual")
  assert.equal(kept.at(-1)?.image_url, image, "Conserva la captura más reciente")
  assert.ok(parts.some((part) => part.type === "input_text" && /captura anterior omitida/.test(part.text ?? "")))
  const omitted = result.input.slice(0, 10 - kept.length)
  for (const item of omitted) assert.deepEqual(Object.keys(item.content[0]).sort(), ["text", "type"])
  assert.deepEqual(result.input.slice(omitted.length), input.slice(omitted.length), "Solo cambia un prefijo de capturas")
  assert.equal(JSON.stringify(request), body, "No mutar el historial original")
  assert.equal(budgetChatGPTRequest(bounded), bounded, "Idempotente")
})

test("ChatGPT preserva adjuntos sin marca, capturas actuales múltiples y razonamiento", async () => {
  const image = (name: string, size = 150000) => ({ type: "input_image", image_url: "data:image/jpeg;base64," + name.repeat(size), detail: "high" })
  const old = image("a", 600000)
  const attachment = image("b")
  const current = [image("c"), image("d")]
  const input = [
    { role: "user", content: [old, attachment, { type: "input_text", text: await desktopCaptureMarker(old.image_url) }] },
    { type: "reasoning", encrypted_content: "opaque" },
    { role: "user", content: [...current, { type: "input_text", text: (await Promise.all(current.map((part) => desktopCaptureMarker(part.image_url)))).join("\n") }] },
    { type: "function_call", call_id: "c", name: "observe", arguments: "{}" },
    { type: "function_call_output", call_id: "c", output: "observation" },
  ]
  const body = JSON.stringify({ input })
  const bounded = budgetChatGPTRequest(body)
  assert.ok(bounded)
  const result = JSON.parse(bounded)
  assert.equal(result.input[0].content[0].type, "input_text")
  assert.deepEqual(result.input[0].content[1], attachment)
  assert.deepEqual(result.input.slice(1), input.slice(1))
  assert.equal(JSON.stringify({ input }), body)

  const huge = image("e", CHATGPT_REQUEST_BUDGET)
  // A later text-only instruction does not make the latest capture expendable.
  const latest = { role: "user", content: [huge, { type: "input_text", text: await desktopCaptureMarker(huge.image_url) }] }
  const withInstruction = JSON.stringify({ input: [latest, { role: "user", content: "Continuá" }] })
  assert.equal(budgetChatGPTRequest(withInstruction), withInstruction, "La observación actual se conserva; si queda irreducible se envía igual")
  // Legacy images and mismatched markers are not inferred to be screenshots.
  const unmarked = { role: "user", content: [huge, { type: "input_text", text: await desktopCaptureMarker(old.image_url) }] }
  const mismatched = JSON.stringify({ input: [unmarked, input[2]] })
  assert.equal(budgetChatGPTRequest(mismatched), mismatched)
  const unmarkedCurrent = JSON.stringify({ input: [{ role: "user", content: [huge, ...current] }] })
  assert.equal(budgetChatGPTRequest(unmarkedCurrent), unmarkedCurrent)
  const small = JSON.stringify({ input: [input[2]] })
  assert.equal(budgetChatGPTRequest(small), small, "No tocar solicitudes que ya caben")
})

test("ChatGPT recorta y nunca falla localmente; respeta Request, cancelación y otros proveedores", async () => {
  const original = globalThis.fetch
  const key = Symbol.for("guillecode.responses.guard")
  let calls = 0
  let sent
  let sentBody
  try {
    globalThis.fetch = async (input, init) => {
      calls++
      sent = init
      sentBody = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : null
      return new Response("ok")
    }
    await FlufyResponses()
    const body = JSON.stringify({ input: [{ role: "user", content: "x".repeat(CHATGPT_REQUEST_BUDGET) }] })
    const response = await fetch(new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body }))
    assert.equal(await response.text(), "ok")
    assert.equal(calls, 1, "Un request irreducible se envía igual: el error, si existe, lo da el proveedor")
    assert.equal(sentBody, body)
    await fetch("https://api.openai.com/v1/responses", { method: "POST", body })
    assert.equal(calls, 2)
    const old = { type: "function_call_output", call_id: "old", output: "x".repeat(CHATGPT_REQUEST_BUDGET) }
    const recent = Array.from({ length: 8 }, (_, i) => ({ type: "function_call_output", call_id: `recent-${i}`, output: "ok" }))
    const reducible = JSON.stringify({ input: [old, { role: "assistant", content: "continuar" }, ...recent] })
    await fetch(new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: reducible, headers: { "content-length": String(Buffer.byteLength(reducible)), "authorization": "Bearer fake" } }))
    assert.ok(Buffer.byteLength(sent.body) <= CHATGPT_REQUEST_BUDGET)
    assert.equal(sent.headers.get("content-length"), null)
    assert.equal(sent.headers.get("authorization"), "Bearer fake")
    assert.equal(calls, 3)
    const screenshot = "data:image/jpeg;base64," + "A".repeat(CHATGPT_REQUEST_BUDGET)
    const marked = JSON.stringify({ input: [
      { role: "user", content: [{ type: "input_text", text: await desktopCaptureMarker(screenshot) }, { type: "input_image", image_url: screenshot, detail: "high" }] },
      { role: "user", content: [{ type: "input_text", text: await desktopCaptureMarker("data:image/jpeg;base64,new") }, { type: "input_image", image_url: "data:image/jpeg;base64,new" }] },
    ] })
    await fetch(new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: marked }))
    assert.ok(Buffer.byteLength(sent.body) <= CHATGPT_REQUEST_BUDGET)
    assert.deepEqual(JSON.parse(sent.body).input[1], JSON.parse(marked).input[1])
    assert.equal(JSON.parse(sent.body).input[0].content[1].type, "input_text")
    assert.equal(calls, 4)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body, signal: abort.signal }), { name: "AbortError" })
    assert.equal(calls, 4)
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
    await FlufyResponses()
    const once = globalThis.fetch
    await FlufyResponses()
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
