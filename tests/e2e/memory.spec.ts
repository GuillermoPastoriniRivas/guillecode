import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/memoria"
const now = Date.now()

const overview = {
  scope: root,
  slug: "memoria",
  preferences: "- respondé en español",
  overview: "- proyecto de prueba",
  notes: [{ id: "decision-base", title: "Base de datos", kind: "decision", updated: new Date(now - 40000).toISOString(), preview: "Usamos PostgreSQL" }],
  tasks: [{ id: "s1", title: "Trabajo de prueba", updated: new Date(now - 20000).toISOString(), directory: root, progress: "Faltan los tests", lastUser: "Implementá el login" }],
}

async function setup(page: Page) {
  await page.addInitScript(({ root, overview }) => {
    const key = root.toLowerCase()
    localStorage.setItem(`guillecode:agent.openSessions@${key}`, JSON.stringify(["s1"]))
    localStorage.setItem(`guillecode:agent.activeSession@${key}`, JSON.stringify("s1"))
    let id = 0
    const calls: Array<{ command: string; args: unknown }> = []
    Object.assign(window, {
      __memoryCalls: calls,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++id,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args?: unknown) => {
          calls.push({ command, args })
          if (command === "plugin:event|listen") return ++id
          if (command === "plugin:app|version") return "0.7.0"
          if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: root }
          if (command === "memory_overview") return overview
          if (command === "memory_set_session") return { ok: true, enabled: (args as { enabled: boolean }).enabled }
          if (command === "memory_read_note") return { path: "workspaces/memoria/notes/decision-base.md", content: "---\ntitle: Base de datos\ntype: decision\n---\n\nUsamos PostgreSQL" }
          if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions", "fs_list_files"].includes(command)) return []
          return null
        },
      },
    })
  }, { root, overview })
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { m: { id: "m", name: "Modelo QA" } } }] } })
    if (path === "/session") return route.fulfill({ json: [{ id: "s1", title: "Conversación actual", directory: root, projectID: "qa", version: "1", time: { created: now - 60000, updated: now - 30000, archived: 0 } }] })
    if (path === "/session/status") return route.fulfill({ json: {} })
    if (path === "/session/s1/message") return route.fulfill({ json: [] })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
}

const composerPill = (page: Page) => page.locator(".agent-panel .memory-pill")

test("toggle de memoria por conversación, encendido por defecto", async ({ page }) => {
  await setup(page)
  await expect(composerPill(page)).toContainText("Memoria")
  await expect(composerPill(page)).not.toContainText("Sin memoria")

  await composerPill(page).click()
  await expect(composerPill(page)).toContainText("Sin memoria")
  const off = await page.evaluate(() => (window as unknown as { __memoryCalls: Array<{ command: string; args: { session: string; enabled: boolean } }> }).__memoryCalls.filter((c) => c.command === "memory_set_session"))
  expect(off.at(-1)?.args).toEqual({ session: "s1", enabled: false })

  await composerPill(page).click()
  await expect(composerPill(page)).toContainText("Memoria")
  const on = await page.evaluate(() => (window as unknown as { __memoryCalls: Array<{ command: string; args: { enabled: boolean } }> }).__memoryCalls.filter((c) => c.command === "memory_set_session"))
  expect(on.at(-1)?.args).toMatchObject({ enabled: true })
})

test("la vista de memoria muestra trabajos y notas, y permite continuar en un chat nuevo", async ({ page }) => {
  await setup(page)
  await page.locator(".command-center").click()
  await page.locator(".quick-input input").fill(">memoria")
  await page.keyboard.press("Enter")
  await expect(page.locator(".memory-editor")).toBeVisible()
  await expect(page.locator(".memory-editor")).toContainText("Trabajo de prueba")
  await expect(page.locator(".memory-editor")).toContainText("Faltan los tests")
  await page.getByRole("button", { name: /Continuar en un chat nuevo/i }).click()
  await expect(page.locator(".agent-panel textarea")).toHaveValue(/Continuá con el trabajo «Trabajo de prueba»/)

  await page.locator(".memory-editor").getByRole("button", { name: /Ver estado/i }).first().click()
  const read = await page.evaluate(() => (window as unknown as { __memoryCalls: Array<{ command: string; args: { id?: string } }> }).__memoryCalls.filter((c) => c.command === "memory_read_note"))
  expect(read.at(-1)?.args.id).toBe("s1")
})
