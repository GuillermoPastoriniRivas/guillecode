import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import assert from "node:assert/strict"
import { hasAccount } from "../src/lib/providers.ts"

// Fresh engine profile; no real credentials, projects, plugins or token-consuming requests.
const parent = join(process.env.LOCALAPPDATA, "Temp", "opencode")
const root = await mkdtemp(join(parent, "guillecode-byok-"))
const listener = createServer()
await new Promise((done) => listener.listen(0, "127.0.0.1", done))
const port = listener.address().port
await new Promise((done) => listener.close(done))
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
Object.assign(env, { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root,
  XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  OPENCODE_CONFIG_DIR: join(root, "config", "opencode"), OPENCODE_CONFIG_CONTENT: '{"enabled_providers":["openai","opencode","opencode-go"]}',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_SERVER_PASSWORD: "test-password",
})
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
const child = spawn(resolve("src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe"), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, cwd: root, windowsHide: true, stdio: "pipe" })
let output = ""
child.stdout.on("data", (b) => { output = (output + b).slice(-6000) })
child.stderr.on("data", (b) => { output = (output + b).slice(-6000) })
const headers = { Authorization: `Basic ${Buffer.from("opencode:test-password").toString("base64")}` }
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/global/health`, { headers }); ready = response.ok } catch {}
    if (ready) break
    await new Promise((done) => setTimeout(done, 500))
  }
  assert.equal(ready, true, `Engine did not start: ${output}`)
  const response = await fetch(`http://127.0.0.1:${port}/config/providers`, { headers })
  assert.equal(response.ok, true)
  const catalog = await response.json()
  console.log(JSON.stringify({ providerMetadata: catalog.providers.map((p) => ({ id: p.id, source: p.source, hasKey: !!p.options?.apiKey, keyIsPublic: p.options?.apiKey === "public", optionNames: Object.keys(p.options ?? {}) })) }))
  assert.equal(catalog.providers.filter(hasAccount).length, 0, "A fresh profile must not contain any connected account")
  console.log(JSON.stringify({ freshProfile: true, connectedAccounts: 0, providerSources: catalog.providers.map((p) => ({ id: p.id, source: p.source })) }))
  const oauth = await fetch(`http://127.0.0.1:${port}/provider/auth`, { headers }).then((r) => r.json())
  assert.ok(oauth.openai?.some((method) => method.type === "oauth"), "The bundled engine must offer ChatGPT OAuth without an OpenCode account")
  console.log("Bundled engine: fresh-profile and independent ChatGPT OAuth checks passed")
} finally {
  child.kill()
  await new Promise((done) => { if (child.exitCode !== null) done(); else child.once("exit", done) })
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
