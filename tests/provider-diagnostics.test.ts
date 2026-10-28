import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createProviderDiagnostics } from "../src-tauri/src/provider-diagnostics.js"
import { FlufyResponses } from "../src-tauri/src/responses_guard.js"

const records = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse)

test("El diagnóstico mide el payload real, correlaciona repeticiones y excluye contenido y secretos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-diagnostics-"))
  const path = join(dir, "trace.jsonl")
  try {
    const log = createProviderDiagnostics(path, { appVersion: "0.12.3-local" })!
    const body = JSON.stringify({ model: "gpt-6.1-sol", reasoning: { effort: "xhigh" }, prompt_cache_key: "private-cache-key", instructions: "instrucción á privada", tools: [{ type: "function", name: "private-tool" }], input: [
      { role: "user", content: [{ type: "input_text", text: "mensaje privado🙂" }, { type: "input_image", image_url: "data:image/png;base64,PRIVATE_IMAGE" }] },
      { type: "function_call", arguments: "PRIVATE_ARGUMENTS" },
      { type: "function_call_output", output: "PRIVATE_TOOL_RESULT" },
    ] })
    const init = { body, headers: { "session-id": "ses_abc123", Authorization: "Bearer PRIVATE_TOKEN", "chatgpt-account-id": "PRIVATE_ACCOUNT" } }
    const a = log.begin("https://chatgpt.com/backend-api/codex/responses?token=PRIVATE_QUERY", init)!
    const b = log.begin("https://chatgpt.com/backend-api/codex/responses", init)!
    a.headers(new Response("", { status: 503, headers: { "cf-ray": "test-EZE", "x-request-id": "req-123", "set-cookie": "PRIVATE_COOKIE" } }))
    a.error("transport_error", { name: "TypeError", cause: { code: "ECONNRESET", message: "PRIVATE_ERROR" } })
    b.chunk(new Uint8Array(17))
    b.event({ type: "response.completed", response: { id: "resp_123", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 8 } } } }, true)
    b.finish("consumer_cancelled") // Exactly one terminal record.
    await log.flush()
    const data = await records(path)
    const [first, second] = data.filter((r) => r.phase === "request")
    assert.equal(first.requestBytes, Buffer.byteLength(body))
    assert.equal(first.model, "gpt-6.1-sol")
    assert.equal(first.reasoningEffort, "xhigh")
    assert.equal(first.images, 1)
    assert.equal(first.functionResults, 1)
    assert.equal(first.toolResultBytes, Buffer.byteLength("PRIVATE_TOOL_RESULT"))
    assert.equal(first.samePayloadAttempt, 1)
    assert.equal(second.samePayloadAttempt, 2)
    assert.equal(second.concurrentRequests, 2)
    assert.equal(first.payloadHash, second.payloadHash)
    assert.notEqual(first.requestID, second.requestID)
    const finishes = data.filter((r) => r.phase === "finish")
    assert.equal(finishes.length, 2)
    assert.equal(finishes[0].causeCode, "ECONNRESET")
    assert.equal(finishes[0].responseHeaders["x-request-id"], "req-123")
    assert.equal(finishes[1].receivedBytes, 17)
    assert.equal(finishes[1].cache.cached_tokens, 8)
    const text = JSON.stringify(data)
    for (const secret of ["PRIVATE_", "private-cache-key", "private-tool", "instrucción", "mensaje privado"]) assert.ok(!text.includes(secret), secret)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("El registro rota a tres archivos y no consume los cuerpos Request opacos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-diagnostics-"))
  const path = join(dir, "trace.jsonl")
  try {
    const log = createProviderDiagnostics(path, { maxBytes: 1800 })!
    const request = new Request("https://api.openai.com/v1/responses", { method: "POST", body: "PRIVATE_BODY" })
    for (let i = 0; i < 20; i++) log.begin(request)!.finish("http_ok_non_stream")
    await log.flush()
    assert.equal(request.bodyUsed, false)
    assert.equal(await request.text(), "PRIVATE_BODY")
    for (const file of [path, `${path}.1`, `${path}.2`]) {
      assert.ok((await stat(file)).size <= 1800)
      assert.ok((await records(file)).every((r) => r.bodyKind === undefined || r.bodyKind === "unavailable"))
    }
    await assert.rejects(stat(`${path}.3`), { code: "ENOENT" })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("Fetch diagnosticado conserva el HTTP 503, clasifica el proxy y propaga errores de red", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-diagnostics-"))
  const path = join(dir, "trace.jsonl")
  const original = globalThis.fetch, key = Symbol.for("guillecode.responses.guard")
  try {
    let response = new Response("upstream connect error or disconnect/reset before headers. reset reason: remote connection failure PRIVATE_ERROR", { status: 503 })
    let failure
    globalThis.fetch = async () => { if (failure) throw failure; return response }
    await FlufyResponses(undefined, { diagnosticsPath: path })
    const init = { method: "POST", body: JSON.stringify({ model: "qa", input: [] }) }
    assert.equal(await fetch("https://chatgpt.com/backend-api/codex/responses", init), response)
    assert.match(await response.text(), /upstream connect error/)
    failure = Object.assign(new TypeError("PRIVATE_NETWORK_ERROR"), { cause: { code: "ENOTFOUND" } })
    await assert.rejects(fetch("https://chatgpt.com/backend-api/codex/responses", init), (e) => e === failure)
    let data = []
    for (let i = 0; i < 100; i++) {
      try { data = await records(path) } catch { /* Initial append may still be pending. */ }
      if (data.some((r) => r.causeCode === "ENOTFOUND") && data.some((r) => r.phase === "http_error_detail")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(data.some((r) => r.status === 503 && r.outcome === "http_error"))
    assert.ok(data.some((r) => r.failureClass === "upstream_connection_failure" && r.remoteConnectionFailure))
    assert.ok(data.some((r) => r.causeCode === "ENOTFOUND" && r.outcome === "transport_error"))
    assert.ok(!JSON.stringify(data).includes("PRIVATE_"))
  } finally {
    globalThis.fetch = original; delete globalThis[key]
    await rm(dir, { recursive: true, force: true })
  }
})
