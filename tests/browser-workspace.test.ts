import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Workspaces, install } from "../src-tauri/src/desktop/browser_workspace.mjs"

function page(id: number, windowId: number, target = `t${id}`) {
  return { id, pptrPage: { url: () => `https://test/${id}`,
    createCDPSession: async () => ({ send: async (name: string) => name === "Target.getTargetInfo" ? { targetInfo: { targetId: target } } : { windowId }, detach: async () => {} }) } }
}

test("Chrome assignment rejects foreign tabs, shared windows and recycled window IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-workspace-"))
  try {
    const file = pathToFileURL(join(dir, "workspaces.json"))
    const first = page(1, 100), second = page(2, 100), foreign = page(3, 200)
    let pages = [first, second, foreign]
    const context = { createPagesSnapshot: async () => {}, getPages: () => pages, selectPage: () => {} }
    const ws = new Workspaces(file)
    await ws.scope(context, { session: "a", action: "assign", pageId: 1 })
    await assert.rejects(ws.scope(context, { session: "b", action: "assign", pageId: 2 }), /otra conversación/)
    const scoped = await ws.scope(context, { session: "a" })
    assert.deepEqual(scoped.getPages(), [first, second])
    assert.throws(() => scoped.getPageById(3), /no pertenece/)
    scoped.selectPage(second)
    assert.equal(scoped.getSelectedMcpPage(), second)
    await assert.rejects(scoped.newPage(true, "isolated"), /compartido/)
    pages = [first, foreign]
    await scoped.createPagesSnapshot()
    await assert.rejects(scoped.closePage(1), /última pestaña/)
    pages = [page(4, 100, "recycled-window"), foreign]
    await assert.rejects(scoped.createPagesSnapshot(), /cerró/)
    await assert.rejects(ws.scope(context, { session: "a" }), /sin ventana asignada/)
    // Reconnection/restart also refuses to bind a recycled ID automatically.
    await assert.rejects(new Workspaces(file).scope(context, { session: "a" }), /sin ventana asignada/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("the Chrome adapter fails closed when given the application class instead of the SDK", async () => {
  class WrongServer {}
  class Handler { unknownArgumentNames() { return [] } }
  await assert.rejects(install({ McpServer: WrongServer, ToolHandler: Handler }, new URL("file:///unused")), /contrato de registro/)
})

test("team agents retain independent selected tabs after reconnect and serialize only tab creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-team-workspace-"))
  try {
    const file = pathToFileURL(join(dir, "workspaces.json"))
    const first = page(1, 100), second = page(2, 100)
    const context = { createPagesSnapshot: async () => {}, getPages: () => [first, second], selectPage: () => {} }
    const ws = new Workspaces(file)
    await ws.scope(context, { session: "team:one", action: "assign", pageId: 1 })
    const backend = await ws.scope(context, { session: "team:one", actor: "backend-session" })
    const frontend = await ws.scope(context, { session: "team:one", actor: "frontend-session" })
    backend.selectPage(first); frontend.selectPage(second)
    assert.equal(backend.getSelectedMcpPage(), first)
    assert.equal(frontend.getSelectedMcpPage(), second)
    await ws.save()
    const reopened = new Workspaces(file)
    assert.equal((await reopened.scope(context, { session: "team:one", actor: "backend-session" })).getSelectedMcpPage(), first)
    assert.equal((await reopened.scope(context, { session: "team:one", actor: "frontend-session" })).getSelectedMcpPage(), second)
    const events: string[] = []
    await Promise.all([1, 2].map(id => ws.createTab("team:one", async () => {
      events.push(`start-${id}`)
      await new Promise(resolve => setTimeout(resolve, 10))
      events.push(`end-${id}`)
    })))
    assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
