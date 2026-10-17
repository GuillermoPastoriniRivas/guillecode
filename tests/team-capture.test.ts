import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { localUrl } from "../src-tauri/src/teams/capture.mjs"

test("visual evidence rejects non-local and credential-bearing targets", () => {
  for (const url of ["https://example.com", "http://localhost.evil.test", "file:///C:/secret", "http://u:p@localhost", "http://localhost/?token=abc"]) assert.throws(() => localUrl(url))
  assert.equal(localUrl("http://127.0.0.1:1234/app").hostname, "127.0.0.1")
})

test("isolated browser captures real before/after PNGs, executes steps and masks personal data", { timeout: 90000 }, async () => {
  const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync)
  assert.ok(browser, "Install Chrome/Edge to run the real visual evidence test")
  let after = false
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(`<!doctype html><title>Flujo de evidencia</title><style>body{font:24px system-ui;background:${after ? "#142c24" : "#291b22"};color:white;padding:40px}main{max-width:700px}</style><main><h1>${after ? "Módulo implementado" : "Módulo todavía ausente"}</h1><input id="name"><button id="submit" onclick="document.getElementById('result').textContent=document.getElementById('name').value">Comprobar</button><p id="result"></p><p data-private>PRIVATE TEST VALUE</p></main>`)
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const dir = await mkdtemp(join(tmpdir(), "team-evidence-test-"))
  const capture = async (name: string) => {
    const output = join(dir, name + ".png")
    const child = spawn(process.execPath, [resolve("src-tauri/src/teams/capture.mjs")], { windowsHide: true, stdio: "pipe" })
    let raw = "", errors = ""
    child.stdout.on("data", (b) => { raw += b })
    child.stderr.on("data", (b) => { errors += b })
    child.stdin.end(JSON.stringify({ browser, output, target: { url: `http://127.0.0.1:${address.port}/app`, width: 960, height: 640, actions: [{ kind: "fill", selector: "#name", value: "private@example.test" }, { kind: "click", selector: "#submit" }, { kind: "wait", selector: "#result" }], maskSelectors: [] } }))
    const code = await new Promise((done) => child.once("exit", done))
    assert.equal(code, 0, raw + errors)
    const report = JSON.parse(raw)
    assert.equal(report.status, "captured")
    assert.equal(report.steps.length, 3)
    assert.equal(report.httpStatus, 200)
    assert.ok(!report.text.includes("PRIVATE TEST VALUE") && !report.text.includes("private@example.test"))
    const bytes = await readFile(output)
    assert.equal(bytes.readUInt32BE(16), 960)
    assert.equal(bytes.readUInt32BE(20), 640)
    await mkdir("test-results/real-captures", { recursive: true })
    const { copyFile } = await import("node:fs/promises")
    await copyFile(output, `test-results/real-captures/${name}.png`)
    return { hash: createHash("sha256").update(bytes).digest("hex"), report }
  }
  try {
    const before = await capture("before")
    after = true
    const end = await capture("after")
    assert.notEqual(before.hash, end.hash)
    assert.ok(before.report.text.includes("todavía ausente"))
    assert.ok(end.report.text.includes("implementado"))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    assert.ok(dir.startsWith(join(tmpdir(), "team-evidence-test-")))
    await rm(dir, { recursive: true, force: true })
  }
})
