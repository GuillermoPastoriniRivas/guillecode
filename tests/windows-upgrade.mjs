import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, rmSync, createReadStream } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { chromium } from "@playwright/test"

// Real NSIS + real Tauri updater. Only the fixture build accepts loopback HTTP.
// Separate identifier, install directory and XDG profile; no real user credentials.
if (process.platform !== "win32") throw new Error("Esta prueba requiere Windows")
const root = resolve(".")
mkdirSync(join(tmpdir(), "opencode"), { recursive: true })
// A failed run retains its disposable fixtures. GC_UPGRADE_FIXTURE can retry
// their runtime checks without rebuilding, provided application code is unchanged.
const reuse = process.env.GC_UPGRADE_FIXTURE
const dir = reuse ? resolve(reuse) : mkdtempSync(join(tmpdir(), "opencode", "guillecode-upgrade-"))
const fixture = reuse ? JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) : null
const identifier = fixture?.identifier ?? `com.guillecode.upgrade-test-${Date.now()}`
const binaryName = "guillecode-upgrade-test"
const productionConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
assert.equal(productionConfig.plugins.updater.windows.installMode, "quiet", "La prueba debe usar el modo silencioso de producción")
assert.equal(productionConfig.bundle.windows.nsis.installMode, "currentUser", "quiet requiere instalación por usuario")
const baseVersion = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version
const parts = baseVersion.split(".").map(Number)
const nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`
const installed = join(dir, "installed"), profile = join(dir, "profile")
mkdirSync(profile, { recursive: true })
let signature, updateInstaller, browser, appProcess, orphanEngine, unrelatedEngine, fixturePubkey
const fixtureKey = join(dir, "fixture.key")
let invalidSignature = false, failedDownload = false
const server = createServer((req, res) => {
  if (req.url === "/latest.json") {
    res.setHeader("Content-Type", "application/json")
    return res.end(JSON.stringify({ version: nextVersion, notes: "Prueba de actualización real", platforms: {
      "windows-x86_64": { url: `http://127.0.0.1:${server.address().port}/installer.exe`, signature: invalidSignature ? "Ym9ndXM=" : signature },
    } }))
  }
  if (req.url === "/installer.exe") {
    if (failedDownload) { res.writeHead(503); return res.end("simulated download failure") }
    res.setHeader("Content-Type", "application/octet-stream")
    createReadStream(updateInstaller).pipe(res)
    return
  }
  res.writeHead(404); res.end()
})
await new Promise((done) => server.listen(fixture?.serverPort ?? 0, "127.0.0.1", done))
const tcp = createTcpServer()
await new Promise((done) => tcp.listen(fixture?.cdpPort ?? 0, "127.0.0.1", done))
const cdpPort = tcp.address().port
await new Promise((done) => tcp.close(done))
writeFileSync(join(dir, "fixture.json"), JSON.stringify({ identifier, serverPort: server.address().port, cdpPort }))
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

function build(version) {
  const overlay = join(dir, "qa.json")
  writeFileSync(overlay, JSON.stringify({
    productName: "guillecode-upgrade-test", mainBinaryName: binaryName, identifier, version,
    app: { windows: productionConfig.app.windows.map((window) => ({ ...window, devtools: true })) },
    plugins: { updater: { pubkey: fixturePubkey, endpoints: [`http://127.0.0.1:${server.address().port}/latest.json`], dangerousInsecureTransportProtocol: true } },
  }))
  execFileSync(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--ci", "--config", overlay, "--", "--locked"], {
    cwd: root, stdio: "inherit", env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: fixtureKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
  })
  const nsis = resolve("src-tauri/target/release/bundle/nsis")
  const file = readdirSync(nsis).find((name) => name.includes(`_${version}_`) && name.startsWith("guillecode-upgrade-test") && name.endsWith("-setup.exe"))
  assert.ok(file, `Falta instalador QA ${version}`)
  const destination = join(dir, `${version}-setup.exe`)
  copyFileSync(join(nsis, file), destination)
  copyFileSync(join(nsis, `${file}.sig`), `${destination}.sig`)
  return destination
}

async function connect() {
  let lastError
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
      if (response.ok) {
        const connection = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
        const context = connection.contexts()[0]
        const page = context.pages().find((p) => !p.url().startsWith("devtools:")) ?? await context.waitForEvent("page", { timeout: 5000 })
        await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, { timeout: 15000 })
        return { connection, page }
      }
    } catch (error) { lastError = error }
    await delay(500)
  }
  throw new Error(`El WebView de la app instalada no arrancó (exit=${appProcess?.exitCode}): ${lastError?.message ?? "sin respuesta CDP"}`)
}

const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: profile, LOCALAPPDATA: profile,
  XDG_DATA_HOME: join(profile, "data"), XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
  OPENCODE_CONFIG_DIR: join(profile, "config"), OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`, WEBVIEW2_USER_DATA_FOLDER: join(profile, "webview"),
}
// Do not inherit any provider/API credentials into the isolated engine.
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|TAURI_SIGNING/.test(key)) delete env[key]
mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true })
const invoke = (page, command) => page.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command)
// Only processes started from this QA install directory; never the user's own app.
function killInstalled() {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:GC_QA_DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }"],
      { env: { ...process.env, GC_QA_DIR: dir + "\\" }, stdio: "ignore" })
  } catch {}
}
async function engineReady(page) {
  return page.evaluate(async () => {
    const s = await window.__TAURI_INTERNALS__.invoke("server_config")
    const headers = { Authorization: `Basic ${btoa(`${s.username}:${s.password}`)}` }
    for (let attempt = 0; attempt < 120; attempt++) {
      try { if ((await fetch(`${s.url}/global/health`, { headers })).ok) return true } catch {}
      await new Promise((done) => setTimeout(done, 500))
    }
    throw new Error("El motor incorporado no llegó a estar sano")
  })
}
async function independentEngine(folder) {
  const tcp = createTcpServer()
  await new Promise((done) => tcp.listen(0, "127.0.0.1", done))
  const port = tcp.address().port
  await new Promise((done) => tcp.close(done))
  const child = spawn(join(folder, "opencode.exe"), ["serve", "--port", String(port)], { env, windowsHide: true, stdio: "ignore" })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("El motor de prueba terminó antes de iniciar")
    try { if ((await fetch(`http://127.0.0.1:${port}/global/health`)).ok) return child } catch {}
    await delay(500)
  }
  throw new Error("El motor independiente de prueba no arrancó")
}
try {
  // Disposable QA signing key: never depend on or expose the release key.
  if (!reuse) execFileSync(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "signer", "generate", "--ci", "--write-keys", fixtureKey], { stdio: "pipe" })
  fixturePubkey = readFileSync(`${fixtureKey}.pub`, "utf8").trim()
  console.log(`[upgrade] compilando instalador QA ${nextVersion}…`)
  updateInstaller = reuse ? join(dir, `${nextVersion}-setup.exe`) : build(nextVersion)
  signature = readFileSync(`${updateInstaller}.sig`, "utf8").trim()
  console.log(`[upgrade] compilando instalador QA ${baseVersion}…`)
  const initialInstaller = reuse ? join(dir, `${baseVersion}-setup.exe`) : build(baseVersion)
  console.log(`[upgrade] instalando ${baseVersion} en un directorio aislado…`)
  // NSIS /D must be last. Current-user QA install never requires administrator.
  const installer = spawn(initialInstaller, ["/S", `/D=${installed}`], { env, windowsHide: true, stdio: "ignore" })
  const code = await new Promise((done) => installer.once("exit", done))
  assert.equal(code, 0, "Instalación inicial falló")
  const executable = join(installed, `${binaryName}.exe`)
  assert.ok(existsSync(executable), "Falta ejecutable instalado")
  console.log(`[upgrade] abriendo ${baseVersion} y esperando el motor…`)
  appProcess = spawn(executable, ["--hidden"], { env, windowsHide: true, stdio: "ignore" })
  let connected = await connect()
  browser = connected.connection
  let page = connected.page
  assert.equal(await invoke(page, "plugin:app|version"), baseVersion)
  await engineReady(page)
  await page.evaluate(() => localStorage.setItem("upgrade-test-marker", "preserved"))
  const dataDir = join(profile, identifier)
  mkdirSync(dataDir, { recursive: true })
  const marker = join(dataDir, "upgrade-marker.txt")
  writeFileSync(marker, "preserved")
  // Create a real, empty conversation without invoking any AI model.
  const sessionId = await page.evaluate(async () => {
    const s = await window.__TAURI_INTERNALS__.invoke("server_config")
    const response = await fetch(`${s.url}/session`, { method: "POST", headers: {
      Authorization: `Basic ${btoa(`${s.username}:${s.password}`)}`, "Content-Type": "application/json",
      "x-opencode-directory": s.worktree,
    }, body: JSON.stringify({ title: "upgrade-test-preserved" }) })
    if (!response.ok) throw new Error(`Session creation failed: ${response.status}`)
    return (await response.json()).id
  })
  console.log(`[upgrade] conversación de prueba creada; validando descarga y firma…`)

  failedDownload = true
  await invoke(page, "update_check")
  await assert.rejects(invoke(page, "update_download"), /503|Network|network/i)
  failedDownload = false
  invalidSignature = true
  await invoke(page, "update_check")
  await assert.rejects(invoke(page, "update_download"))
  await assert.rejects(invoke(page, "update_install"), /Descargá/)
  assert.equal(await invoke(page, "plugin:app|version"), baseVersion)

  invalidSignature = false
  await invoke(page, "update_check")
  await invoke(page, "update_download")
  // The signed, downloaded installer is retained while an unrelated check runs.
  assert.equal((await invoke(page, "update_check")).version, nextVersion)
  // Simulate an orphan left by an older app, outside the tracked engine tree.
  // A same-name engine in another installation must survive the cleanup.
  const otherInstall = join(dir, "other-install")
  mkdirSync(otherInstall, { recursive: true })
  copyFileSync(join(installed, "opencode.exe"), join(otherInstall, "opencode.exe"))
  orphanEngine = await independentEngine(installed)
  unrelatedEngine = await independentEngine(otherInstall)
  console.log(`[upgrade] instalando ${nextVersion} y esperando el relanzamiento del instalador…`)
  const oldExit = new Promise((done) => appProcess.once("exit", done))
  await invoke(page, "update_install").catch(() => {}) // Windows exits before IPC resolves.
  await Promise.race([oldExit, delay(60000).then(() => { throw new Error("La app anterior no se cerró") })])
  await browser.close().catch(() => {})
  browser = null
  await delay(3000)
  connected = await connect()
  browser = connected.connection
  page = connected.page
  // This must be the installer-launched new process, not a manual restart.
  assert.equal(await invoke(page, "plugin:app|version"), nextVersion)
  assert.notEqual(orphanEngine.exitCode, null, "Quedó abierto el motor huérfano de la instalación actualizada")
  assert.equal(unrelatedEngine.exitCode, null, "El instalador cerró un motor de otra instalación")
  await engineReady(page)
  assert.equal(await page.evaluate(() => localStorage.getItem("upgrade-test-marker")), "preserved")
  assert.equal(readFileSync(marker, "utf8"), "preserved")
  const persistedSession = await page.evaluate(async (sessionId) => {
    const s = await window.__TAURI_INTERNALS__.invoke("server_config")
    const response = await fetch(`${s.url}/session/${sessionId}`, { headers: {
      Authorization: `Basic ${btoa(`${s.username}:${s.password}`)}`, "x-opencode-directory": s.worktree,
    } })
    return response.ok ? (await response.json()).title : null
  }, sessionId)
  assert.equal(persistedSession, "upgrade-test-preserved")
  console.log(`UPGRADE PASS: ${baseVersion} → ${nextVersion}, actualización silenciosa y relanzamiento; motor huérfano liberado sin cerrar otros motores; perfil, preferencias y conversación conservados; HTTP fallido y firma inválida rechazados`)
  await invoke(page, "app_quit").catch(() => {})
  await delay(1500)
} catch (error) {
  console.error("[upgrade] FALLÓ:", error?.stack ?? error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  killInstalled()
  await delay(1500)
  const uninstaller = join(installed, "uninstall.exe")
  if (existsSync(uninstaller)) {
    try {
      const uninstall = spawn(uninstaller, ["/S"], { env, windowsHide: true, stdio: "ignore" })
      await new Promise((done) => uninstall.once("exit", done))
    } catch {}
  }
  try { server.closeAllConnections(); await new Promise((done) => server.close(done)) } catch {}
  killInstalled()
  await delay(500)
  if (process.exitCode) console.warn(`[upgrade] fixture conservado para diagnóstico: ${dir}`)
  else try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) } catch (error) { console.warn(`[upgrade] no se pudo limpiar ${dir}: ${error.message}`) }
}
