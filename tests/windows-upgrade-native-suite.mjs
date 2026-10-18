import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs"
import { resolve, sep } from "node:path"
import { tmpdir } from "node:os"

async function run(file, args = [], env = process.env) {
  const child = spawn(process.execPath, [file, ...args], { env, windowsHide: true, stdio: "inherit" })
  assert.equal(await new Promise(done => child.once("exit", done)), 0, file)
}
mkdirSync("test-results", { recursive: true })
await run("tests/windows-installer-cleanup.mjs")
const report = resolve("test-results/upgrade-native-fixture.json")
let directory = process.argv[2] ? resolve(process.argv[2]) : null
if (!directory) {
  await run("tests/windows-upgrade.mjs", ["--build-only"], { ...process.env, GC_UPGRADE_FIXTURE_OUTPUT: report })
  directory = JSON.parse(readFileSync(report, "utf8")).directory
}
await run("tests/windows-updater-download.mjs", [directory])
await run("tests/windows-upgrade-native.mjs", [directory])
console.log("NATIVE UPGRADE SUITE PASS: signed native download + actual NSIS replacement/relaunch/preservation")
// Retain explicitly reused fixtures; remove only the suite's own generated QA tree.
if (!process.argv[2]) {
  const resolved = resolve(directory)
  assert.ok(resolved.toLowerCase().startsWith((realpathSync(resolve(tmpdir(), "opencode")) + sep + "guillecode-upgrade-").toLowerCase()))
  rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
