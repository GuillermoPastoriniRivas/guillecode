import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/recovery"
const sessionID = "s-recovery"
const now = Date.now()
const userID = "m-user"
const errorText = "Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: remote connection failure"

function messages(failed = false) {
  return [
    { info: { id: userID, sessionID, role: "user", time: { created: now }, agent: "build", model: { providerID: "openai", modelID: "qa" } },
      parts: [{ id: "p-user", messageID: userID, sessionID, type: "text", text: "Continuá con el trabajo pendiente" }] },
    { info: { id: "m-assistant", sessionID, role: "assistant", parentID: userID, time: { created: now + 1, ...(failed ? { completed: now + 2 } : {}) },
      providerID: "openai", modelID: "qa", agent: "build", mode: "build", path: { cwd: root, root }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(failed ? { error: { name: "APIError", data: { message: errorText, statusCode: 503, isRetryable: true } } } : {}) }, parts: [] },
  ]
}

async function setup(page: Page, restart = false) {
  const state = {
    status: { [sessionID]: { type: "retry", attempt: 1, message: errorText, next: now + 2000 } } as Record<string, unknown>,
    failed: false,
    prompts: [] as { path: string; body: Record<string, unknown> }[],
    created: 0,
  }
  await page.addInitScript(({ root, sessionID, restart }) => {
    localStorage.setItem(`guillecode:agent.openSessions@${root.toLowerCase()}`, JSON.stringify([sessionID]))
    localStorage.setItem(`guillecode:agent.activeSession@${root.toLowerCase()}`, JSON.stringify(sessionID))
    let callback = 0
    let configs = 0
    Object.assign(window, { __qaConfigs: 0, __qaStreams: 0, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined }, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++callback,
      unregisterCallback: () => undefined,
      invoke: async (command: string) => {
        if (command === "plugin:event|listen") return ++callback
        if (command === "plugin:app|version") return "0.6.0"
        if (command === "server_config") {
          configs++
          Object.assign(window, { __qaConfigs: configs })
          return { url: `${location.origin}/${restart && configs === 1 ? "old-oc" : "test-oc"}`, username: "qa", password: `qa-${configs}`, worktree: root }
        }
        if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions"].includes(command)) return []
        return null
      },
    } })
    const originalFetch = window.fetch.bind(window)
    let streams = 0
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url, location.href).pathname === "/test-oc/global/event") {
        streams++
        Object.assign(window, { __qaStreams: streams })
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
          signal?.addEventListener("abort", () => controller.close(), { once: true })
        } }), { headers: { "Content-Type": "text/event-stream" } })
      }
      return originalFetch(input, init)
    }
  }, { root, sessionID, restart })
  await page.route(/\/(?:old-oc|test-oc)\//, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/(old-oc|test-oc)/, "")
    if (path === "/global/event") return route.fulfill({ status: 503, body: "engine restarted" })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { qa: { id: "qa", name: "Modelo QA" } } }] } })
    if (path === "/session" && route.request().method() === "POST") state.created++
    if (path === "/session") return route.fulfill({ json: [{ id: sessionID, title: "Conversación recuperable", directory: root, projectID: "qa", version: "1", time: { created: now, updated: now } }] })
    if (path === "/session/status") return route.fulfill({ json: state.status })
    if (path === `/session/${sessionID}/message`) return route.fulfill({ json: messages(state.failed) })
    if (path === `/session/${sessionID}/prompt_async`) {
      state.prompts.push({ path, body: route.request().postDataJSON() })
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  return state
}

test("reconcilia reintentos perdidos y permite reintentar un 503 en la misma conversación", async ({ page }) => {
  const state = await setup(page)
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (1)")

  // Keep SSE open but deliver no more events: REST must update retry details.
  state.status = { [sessionID]: { type: "retry", attempt: 5, message: "El proveedor sigue sin responder", next: now + 30000 } }
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (5)", { timeout: 10000 })
  await expect(page.locator(".retry-banner")).toContainText("El proveedor sigue sin responder")

  // Exhausted retries disappear from /session/status. Load the persisted error
  // even though neither message.updated nor session.idle arrived over SSE.
  state.failed = true
  state.status = {}
  await expect(page.locator(".retry-banner")).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator(".msg-error")).toContainText(errorText)
  await page.locator(".msg-error").getByRole("button", { name: "Reintentar" }).click()
  await expect.poll(() => state.prompts.length).toBe(1)
  expect(state.prompts[0]).toEqual({ path: `/session/${sessionID}/prompt_async`, body: {
    model: { providerID: "openai", modelID: "qa" }, agent: "build", parts: [{ type: "text", text: "Continuá con el trabajo pendiente" }],
  } })
  expect(state.created).toBe(0)
})

test("vuelve a resolver el motor y recupera la pestaña cuando cambia la conexión", async ({ page }) => {
  await setup(page, true)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __qaConfigs: number }).__qaConfigs)).toBeGreaterThanOrEqual(2)
  await expect(page.locator(".agent-offline")).toHaveCount(0)
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
  await expect(page.locator(".agent-tab", { hasText: "Conversación recuperable" })).toHaveClass(/active/)
})

test("corta un SSE silencioso y reconecta sin abrir otra pestaña", async ({ page }) => {
  await page.clock.install()
  await setup(page)
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (1)")
  await page.clock.fastForward(36000)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __qaStreams: number }).__qaStreams)).toBeGreaterThanOrEqual(2)
  await expect(page.locator(".agent-offline")).toHaveCount(0)
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
})
