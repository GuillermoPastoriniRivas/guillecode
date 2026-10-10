import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createServer as tcpServer } from "node:net"
import { mkdtemp, mkdir, rm, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Real pinned engine + shipped plugin; fake credentials and loopback inference.
const profile = await mkdtemp(join(tmpdir(), "guillecode-responses-"))
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let calls = 0, mode = "completed"
const mock = createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain request */ }
  if (!request.url.endsWith("/responses")) return response.end("{}")
  calls++
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
    plugin: [pathToFileURL(join(profile, "responses-guard.js")).href],
    enabled_providers: ["openai"],
    provider: { openai: { options: { apiKey: "qa-fake-key", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { "qa-model": { name: "QA", limit: { context: 200000, output: 32000 } } } } },
    agent: { title: { disable: true }, summary: { disable: true } },
  }),
})
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
await copyFile(resolve("src-tauri/src/responses_guard.js"), join(profile, "responses-guard.js"))
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
  for (mode of ["completed", "failed", "incomplete", "eof"]) {
    const before = calls
    // A fresh profile installs the engine's plugin dependencies on first use.
    const session = await api("POST", "/session", {}, 120000)
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
    assert.ok(assistant.parts.some((part) => part.type === "text" && part.text.includes("Respuesta parcial á🙂")), `${mode}: partial text lost`)
    if (mode === "completed") { assert.equal(assistant.info.finish, "stop"); assert.equal(assistant.info.error, undefined) }
    if (mode === "incomplete") { assert.equal(assistant.info.finish, "length"); assert.equal(assistant.info.error, undefined) }
    if (mode === "failed") assert.match(assistant.info.error?.data?.message ?? "", /subscription_sharing_usage_limit_exceeded/)
    if (mode === "eof") assert.match(assistant.info.error?.data?.message ?? "", /se interrumpió antes de recibir su final/)
    console.log(`Responses ${mode}: one call, idle, partial text preserved, terminal semantics OK`)
  }
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
