import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createServer as tcpServer } from "node:net"
import { mkdtemp, mkdir, rm, copyFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { budgetChatGPTRequest, CHATGPT_REQUEST_BUDGET } from "../src-tauri/src/responses-budget.js"

// Real pinned engine + shipped plugin; fake credentials and loopback inference.
const profile = await mkdtemp(join(tmpdir(), "guillecode-responses-"))
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let calls = 0, mode = "completed"
let wireBody
const mock = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  if (!request.url.endsWith("/responses")) return response.end("{}")
  wireBody = body
  calls++
  if (mode === "buffer") {
    response.writeHead(507, { "content-type": "text/plain" })
    return response.end("Insufficient Storage: exceeded request buffer limit while retrying upstream")
  }
  response.writeHead(200, { "content-type": "text/event-stream" })
  const events = [
    { type: "response.created", response: { id: "resp-qa", model: "qa-model", created_at: 0 } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "item-qa", role: "assistant", content: [], status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "item-qa", output_index: 0, content_index: 0, delta: "Respuesta parcial á🙂" },
  ]
  if (mode !== "eof") events.push({ type: `response.${mode}`, sequence_number: 3, response: {
    id: "resp-qa", status: mode, usage: { input_tokens: 10, output_tokens: 3 },
    ...(mode === "failed" ? { error: { code: "subscription_sharing_usage_limit_exceeded", message: "simulated usage limit" } } : {}),
    ...(mode === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
  } })
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
})
await new Promise((done) => mock.listen(0, "127.0.0.1", done))
const reserve = tcpServer()
await new Promise((done) => reserve.listen(0, "127.0.0.1", done))
const port = reserve.address().port
await new Promise((done) => reserve.close(done))
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
Object.assign(env, {
  USERPROFILE: profile, HOME: profile, APPDATA: profile, LOCALAPPDATA: profile,
  XDG_DATA_HOME: join(profile, "data"), XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
  OPENCODE_CONFIG_DIR: join(profile, "config", "opencode"), OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_SERVER_PASSWORD: "qa-password",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    plugin: [[pathToFileURL(join(profile, "responses-guard.js")).href, { diagnosticsPath: join(profile, "provider-diagnostics.jsonl"), appVersion: "qa" }]],
    enabled_providers: ["openai"],
    provider: { openai: { options: { apiKey: "qa-fake-key", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { "qa-model": { name: "QA", modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 200000, output: 32000 } } } } },
    agent: { title: { disable: true }, summary: { disable: true } },
  }),
})
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
await copyFile(resolve("src-tauri/src/responses_guard.js"), join(profile, "responses-guard.js"))
await copyFile(resolve("src-tauri/src/responses-budget.js"), join(profile, "responses-budget.js"))
await copyFile(resolve("src-tauri/src/provider-diagnostics.js"), join(profile, "provider-diagnostics.js"))
const child = spawn(resolve("src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG"], { env, cwd: profile, windowsHide: true, stdio: "pipe" })
let log = ""
for (const output of [child.stdout, child.stderr]) output.on("data", (bytes) => { log = (log + bytes).slice(-6000) })
const headers = { Authorization: `Basic ${Buffer.from("opencode:qa-password").toString("base64")}`, "content-type": "application/json" }
async function api(method, path, body, timeout = 15000) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) })
  assert.equal(response.ok, true, `${path}: ${response.status}`)
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await api("GET", "/global/health"); ready = true; break } catch { await delay(300) }
  }
  assert.ok(ready, log)
  let lastSession
  for (mode of ["completed", "failed", "incomplete", "eof", "buffer"]) {
    const before = calls
    // A fresh profile installs the engine's plugin dependencies on first use.
    const session = await api("POST", "/session", {}, 120000)
    lastSession = session
    await api("POST", `/session/${session.id}/prompt_async`, { model: { providerID: "openai", modelID: "qa-model" }, agent: "build", parts: [{ type: "text", text: "ping" }] })
    let messages, status
    for (let i = 0; i < 100; i++) {
      messages = await api("GET", `/session/${session.id}/message`)
      status = await api("GET", "/session/status")
      if (messages.some((message) => message.info.role === "assistant" && message.info.time.completed) && !status[session.id]) break
      await delay(200)
    }
    await delay(1200) // The unpatched engine made 15 calls during this interval.
    assert.equal(calls - before, 1, `${mode}: unexpected generation loop`)
    const assistants = messages.filter((message) => message.info.role === "assistant")
    assert.equal(assistants.length, 1)
    const assistant = assistants[0]
    assert.ok(assistant.info.time.completed)
    assert.ok(!status[session.id] || status[session.id].type === "idle", `${mode}: session left busy`)
    if (mode !== "buffer") assert.ok(assistant.parts.some((part) => part.type === "text" && part.text.includes("Respuesta parcial á🙂")), `${mode}: partial text lost`)
    if (mode === "completed") { assert.equal(assistant.info.finish, "stop"); assert.equal(assistant.info.error, undefined) }
    if (mode === "incomplete") { assert.equal(assistant.info.finish, "length"); assert.equal(assistant.info.error, undefined) }
    if (mode === "failed") assert.match(assistant.info.error?.data?.message ?? "", /subscription_sharing_usage_limit_exceeded/)
    if (mode === "eof") assert.match(assistant.info.error?.data?.message ?? "", /se interrumpió antes de recibir su final/)
    if (mode === "buffer") {
      assert.equal(assistant.info.error?.name, "UnknownError")
      assert.match(assistant.info.error?.data?.message ?? "", /guillecode_upstream_buffer_limit/)
      assert.match(assistant.info.error?.data?.message ?? "", /HTTP 507/)
      assert.match(JSON.stringify(assistant.info.error), /exceeded request buffer limit/)
    }
    console.log(`Responses ${mode}: one call, idle, terminal semantics OK`)
  }
  const diagnostics = (await readFile(join(profile, "provider-diagnostics.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)
  const requests = diagnostics.filter((record) => record.phase === "request")
  assert.equal(requests.length, 5)
  assert.ok(requests.every((record) => record.model === "qa-model" && record.requestBytes > 0 && record.appVersion === "qa"))
  assert.ok(diagnostics.some((record) => record.outcome === "response.completed" && record.usage?.input_tokens === 10))
  assert.ok(diagnostics.some((record) => record.outcome === "eof_without_terminal"))
  assert.ok(diagnostics.some((record) => record.outcome === "http_error" && record.status === 507))
  assert.ok(diagnostics.some((record) => record.failureClass === "upstream_buffer_limit"))
  assert.ok(!JSON.stringify(diagnostics).includes("qa-fake-key"))
  console.log("Provider diagnostics: real engine options, wire size, outcomes and safe persistence OK")
  // Verify the real engine's summarize contract, including HTTP 200 on failure.
  for (mode of ["completed", "failed"]) {
    const before = await api("GET", `/session/${lastSession.id}/message`)
    const ids = new Set(before.map((message) => message.info.id))
    await api("POST", `/session/${lastSession.id}/summarize`, { providerID: "openai", modelID: "qa-model" }, 30000)
    const after = await api("GET", `/session/${lastSession.id}/message`)
    const summary = after.findLast((message) => message.info.role === "assistant" && message.info.summary && !ids.has(message.info.id))
    assert.ok(summary, `${mode}: summarize did not persist a new summary`)
    if (mode === "completed") {
      assert.ok(summary.info.time.completed)
      assert.equal(summary.info.finish, "stop")
      assert.equal(summary.info.error, undefined)
    } else assert.ok(summary.info.error, "HTTP 200 must not hide a failed summary")
    console.log(`Compaction ${mode}: persisted summary verified after HTTP 200`)
  }
  // Inspect actual SDK serialization: synthetic text and its capture must stay
  // in the same user message, with the exact data URL hashed by the frontend.
  mode = "completed"
  const captures = await api("POST", "/session", {}, 120000)
  // Real decodable PNG with a large ancillary metadata chunk, below the
  // engine's resize threshold. Fake base64 images are rejected before fetch.
  const png = await readFile(resolve("src-tauri/icons/128x128.png"))
  const metadata = Buffer.concat([Buffer.from("QA\0"), Buffer.alloc(CHATGPT_REQUEST_BUDGET, 65)])
  const chunk = Buffer.concat([Buffer.from("tEXt"), metadata])
  let crc = 0xffffffff
  for (const byte of chunk) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(metadata.length)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  const oldURL = "data:image/png;base64," + Buffer.concat([png.subarray(0, -12), length, chunk, checksum, png.subarray(-12)]).toString("base64")
  const newURL = "data:image/png;base64," + png.toString("base64")
  const attachmentURL = "data:image/png;base64," + (await readFile(resolve("src-tauri/icons/32x32.png"))).toString("base64")
  const marker = (url) => `[Flufy desktop capture sha256:${createHash("sha256").update(url).digest("hex")}]`
  for (const [index, url] of [oldURL, newURL].entries()) {
    const before = calls
    await api("POST", `/session/${captures.id}/prompt_async`, {
      model: { providerID: "openai", modelID: "qa-model" }, agent: "build", parts: [
        { type: "text", text: `Desktop turn ${index}` },
        { type: "text", text: `Contexto observado de la aplicación\n${marker(url)}`, synthetic: true },
        { type: "file", mime: "image/png", filename: "aplicacion-actual.jpg", url },
        ...(index === 0 ? [{ type: "file", mime: "image/png", filename: "user-attachment.png", url: attachmentURL }] : []),
      ],
    })
    for (let i = 0; i < 100; i++) {
      const messages = await api("GET", `/session/${captures.id}/message`)
      const status = await api("GET", "/session/status")
      if (messages.filter((message) => message.info.role === "assistant" && message.info.time.completed).length === index + 1 && !status[captures.id]) break
      await delay(200)
    }
    assert.equal(calls - before, 1, "Captures must reach the mock provider once per turn")
  }
  assert.ok(Buffer.byteLength(wireBody) > CHATGPT_REQUEST_BUDGET)
  const bounded = budgetChatGPTRequest(wireBody)
  assert.ok(bounded, "Real engine serialization must permit omitting the old marked capture")
  assert.ok(Buffer.byteLength(bounded) <= CHATGPT_REQUEST_BUDGET)
  const parts = JSON.parse(bounded).input.flatMap((item) => Array.isArray(item.content) ? item.content : [])
  const images = parts.filter((part) => part.type === "input_image").map((part) => part.image_url)
  assert.deepEqual(images, [attachmentURL, newURL], "Keep user attachment and current capture")
  assert.ok(parts.some((part) => part.type === "input_text" && /captura anterior omitida/.test(part.text)))
  const history = await api("GET", `/session/${captures.id}/message`)
  assert.ok(history.some((message) => message.parts.some((part) => part.type === "file" && part.url === oldURL)), "Full capture stays persisted")
  console.log("Capture budget: real SDK serialization, old capture omitted, attachment/current capture and persisted history preserved")
} catch (error) {
  console.error(log)
  throw error
} finally {
  child.kill()
  await new Promise((done) => child.exitCode !== null ? done() : child.once("exit", done))
  mock.closeAllConnections()
  await new Promise((done) => mock.close(done))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
