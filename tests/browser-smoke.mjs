import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { createInterface } from "node:readline"

// --live checks the user's existing Chrome, after they enable/allow remote debugging.
// It only edits a new local test tab and closes that tab afterwards.
const live = process.argv.includes("--live")
const cli = join(process.env.LOCALAPPDATA, "com.guillecode.desktop", "browser-bridge", "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js")
const child = spawn(process.execPath, [cli, "--autoConnect", "--no-usage-statistics", "--no-performance-crux", "--category-memory=false", "--category-performance=false"], {
  env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "1" },
  windowsHide: true,
  stdio: "pipe",
})
let nextId = 0
let stderr = ""
const pending = new Map()
child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000) })
createInterface({ input: child.stdout }).on("line", (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const waiting = pending.get(message.id)
  if (!waiting) return
  clearTimeout(waiting.timer)
  pending.delete(message.id)
  if (message.error) waiting.reject(new Error(message.error.message))
  else waiting.resolve(message.result)
})
child.on("error", (error) => {
  for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(error) }
  pending.clear()
})
child.on("exit", () => {
  for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(`MCP exited: ${stderr}`)) }
  pending.clear()
})

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out. Allow the connection in Chrome if prompted.`)) }, 120000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

function text(result) {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? ""
}

async function call(name, args = {}) {
  const result = await request("tools/call", { name, arguments: args })
  assert.ok(!result.isError, text(result))
  return text(result)
}

function pageIds(output) {
  return [...output.matchAll(/^(\d+): /gm)].map((match) => Number(match[1]))
}

let testPage
try {
  const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guillecode-browser-smoke", version: "1.0.0" } })
  assert.ok(initialized.serverInfo)
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  const { tools } = await request("tools/list")
  for (const name of ["list_pages", "new_page", "close_page", "take_snapshot", "click", "fill_form", "evaluate_script"]) {
    assert.ok(tools.some((tool) => tool.name === name), `Missing tool: ${name}`)
  }
  assert.ok(tools.find((tool) => tool.name === "click").inputSchema.required.includes("pageId"), "Actions must be routed by pageId")
  console.log(JSON.stringify({ server: initialized.serverInfo.name, tools: tools.length, pageIdRouting: true, autoConnect: true }))
  if (live) {
    console.log("Chrome: enable chrome://inspect/#remote-debugging and click Allow if prompted.")
    const before = new Set(pageIds(await call("list_pages")))
    const html = '<!doctype html><title>GuilleCode browser test</title><label>Nombre de prueba<input id="nombre"></label><button onclick="document.getElementById(\'resultado\').textContent=document.getElementById(\'nombre\').value">Comprobar</button><p id="resultado"></p>'
    await call("new_page", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` })
    const created = pageIds(await call("list_pages")).filter((id) => !before.has(id))
    assert.equal(created.length, 1, "Expected one new test tab")
    testPage = created[0]
    const snapshot = await call("take_snapshot", { pageId: testPage, verbose: false })
    const input = snapshot.match(/uid=([\w_]+) textbox "Nombre de prueba"/)
    assert.ok(input, "The input must be accessible by uid")
    await call("fill_form", { pageId: testPage, elements: [{ uid: input[1], value: "GuilleCode browser OK" }] })
    const updated = await call("take_snapshot", { pageId: testPage, verbose: false })
    const button = updated.match(/uid=([\w_]+) button "Comprobar"/)
    assert.ok(button, "The button must be accessible by uid")
    await call("click", { pageId: testPage, uid: button[1] })
    const result = await call("evaluate_script", { pageId: testPage, function: "() => document.getElementById('resultado').textContent" })
    assert.ok(result.includes("GuilleCode browser OK"), "The click must update the real page")
    await call("close_page", { pageId: testPage })
    testPage = undefined
    const after = new Set(pageIds(await call("list_pages")))
    assert.ok([...before].every((id) => after.has(id)), "Existing user tabs must remain open")
    console.log(JSON.stringify({ connectedToExistingChrome: true, existingTabs: before.size, snapshot: true, fillForm: true, click: true, evaluate: true, testTabClosed: true }))
  }
} finally {
  if (testPage !== undefined) {
    try { await call("close_page", { pageId: testPage }) } catch { /* report the original failure */ }
  }
  child.kill()
  await new Promise((done) => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once("exit", done) })
}
