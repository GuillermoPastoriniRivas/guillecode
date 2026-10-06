import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/archive"
const now = Date.now()
const session = (id: string, title: string, parentID?: string) => ({
  id, title, parentID, directory: root, projectID: "qa", version: "1",
  time: { created: now - 60000, updated: now - 30000, archived: 0 },
})

async function setup(page: Page, open = ["s1", "c1", "s2"]) {
  const state = {
    sessions: [session("s1", "Conversación vieja"), session("c1", "Subagente de la vieja", "s1"), session("s2", "Conversación actual")],
    mutations: [] as Array<{ method: string; path: string; body: unknown; directory: string }>,
    failure: "" as "" | "http" | "unsupported",
    events: [] as unknown[],
  }
  await page.addInitScript(({ root, open }) => {
    const key = root.toLowerCase()
    if (!sessionStorage.getItem("qa-archive-booted")) {
      localStorage.setItem(`guillecode:agent.openSessions@${key}`, JSON.stringify(open))
      localStorage.setItem(`guillecode:agent.activeSession@${key}`, JSON.stringify("s1"))
      sessionStorage.setItem("qa-archive-booted", "1")
    }
    let id = 0
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
      invoke: async (command: string) => {
        if (command === "plugin:event|listen") return ++id
        if (command === "plugin:app|version") return "0.6.0"
        if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: root }
        if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions", "fs_list_files"].includes(command)) return []
        return null
      },
    } })
  }, { root, open })
  await page.route("**/test-oc/**", (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) {
      const events = [{ type: "server.connected", properties: {} }, ...state.events.splice(0)]
      return route.fulfill({ contentType: "text/event-stream", body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") })
    }
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { m: { id: "m", name: "Modelo QA" } } }] } })
    if (request.method() !== "GET") {
      const body = request.postDataJSON()
      state.mutations.push({ method: request.method(), path, body, directory: decodeURIComponent(request.headers()["x-opencode-directory"] ?? "") })
      if (request.method() === "PATCH" && path.startsWith("/session/")) {
        if (state.failure === "http") return route.fulfill({ status: 500, json: { message: "No se pudo guardar en el motor" } })
        const info = state.sessions.find((s) => path === `/session/${s.id}`)!
        if (state.failure !== "unsupported") info.time.archived = body.time.archived
        return route.fulfill({ json: info })
      }
    }
    if (path === "/session") return route.fulfill({ json: state.sessions })
    if (path === "/session/status") return route.fulfill({ json: {} })
    if (path === "/session/s1/message") return route.fulfill({ json: [{
      info: { id: "msg1", sessionID: "s1", role: "user", time: { created: now - 40000 }, agent: "build", model: { providerID: "openai", modelID: "m" } },
      parts: [{ id: "part1", sessionID: "s1", messageID: "msg1", type: "text", text: "Este historial se conserva al archivar." }],
    }] })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  await page.getByTitle("Historial de sesiones").click()
  await expect(row(page, "Conversación vieja")).toBeVisible()
  return state
}

const row = (page: Page, title: string) => page.locator(".session-row", { hasText: title })
const tab = (page: Page, title: string) => page.locator(".agent-tab", { hasText: title })

test("archiva con sus subagentes, persiste al recargar y restaura conservando el historial", async ({ page }) => {
  const state = await setup(page)
  await row(page, "Conversación vieja").hover()
  await row(page, "Conversación vieja").getByRole("button", { name: "Archivar conversación", exact: true }).click()
  await expect(row(page, "Conversación vieja")).toHaveCount(0)
  await expect(tab(page, "Conversación vieja")).toHaveCount(0)
  await expect(tab(page, "Subagente de la vieja")).toHaveCount(0)
  await expect(tab(page, "Conversación actual")).toHaveClass(/active/)
  expect(state.mutations).toEqual([{ method: "PATCH", path: "/session/s1", body: { time: { archived: expect.any(Number) } }, directory: root }])
  expect(state.sessions[0].time.archived).toBeGreaterThan(0)
  expect(state.sessions[1].time.archived).toBe(0)

  await page.getByTitle("Nueva sesión (Ctrl+Alt+N)").click()
  await expect(page.locator(".agent-recent")).not.toContainText("Conversación vieja")
  await page.locator(".command-center").click()
  await page.locator(".quick-input input").fill("#")
  await expect(page.locator(".quick-input")).toContainText("Conversación actual")
  await expect(page.locator(".quick-input")).not.toContainText("Conversación vieja")
  await expect(page.locator(".quick-input")).not.toContainText("Subagente de la vieja")
  await page.keyboard.press("Escape")

  await page.reload()
  await expect(row(page, "Conversación vieja")).toHaveCount(0)
  await page.getByRole("button", { name: "Archivadas (1)", exact: true }).click()
  await row(page, "Conversación vieja").click()
  await expect(page.locator(".agent-panel .chat-scroll")).toContainText("Este historial se conserva al archivar.")
  await expect(page.locator(".session-archived-banner")).toBeVisible()
  await expect(page.locator(".agent-panel textarea")).toHaveCount(0)
  await page.locator(".session-row-wrap", { has: row(page, "Conversación vieja") }).locator(".session-expand").click()
  await expect(row(page, "Subagente de la vieja")).toBeVisible()
  await row(page, "Subagente de la vieja").click()
  await expect(page.locator(".session-archived-banner")).toBeVisible()
  await page.locator(".session-archived-banner").getByRole("button", { name: "Restaurar", exact: true }).click()
  await expect(page.locator(".session-archived-banner")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Archivadas (0)", exact: true })).toBeVisible()
  expect(state.mutations.at(-1)?.body).toEqual({ time: { archived: 0 } })
  await page.getByRole("button", { name: "Activas (2)", exact: true }).click()
  await row(page, "Conversación vieja").click()
  await expect(page.locator(".agent-panel .chat-scroll")).toContainText("Este historial se conserva al archivar.")
  await expect(page.locator(".agent-panel textarea")).toBeVisible()
})

test("menú contextual de pestañas y restauración desde Archivadas", async ({ page }) => {
  await setup(page, ["s1"])
  await tab(page, "Conversación vieja").click({ button: "right" })
  await page.locator(".context-menu").getByRole("button", { name: "Archivar conversación", exact: true }).click()
  await expect(page.locator(".agent-welcome")).toBeVisible()
  await expect(tab(page, "Conversación vieja")).toHaveCount(0)
  await page.getByRole("button", { name: "Archivadas (1)", exact: true }).click()
  await page.getByPlaceholder("Filtrar sesiones").fill("no existe")
  await expect(page.getByText("Sin resultados", { exact: true })).toBeVisible()
  await page.getByPlaceholder("Filtrar sesiones").fill("vieja")
  await row(page, "Conversación vieja").click({ button: "right" })
  await page.locator(".context-menu").getByRole("button", { name: "Restaurar conversación", exact: true }).click()
  await expect(page.getByRole("button", { name: "Archivadas (0)", exact: true })).toBeVisible()
  await page.getByPlaceholder("Filtrar sesiones").fill("")
  await expect(page.getByText("No hay conversaciones archivadas", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Activas (2)", exact: true }).click()
  await expect(row(page, "Conversación vieja")).toBeVisible()
})

for (const failure of ["http", "unsupported"] as const) {
  test(`un error ${failure} no oculta ni cierra la conversación`, async ({ page }) => {
    const state = await setup(page)
    state.failure = failure
    await row(page, "Conversación vieja").hover()
    await row(page, "Conversación vieja").getByRole("button", { name: "Archivar conversación", exact: true }).click()
    await expect(page.getByText("No se pudo archivar", { exact: true })).toBeVisible()
    await expect(row(page, "Conversación vieja")).toBeVisible()
    await expect(tab(page, "Conversación vieja")).toHaveClass(/active/)
    await expect(page.getByRole("button", { name: "Archivadas (0)", exact: true })).toBeVisible()
    expect(state.sessions[0].time.archived).toBe(0)
  })
}

test("sincroniza archivado y restauración de otra ventana por eventos del motor", async ({ page }) => {
  const state = await setup(page)
  const info = state.sessions[0]
  info.time.archived = Date.now()
  state.events.push({ directory: root, payload: { type: "session.updated", properties: { info: structuredClone(info) } } })
  await expect(row(page, "Conversación vieja")).toHaveCount(0, { timeout: 15000 })
  await expect(tab(page, "Conversación vieja")).toHaveCount(0)
  await expect(tab(page, "Subagente de la vieja")).toHaveCount(0)
  await expect(tab(page, "Conversación actual")).toHaveClass(/active/)
  await page.getByRole("button", { name: "Archivadas (1)", exact: true }).click()
  await expect(row(page, "Conversación vieja")).toBeVisible()
  info.time.archived = 0
  state.events.push({ directory: root, payload: { type: "session.updated", properties: { info: structuredClone(info) } } })
  await expect(row(page, "Conversación vieja")).toHaveCount(0, { timeout: 15000 })
  await page.getByRole("button", { name: "Activas (2)", exact: true }).click()
  await expect(row(page, "Conversación vieja")).toBeVisible()
  expect(state.mutations).toEqual([])
})
