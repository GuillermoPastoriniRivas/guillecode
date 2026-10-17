import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createReadStream, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// Native Tauri commands + mandatory signature verification, without WebView/CDP.
// Signed disposable installers come from windows-upgrade.mjs --build-only.
assert.equal(process.platform, "win32")
assert.ok(process.argv[2], "Indicá la carpeta de fixtures QA firmados")
const dir = resolve(process.argv[2])
const fixture = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"))
assert.match(fixture.identifier, /^com\.guillecode\.upgrade-test-\d+$/)
const installer = join(dir, `${fixture.nextVersion}-setup.exe`)
const signature = readFileSync(`${installer}.sig`, "utf8").trim()
let mode = "error"
const server = createServer((req, res) => {
  if (req.url.startsWith("/mode/")) { mode = req.url.slice(6); return res.end("ok") }
  if (req.url === "/latest.json") {
    res.setHeader("Content-Type", "application/json")
    return res.end(JSON.stringify({ version: fixture.nextVersion, platforms: {
      "windows-x86_64": { url: `http://127.0.0.1:${server.address().port}/installer.exe`, signature: mode === "invalid" ? "Ym9ndXM=" : signature },
    } }))
  }
  if (req.url === "/installer.exe") {
    if (mode === "error") { res.writeHead(503); return res.end("fixture download failure") }
    return createReadStream(installer).pipe(res)
  }
  res.writeHead(404); res.end()
})
await new Promise(done => server.listen(0, "127.0.0.1", done))
try {
  const test = spawn("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--release", "--locked", "--lib", "updates::tests::native_signed_download", "--", "--ignored", "--exact", "--nocapture"], {
    windowsHide: true, stdio: "inherit", env: { ...process.env,
      GUILLE_UPDATER_TEST_URL: `http://127.0.0.1:${server.address().port}`,
      GUILLE_UPDATER_TEST_PUBLIC_KEY: readFileSync(join(dir, "fixture.key.pub"), "utf8").trim(),
      GUILLE_UPDATER_TEST_VERSION: fixture.nextVersion,
    },
  })
  assert.equal(await new Promise(done => test.once("exit", done)), 0)
  console.log("NATIVE UPDATER PASS: HTTP failure and invalid signature rejected; valid signed installer verified; downloaded bytes retained across update checks")
} finally {
  server.closeAllConnections()
  await new Promise(done => server.close(done))
}
