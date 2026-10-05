import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/demo"
const now = Date.now()
const session = (id: string, title: string, parentID?: string) => ({
  id,
  title,
  parentID,
  directory: root,
  projectID: "qa",
  version: "1",
  time: { created: now - 60000, updated: now - 30000 },
})
const sessions = [session("s1", "Sesión activa"), session("s2", "Termina sin mirar"), session("s3", "Espera permiso"), session("c3", "Subagente", "s3")]

async function setup(page: Page) {
  const state: { status: Record<string, { type: string }> } = { status: { s2: { type: "busy" }, s3: { type: "busy" }, c3: { type: "busy" } } }
  await page.addInitScript(() => {
    localStorage.setItem("guillecode:agent.openSessions@c:/qa/demo", JSON.stringify(["s1", "s2", "s3"]))
    localStorage.setItem("guillecode:agent.activeSession@c:/qa/demo", JSON.stringify("s1"))
    if (!sessionStorage.getItem("qa-booted")) localStorage.removeItem("guillecode:agent.unseen")
    sessionStorage.setItem("qa-booted", "1")
    let id = 0
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
      invoke: async (command: string) => {
        if (command === "plugin:event|listen") return ++id
        if (command === "plugin:app|version") return "0.5.0"
        if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: "C:/qa/demo" }
        if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions"].includes(command)) return []
        return null
      },
    } })
  })
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { m: { id: "m", name: "Modelo QA" } } }] } })
    if (path === "/session") return route.fulfill({ json: sessions })
    if (path === "/session/status") return route.fulfill({ json: state.status })
    if (path === "/permission") return route.fulfill({ json: [{ id: "per1", sessionID: "c3", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] }] })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  await page.evaluate(() => window.focus())
  return state
}

const tab = (page: Page, title: string) => page.locator(".agent-tab", { hasText: title })
const row = (page: Page, title: string) => page.locator(".session-row", { hasText: title })

test("amarillo cuando espera respuesta (aunque siga trabajando) y verde cuando terminó sin mirar hasta abrirla", async ({ page }) => {
  const state = await setup(page)
  await page.getByTitle("Sesiones del agente (Ctrl+Shift+A)").click()

  await expect(tab(page, "Espera permiso")).toHaveClass(/state-attention/)
  await expect(row(page, "Espera permiso")).toContainText("espera tu respuesta")
  await expect(tab(page, "Termina sin mirar")).toHaveClass(/state-busy/)

  state.status = { s3: { type: "busy" }, c3: { type: "busy" } }
  await expect(tab(page, "Termina sin mirar")).toHaveClass(/state-unseen/, { timeout: 15000 })
  await expect(row(page, "Termina sin mirar")).toContainText("terminó")
  await expect(tab(page, "Sesión activa")).toHaveClass(/state-idle/)
  await page.screenshot({ path: "test-results/session-marks.png" })

  await page.reload()
  await page.evaluate(() => window.focus())
  await expect(tab(page, "Termina sin mirar")).toHaveClass(/state-unseen/)

  await tab(page, "Termina sin mirar").click()
  await expect(tab(page, "Termina sin mirar")).toHaveClass(/state-idle/)
  await expect(row(page, "Termina sin mirar")).not.toContainText("terminó")
})
