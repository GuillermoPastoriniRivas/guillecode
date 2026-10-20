import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, copyFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// The real bundled engine must preserve hook-added identity even though it is
// absent from the model's MCP schema. All inference is loopback, with fake keys.
const repo = fileURLToPath(new URL("../", import.meta.url))
const parent = join(process.env.LOCALAPPDATA, "Temp", "opencode")
await mkdir(parent, { recursive: true })
const profile = await mkdtemp(join(parent, "desktop-session-"))
const calls = [], bindings = []
let generations = 0
const server = createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  if (request.url === "/desktop/session") {
    bindings.push(body.session)
    response.setHeader("Content-Type", "application/json")
    return response.end(JSON.stringify({ token: `cap-${body.session}`, run: 3, task: null }))
  }
  if (["/mcp/desktop", "/mcp/browser"].includes(request.url)) {
    if (body.id === undefined) { response.writeHead(202); return response.end() }
    let result = {}
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "desktop-test", version: "1" } }
    if (body.method === "tools/list") result = { tools: [{ name: request.url === "/mcp/browser" ? "list_pages" : "status", description: "Read assigned workspace status", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }
    if (body.method === "tools/call") { calls.push(body.params); result = { content: [{ type: "text", text: "Window verified" }] } }
    response.setHeader("Content-Type", "application/json")
    return response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
  }
  if (request.url?.endsWith("/responses")) {
    generations++
    const toolOutput = body.input?.some((part) => part.type === "function_call_output")
    const toolName = body.tools?.find((tool) => tool.name?.startsWith("browser_"))?.name ?? body.tools?.find((tool) => tool.name?.startsWith("desktop_"))?.name
    const item = toolOutput || !toolName
      ? { type: "message", id: "msg-qa", role: "assistant", content: [{ type: "output_text", text: "Verificado", annotations: [] }], status: "completed" }
      : { type: "function_call", id: "fc-qa", call_id: "call-qa", name: toolName, arguments: "{}", status: "completed" }
    const events = [
      { type: "response.created", response: { id: "resp-qa", model: "qa-model", created_at: 0 } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", content: [], status: "in_progress" } },
      ...(item.type === "function_call" ? [
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: "{}" },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: "{}" },
      ] : [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Verificado" }]),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp-qa", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3 } } },
    ]
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    return response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
  }
  response.end("{}")
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const origin = `http://127.0.0.1:${server.address().port}`
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
Object.assign(env, {
  USERPROFILE: profile, HOME: profile, APPDATA: profile, LOCALAPPDATA: profile,
  XDG_DATA_HOME: join(profile, "data"), XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
  OPENCODE_CONFIG_DIR: join(profile, "config", "opencode"), OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_SERVER_PASSWORD: "qa-password",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    plugin: [pathToFileURL(join(profile, "desktop-session.js")).href], enabled_providers: ["openai"],
    provider: { openai: { options: { apiKey: "qa-fake-key", baseURL: `${origin}/v1` }, models: { "qa-model": { name: "QA", limit: { context: 200000, output: 32000 } } } } },
    mcp: { desktop: { type: "remote", url: `${origin}/mcp/desktop`, oauth: false, headers: { Authorization: "Bearer test" } }, browser: { type: "remote", url: `${origin}/mcp/browser`, oauth: false } },
    permission: { "desktop_*": "deny", "browser_*": "deny" },
    agent: { title: { disable: true }, summary: { disable: true }, escritorio: { mode: "primary", permission: { "desktop_*": "allow" } } },
  }),
})
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
await copyFile(join(repo, "src-tauri/src/desktop/session_plugin.js"), join(profile, "desktop-session.js"))
const child = spawn(resolve(repo, "src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe"), ["serve", "--hostname", "127.0.0.1", "--port", "0"], { env, cwd: profile, windowsHide: true, stdio: "pipe" })
let log = "", engineOrigin
for (const output of [child.stdout, child.stderr]) output.on("data", (bytes) => { log = (log + bytes).slice(-6000); engineOrigin ||= log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] })
const headers = { Authorization: `Basic ${Buffer.from("opencode:qa-password").toString("base64")}`, "Content-Type": "application/json" }
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function api(method, path, body) {
  const response = await fetch(`${engineOrigin}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) })
  assert.ok(response.ok, `${path}: ${response.status}`)
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}
try {
  for (let n = 0; !engineOrigin && n < 100; n++) await delay(200)
  assert.ok(engineOrigin, log)
  const session = await api("POST", "/session", {})
  await api("POST", `/session/${session.id}/prompt_async`, { model: { providerID: "openai", modelID: "qa-model" }, agent: "escritorio", parts: [{ type: "text", text: "Read desktop status and report." }] })
  for (let n = 0; calls.length === 0 && n < 150; n++) await delay(200)
  assert.equal(calls.length, 1, `${log}\n${JSON.stringify(await api("GET", `/session/${session.id}/message`))}`)
  assert.deepEqual(calls[0].arguments._guillecode, { token: `cap-${session.id}`, run: 3 })
  assert.ok(bindings.includes(session.id))
  assert.ok(generations <= 3)
  console.log("Real engine → tool.execute.before → strict-schema MCP: authenticated session identity received")
  const team = await api("POST", "/session", { title: "Equipo · Lead", permission: [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "browser_*", pattern: "*", action: "allow" },
    { permission: "desktop_*", pattern: "*", action: "allow" },
  ] })
  await api("POST", `/session/${team.id}/prompt_async`, { model: { providerID: "openai", modelID: "qa-model" }, agent: "build", tools: { "*": false, browser_list_pages: true, desktop_status: false }, parts: [{ type: "text", text: "[GUILLECODE_TEAM_RUN] Inspect the assigned browser workspace." }] })
  for (let n = 0; calls.length < 2 && n < 150; n++) await delay(200)
  assert.equal(calls.length, 2, `${log}\n${JSON.stringify(await api("GET", `/session/${team.id}/message`))}`)
  assert.equal(calls[1].name, "list_pages")
  assert.deepEqual(calls[1].arguments._guillecode, { token: `cap-${team.id}`, run: 3 })
  assert.ok(bindings.includes(team.id))
  assert.deepEqual(await api("GET", "/permission"), [])
  const globalHistory = await api("GET", "/experimental/session?limit=100")
  assert.ok(globalHistory.some(s => s.id === session.id) && globalHistory.some(s => s.id === team.id))
  console.log("Team build session → explicit MCP tool map → browser tool executes with its authenticated session, despite normal build defaults denying PC/browser")
} finally {
  child.kill()
  await new Promise((done) => child.exitCode !== null ? done() : child.once("exit", done))
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
