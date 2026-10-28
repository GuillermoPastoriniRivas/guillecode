import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, realpathSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { createHash } from "node:crypto"

mkdirSync("test-results", { recursive: true })
const root = realpathSync(resolve("test-results"))
const fixture = mkdtempSync(join(root, "engine-integrity-"))
const source = resolve("src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe")
const installed = join(fixture, "opencode.exe")
const run = (...args) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("src-tauri/windows/verify-installed-engine.ps1"), "-InstallDir", fixture, ...args], { windowsHide: true, encoding: "utf8", timeout: 25000 })
try {
  writeFileSync(installed, readFileSync(source).subarray(0, 4096))
  assert.equal(run("-Mode", "Verify").status, 1, "A valid PE prefix must not hide truncated sections")
  assert.equal(run("-Mode", "Preflight", "-RequiredKiB", "1099511627776").status, 1, "Low disk space must stop installation before replacement")
  assert.equal(readFileSync(installed).length, 4096, "Preflight never mutates the installed engine")
  copyFileSync(source, installed)
  const expected = createHash("sha256").update(readFileSync(source)).digest("hex")
  const result = run("-Mode", "Verify")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Motor OpenCode verificado/)
  assert.equal(createHash("sha256").update(readFileSync(installed)).digest("hex"), expected)
  console.log("ENGINE INTEGRITY PASS: truncated engine rejected, disk shortage rejected before writes, complete installed engine executes --version unchanged")
} finally {
  assert.ok(realpathSync(fixture).startsWith(root + sep))
  rmSync(fixture, { recursive: true, force: true })
}
