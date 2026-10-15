import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
// @ts-expect-error Runtime plugin is shipped as JavaScript with the desktop app.
import { DesktopSession } from "../src-tauri/src/desktop/session_plugin.js"

test("desktop plugin binds actual session identity, overwrites model arguments and restores checkpoints", async () => {
  const requests: { session: string; peek: boolean }[] = []
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-capability")
    let body = ""
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ token: `token-${request.session}`, run: 7, task: {
      session: request.session, objective: "Completar reporte", status: "interrupted", inFlight: "Guardar",
      checkpoints: Array.from({ length: 100 }, (_, n) => ({ label: `Paso ${n}`, evidence: "comprobado" })),
    } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const previous = process.env.OPENCODE_CONFIG_CONTENT
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { desktop: {
    url: `http://127.0.0.1:${address.port}/mcp/desktop`, headers: { Authorization: "Bearer test-capability" },
  } } })
  try {
    const plugin = await DesktopSession()
    const output = { args: { ref: "e1", _guillecode: { token: "another-session", run: 999 } } }
    await plugin["tool.execute.before"]({ tool: "desktop_execute", sessionID: "s1" }, output)
    assert.deepEqual(output.args._guillecode, { token: "token-s1", run: 7 })
    await plugin["tool.execute.before"]({ tool: "browser_click", sessionID: "s2" }, output)
    assert.deepEqual(output.args._guillecode, { token: "token-s2", run: 7 })
    const count = requests.length
    await plugin["tool.execute.before"]({ tool: "read", sessionID: "s1" }, { args: {} })
    assert.equal(requests.length, count, "ordinary code tools must not contact desktop")
    await assert.rejects(plugin["tool.execute.before"]({ tool: "desktop_type" }, { args: {} }), /conversación/)
    const system = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]({ sessionID: "s1" }, system)
    assert.equal(requests.at(-1)?.peek, true)
    assert.match(system.system[0], /Guardar/)
    assert.match(system.system[0], /Paso 99/)
    assert.doesNotMatch(system.system[0], /Paso 0"/)
    assert.doesNotMatch(system.system[0], /token-s1/)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = previous
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
