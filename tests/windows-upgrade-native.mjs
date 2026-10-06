import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:net"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { once } from "node:events"

// Run against signed QA fixtures produced by windows-upgrade.mjs. This checks
// NSIS replacement/relaunch without CDP; it does NOT exercise the in-app updater.
if (process.platform !== "win32" || !process.argv[2]) throw new Error("Uso: node tests/windows-upgrade-native.mjs carpeta-de-fixtures-QA")
const dir = resolve(process.argv[2])
const { identifier } = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"))
assert.match(identifier, /^com\.guillecode\.upgrade-test-\d+$/)
const baseVersion = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version
const [major, minor, patch] = baseVersion.split(".").map(Number)
const nextVersion = `${major}.${minor}.${patch + 1}`
const installed = join(dir, "native-installed"), profile = join(dir, "native-profile")
const appData = join(profile, "AppData", "Roaming", identifier)
mkdirSync(appData, { recursive: true })
const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: profile, LOCALAPPDATA: profile,
  XDG_DATA_HOME: join(profile, "data"), XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
  OPENCODE_CONFIG_DIR: join(profile, "config"), OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  WEBVIEW2_USER_DATA_FOLDER: join(profile, "webview"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "",
}
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|TAURI_SIGNING/.test(key)) delete env[key]
mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true })
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function port() {
  const server = createServer()
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const result = server.address().port
  await new Promise((done) => server.close(done))
  return result
}
const remotePort = await port(), token = randomUUID()
writeFileSync(join(appData, "remote.json"), JSON.stringify({ enabled: true, port: remotePort, token }))
const prefs = JSON.stringify({ upgradeNativeMarker: "preserved" })
writeFileSync(join(appData, "remote_prefs.json"), prefs)
const headers = { Authorization: `Bearer ${token}`, "x-opencode-directory": profile, "Content-Type": "application/json" }
async function hub(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${remotePort}${path}`, { ...options, headers, signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Hub HTTP ${response.status}`)
  return response.json()
}
async function healthy() {
  for (let i = 0; i < 120; i++) {
    try { if ((await hub("/oc/global/health")).healthy) return } catch {}
    await delay(500)
  }
  throw new Error("El hub/motor de la instalación QA no quedó disponible")
}
function processes() {
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:GC_QA_DIR, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{ pid=$_.ProcessId; path=$_.ExecutablePath } })"], {
    encoding: "utf8", env: { ...process.env, GC_QA_DIR: installed + "\\" },
  }))
}
async function installer(version, args) {
  const child = spawn(join(dir, `${version}-setup.exe`), args, { env, windowsHide: true, stdio: "ignore" })
  let timer
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("NSIS no terminó en 120 segundos")), 120000) })
    const result = await Promise.race([once(child, "exit"), timeout])
    assert.equal(result[0], 0, "NSIS rechazó la instalación")
  } finally { clearTimeout(timer) }
}
let app, orphan, unrelated
try {
  console.log("[native-upgrade] instalación inicial aislada…")
  await installer(baseVersion, ["/S", `/D=${installed}`])
  const executable = join(installed, "guillecode-upgrade-test.exe")
  app = spawn(executable, ["--hidden"], { env, windowsHide: true, stdio: "ignore" })
  await healthy()
  const session = await hub("/oc/session", { method: "POST", body: JSON.stringify({ title: "native-upgrade-preserved" }) })
  // Let the frontend normalize defaults, then compare the actual preferences.
  await delay(1500)
  const prefsBefore = JSON.parse(readFileSync(join(appData, "remote_prefs.json"), "utf8"))
  assert.equal(prefsBefore.upgradeNativeMarker, "preserved")
  const other = join(dir, "native-other")
  mkdirSync(other, { recursive: true })
  copyFileSync(join(installed, "opencode.exe"), join(other, "opencode.exe"))
  orphan = spawn(join(installed, "opencode.exe"), ["serve", "--port", String(await port())], { env, windowsHide: true, stdio: "ignore" })
  unrelated = spawn(join(other, "opencode.exe"), ["serve", "--port", String(await port())], { env, windowsHide: true, stdio: "ignore" })
  await delay(1000)
  console.log("[native-upgrade] actualización /S /UPDATE /R con app y motor huérfano abiertos…")
  await installer(nextVersion, ["/S", "/UPDATE", "/R", "/ARGS", "--hidden"])
  await healthy()
  assert.notEqual(app.exitCode, null, "La app anterior no se cerró")
  assert.notEqual(orphan.exitCode, null, "Quedó abierto el motor huérfano")
  assert.equal(unrelated.exitCode, null, "Se cerró un motor de otra instalación")
  const version = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Diagnostics.FileVersionInfo]::GetVersionInfo($env:GC_QA_EXE).ProductVersion"], { encoding: "utf8", env: { ...process.env, GC_QA_EXE: executable } }).trim()
  assert.equal(version, nextVersion)
  assert.equal((await hub(`/oc/session/${session.id}`)).title, "native-upgrade-preserved")
  assert.deepEqual(JSON.parse(readFileSync(join(appData, "remote_prefs.json"), "utf8")), prefsBefore)
  assert.ok(processes().some((p) => p.path === executable && p.pid !== app.pid), "NSIS no relanzó la nueva app")
  console.log(`NSIS UPGRADE PASS: ${baseVersion} → ${nextVersion}; modo silencioso, motor huérfano liberado, otro motor conservado, relanzamiento automático y conversación/preferencias preservadas`)
} finally {
  for (const process of processes()) {
    try { execFileSync("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], { stdio: "ignore" }) } catch {}
  }
  if (unrelated?.exitCode === null) {
    try { execFileSync("taskkill.exe", ["/PID", String(unrelated.pid), "/T", "/F"], { stdio: "ignore" }) } catch {}
  }
  if (existsSync(join(installed, "uninstall.exe"))) {
    const uninstall = spawn(join(installed, "uninstall.exe"), ["/S"], { env, windowsHide: true, stdio: "ignore" })
    await once(uninstall, "exit")
  }
}
