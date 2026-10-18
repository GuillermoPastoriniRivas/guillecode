import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { createServer as tcpServer } from "node:net"
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

// A real bundled OpenCode and the real Rust scheduler edit a disposable folder.
// Only inference is deterministic/loopback; no account, paid tokens or user repo.
const noGit = process.argv.includes("--no-git")
const profile = await mkdtemp(join(tmpdir(), "guillecode-teams-"))
const repo = join(profile, "repo")
await mkdir(repo)
await writeFile(join(repo, "user.txt"), "user work\n")
let indexBefore
if (!noGit) {
  execFileSync("git", ["init", repo], { windowsHide: true, stdio: "ignore" })
  execFileSync("git", ["-C", repo, "add", "user.txt"], { windowsHide: true })
  indexBefore = execFileSync("git", ["-C", repo, "diff", "--cached"], { windowsHide: true }).toString()
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const nodeCommand = `& '${process.execPath.replaceAll("'", "''")}'`
const commands = { backend: `${nodeCommand} -e "process.exit(require('fs').existsSync('backend.txt') ? 0 : 1)"`, frontend: `${nodeCommand} -e "process.exit(require('fs').existsSync('frontend.txt') ? 0 : 1)"` }
let reviews = 0
const models = new Set()
const mock = createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  if(request.url==='/capture-recovery'){
    try{await readFile(join(repo,'capture-ready.flag'))}catch{response.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});return response.end('<h1>Aplicación aún no disponible</h1>')}
  }
  if(request.url==='/app'||request.url==='/capture-recovery'){
    const content=await Promise.all(['backend','frontend'].map(async(role)=>{try{return await readFile(join(repo,`${role}.txt`),'utf8')}catch{return 'todavía ausente'}}))
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'})
    return response.end(`<!doctype html><title>Resultado real del equipo</title><style>body{font:24px system-ui;padding:40px;background:#111827;color:#e5e7eb}article{padding:20px;margin:12px;background:#1f2937}</style><main><h1>Módulos del proyecto de prueba</h1><article>Backend: ${content[0]}</article><article>Frontend: ${content[1]}</article></main>`)
  }
  if (!request.url?.endsWith("/responses")) return response.end("{}")
  const body = JSON.parse(raw)
  models.add(body.model)
  const text = JSON.stringify(body.input)
  const latestUserPrompt = JSON.stringify([...body.input].reverse().find((item) => item.role === "user") ?? body.input.at(-1) ?? "")
  const leadPhase = [
    ["plan", "Actuás como Team Lead."],
    ["review", "Sos el Lead revisor"],
    ["closeout", "Sos el Lead de cierre"],
  ].map(([phase, marker]) => [phase, latestUserPrompt.indexOf(marker)]).filter(([, index]) => index >= 0).sort((a, b) => a[1] - b[1])[0]?.[0]
  let item
  const message = (value) => ({ type: "message", id: `msg-${Date.now()}`, role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }], status: "completed" })
  if (["qa-lead", "qa-invalid-review"].includes(body.model)) {
    if (leadPhase === "closeout") {
      item = message({status:"approved",summary:"Objetivo completo y comandos observados verificados",criteriaSatisfied:true,tasks:[]})
    } else if (leadPhase === "review") {
      reviews++
      item = body.model === "qa-invalid-review" ? message({status:"invalid"}) : message({ status: reviews === 1 ? "changes_requested" : "approved", summary: reviews === 1 ? "Corregir backend: la versión debe ser 2" : "Criterios y comprobación satisfechos", criteriaSatisfied: reviews !== 1 })
    } else {
      item = message({ tasks: ["backend", "frontend"].map((role) => ({ id: role, title: `Crear ${role}`, objective: `Crear ${role}.txt con versión 2`, assignedAgentId: role, repository: repo, dependencies: [], expectedFiles: [`${role}.txt`], acceptanceCriteria: ["Archivo con versión 2", "Comprobación ejecutada"] })) })
    }
  } else {
    const role = body.model === "qa-backend" ? "backend" : "frontend"
    const outputs = body.input.filter((i) => i.type === "function_call_output")
    if (outputs.length >= 3) item = message({ status: "completed", summary: `Implementado ${role}; comprobación ejecutada`, checks: [commands[role]], limitations: [] })
    else {
      const name = outputs.length === 0 ? "read" : outputs.length === 1 ? "write" : "bash"
      const args = name === "read" ? {filePath:join(repo,"user.txt")} : name === "write" ? { filePath: join(repo, `${role}.txt`), content: `version ${role === "backend" && reviews === 0 ? 1 : 2}\n` } : { command: commands[role], description: "Verificar archivo generado", timeout: 10000 }
      assert.ok(body.tools.some((t) => t.name === name), `worker missing ${name}: ${body.tools.map((t) => t.name).join(",")}`)
      item = { type: "function_call", id: `fc-${Date.now()}`, call_id: `call-${Date.now()}`, name, arguments: JSON.stringify(args), status: "completed" }
    }
  }
  const events = [
    { type: "response.created", response: { id: "resp-qa", model: body.model, created_at: 0 } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", content: [], status: "in_progress" } },
    ...(item.type === "function_call" ? [
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
    ] : [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-qa", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3 } } },
  ]
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))
})
await new Promise((done) => mock.listen(0, "127.0.0.1", done))
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
Object.assign(env, {
  USERPROFILE: profile, HOME: profile, APPDATA: profile, LOCALAPPDATA: profile,
  XDG_DATA_HOME: join(profile, "data"), XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
  OPENCODE_CONFIG_DIR: join(profile, "config", "opencode"), OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_SERVER_PASSWORD: "qa-password",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["openai"], provider: { openai: { options: { apiKey: "qa-fake-key", baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: Object.fromEntries(["qa-lead", "qa-backend", "qa-frontend", "qa-invalid-review"].map((id) => [id, { name: id, limit: { context: 200000, output: 16000 } }])) } }, agent: { title: { disable: true }, summary: { disable: true } } }),
})
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
const reserve=tcpServer()
await new Promise((done)=>reserve.listen(0,"127.0.0.1",done))
const enginePort=reserve.address().port
await new Promise((done)=>reserve.close(done))
const engine = spawn(resolve("src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(enginePort)], { env, cwd: repo, windowsHide: true, stdio: "pipe" })
let log = "", origin
for (const stream of [engine.stdout, engine.stderr]) stream.on("data", (b) => { log = (log + b).slice(-12000); origin ||= log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] })
try {
  for (let n = 0; !origin && n < 100; n++) await delay(200)
  assert.ok(origin, log)
  const cargo = spawn("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--release", "--lib", "--features", "desktop-e2e", "teams::integration::native_team_end_to_end", "--", "--ignored", "--nocapture", "--test-threads=1"], { env: { ...process.env, GUILLE_TEAM_TEST_ENGINE: origin, GUILLE_TEAM_TEST_REPO: repo,GUILLE_TEAM_TEST_NO_GIT:noGit?'1':'0',GUILLE_TEAM_TEST_CAPTURE_URL:`http://127.0.0.1:${mock.address().port}/app`,GUILLE_TEAM_TEST_ARTIFACTS:resolve(noGit?'test-results/native-team-evidence-no-git':'test-results/native-team-evidence') }, windowsHide: true, stdio: "inherit" })
  const code = await new Promise((done) => cargo.once("exit", done))
  assert.equal(code, 0, `Native runner failed\n${log}`)
  assert.equal(await readFile(join(repo, "backend.txt"), "utf8"), "version 2\n")
  assert.equal(await readFile(join(repo, "frontend.txt"), "utf8"), "version 2\n")
  if (noGit) await assert.rejects(() => stat(join(repo, ".git")), { code: "ENOENT" })
  else assert.equal(execFileSync("git", ["-C", repo, "diff", "--cached"], { windowsHide: true }).toString(), indexBefore)
  assert.deepEqual([...models].sort(), ["qa-backend", "qa-frontend", "qa-invalid-review", "qa-lead"])
  assert.equal(reviews, 8)
  console.log(`Verified: native planning → distinct worker models → real file writes + commands → Lead correction → immutable evidence → awaiting manual QA; ${noGit ? "folder remained Git-free" : "pre-existing Git index intact"}.`)
} finally {
  engine.kill()
  await new Promise((done) => engine.exitCode !== null ? done() : engine.once("exit", done))
  mock.closeAllConnections()
  await new Promise((done) => mock.close(done))
  // profile was created by mkdtemp under the OS temp directory above.
  assert.ok(profile.startsWith(join(tmpdir(), "guillecode-teams-")))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
