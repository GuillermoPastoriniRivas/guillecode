import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { once } from "node:events"

if (process.platform !== "win32") throw new Error("Esta prueba requiere Windows")
const temp = join(tmpdir(), "opencode")
mkdirSync(temp, { recursive: true })
const dir = mkdtempSync(join(temp, "guillecode-cleanup-"))
const installed = join(dir, "Guille's instalación"), other = join(dir, "another-install")
const script = resolve("src-tauri/windows/stop-installed-engine.ps1")
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const children = []

async function cleanup(folder) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InstallDir", folder], { windowsHide: true, stdio: "pipe" })
  let stderr = ""
  child.stderr.on("data", (data) => { stderr += data })
  const [code] = await once(child, "exit")
  return { code, stderr }
}

try {
  assert.equal((await cleanup(installed)).code, 0, "Una instalación nueva no necesita cerrar el motor")
  for (const folder of [installed, other]) {
    mkdirSync(folder)
    // A real, locked executable named opencode.exe, with its own child tree.
    copyFileSync(join(process.env.SystemRoot, "System32/cmd.exe"), join(folder, "opencode.exe"))
    children.push(spawn(join(folder, "opencode.exe"), ["/d", "/c", "ping -t 127.0.0.1 >nul"], { windowsHide: true, stdio: "ignore" }))
  }
  await delay(500)
  assert.throws(() => openSync(join(installed, "opencode.exe"), "r+"), "Windows debe bloquear el ejecutable en uso")
  const targetExit = once(children[0], "exit")
  const result = await cleanup(installed)
  assert.equal(result.code, 0, result.stderr)
  await Promise.race([targetExit, delay(5000).then(() => { throw new Error("El motor no terminó") })])
  assert.equal(children[1].exitCode, null, "El motor de otra instalación debe seguir abierto")
  closeSync(openSync(join(installed, "opencode.exe"), "r+"))

  // A lock owned by another application cannot be resolved by killing engines.
  // The hook must fail rather than let NSIS skip the engine silently.
  const blockerScript = join(dir, "block.ps1")
  writeFileSync(blockerScript, '$file = [IO.File]::Open($env:GC_LOCK_FILE, "Open", "ReadWrite", "None"); [Console]::WriteLine("locked"); Start-Sleep -Seconds 30; $file.Dispose()')
  const blocker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", blockerScript], {
    windowsHide: true, stdio: "pipe", env: { ...process.env, GC_LOCK_FILE: join(installed, "opencode.exe") },
  })
  children.push(blocker)
  await once(blocker.stdout, "data")
  const blocked = await cleanup(installed)
  assert.equal(blocked.code, 1, "No debe continuar la instalación si el archivo sigue bloqueado")
  console.log("INSTALLER CLEANUP PASS: motor y árbol cerrados; rutas con espacios/apóstrofes/acentos; otros motores conservados; archivo aún bloqueado rechaza instalación")
} finally {
  for (const child of children) {
    if (child.exitCode !== null) continue
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    await once(killer, "exit")
  }
  await delay(500)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
