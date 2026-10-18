import { expect, test, type Page } from "@playwright/test"
import type { Part } from "@opencode-ai/sdk"
import { CONTINUE_INTERRUPTED_TURN } from "../../src/lib/autoretry"

const root = "C:/qa/recovery"
const sessionID = "s-recovery"
const now = Date.now()
const userID = "m-user"
const errorText = "El proveedor de IA está ocupado o temporalmente fuera de servicio. Esperá un momento y reintentá; tus cambios se conservan."

function messages(failed = false) {
  return [
    { info: { id: userID, sessionID, role: "user", time: { created: now }, agent: "build", model: { providerID: "openai", modelID: "qa" } },
      parts: [{ id: "p-user", messageID: userID, sessionID, type: "text", text: "Continuá con el trabajo pendiente" }] as Part[] },
    { info: { id: "m-assistant", sessionID, role: "assistant", parentID: userID, time: { created: now + 1, ...(failed ? { completed: now + 2 } : {}) },
      providerID: "openai", modelID: "qa", agent: "build", mode: "build", path: { cwd: root, root }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(failed ? { error: { name: "APIError", data: { message: errorText, statusCode: 503, isRetryable: true } } } : {}) }, parts: [] as Part[] },
  ]
}

async function setup(page: Page, restart = false) {
  const state = {
    status: { [sessionID]: { type: "retry", attempt: 1, message: errorText, next: now + 2000 } } as Record<string, unknown>,
    failed: false,
    prompts: [] as { path: string; body: Record<string, unknown> }[],
    created: 0,
    history: null as ReturnType<typeof messages> | null,
    reply: "accepted" as "accepted" | "failure" | "success",
    rejectPrompt: false,
    historyStatus: 200,
    reads: 0,
    summaries: 0,
    summaryRequests: [] as { body: Record<string, unknown>; directory: string | undefined }[],
    summaryReply: "success" as "success" | "failure" | "missing",
    readGate: null as Promise<void> | null,
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
          Object.assign(window, { __qaPush: (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) })
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'))
          signal?.addEventListener("abort", () => controller.close(), { once: true })
        } }), { headers: { "Content-Type": "text/event-stream" } })
      }
      return originalFetch(input, init)
    }
  }, { root, sessionID, restart })
  await page.route(/\/(?:old-oc|test-oc)\//, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/(old-oc|test-oc)/, "")
    if (path === "/global/event") return route.fulfill({ status: 503, body: "engine restarted" })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { qa: { id: "qa", name: "Modelo QA" }, other: { id: "other", name: "Otro modelo" } } }] } })
    if (path === "/agent") return route.fulfill({ json: [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }] })
    if (path === "/session" && route.request().method() === "POST") state.created++
    if (path === "/session") return route.fulfill({ json: [{ id: sessionID, title: "Conversación recuperable", directory: root, projectID: "qa", version: "1", time: { created: now, updated: now } }] })
    if (path === "/session/status") return route.fulfill({ json: state.status })
    if (path === `/session/${sessionID}/message`) {
      state.reads++
      const snapshot = structuredClone(state.history ?? messages(state.failed))
      const gate = state.readGate
      state.readGate = null
      if (gate) await gate
      if (state.historyStatus !== 200) return route.fulfill({ status: state.historyStatus, json: { message: "Historial temporalmente no disponible" } })
      return route.fulfill({ json: snapshot })
    }
    if (path === `/session/${sessionID}/summarize`) {
      state.summaries++
      state.summaryRequests.push({ body: route.request().postDataJSON(), directory: route.request().headers()["x-opencode-directory"] })
      if (state.summaryReply !== "missing") {
        const summary = messages(state.summaryReply === "failure")[1]
        Object.assign(summary.info, { id: `m-summary-${state.summaries}`, summary: true, finish: "stop", time: { created: Date.now(), completed: Date.now() } })
        summary.parts = [{ type: "text", id: `p-summary-${state.summaries}`, messageID: summary.info.id, sessionID, text: "Resumen del trabajo pendiente y los pasos completados" }]
        state.history = [...(state.history ?? messages(state.failed)), summary]
      }
      return route.fulfill({ json: true })
    }
    if (path === `/session/${sessionID}/prompt_async`) {
      const body = route.request().postDataJSON()
      state.prompts.push({ path, body })
      if (state.rejectPrompt) return route.fulfill({ status: 502, json: { message: "No se pudo admitir el reintento" } })
      const next = messages(state.reply === "failure")
      next[0].info.id = body.messageID
      next[0].info.time.created = Date.now()
      next[0].parts = body.parts.map((part: Part, i: number) => ({ ...part, id: `p-${body.messageID}-${i}`, messageID: body.messageID, sessionID }))
      next[1].info.id = `assistant-${body.messageID}`
      next[1].info.parentID = body.messageID
      next[1].info.time.created = Date.now() + 1
      if (state.reply === "success") {
        next[1].info.time.completed = Date.now()
        next[1].parts = [{ type: "text", text: "La respuesta se recuperó", id: "p-recovered", messageID: next[1].info.id, sessionID }]
      }
      state.history = [...(state.history ?? messages(state.failed)), ...next]
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  return state
}

test("un 503 de historial conserva mensajes y ofrece recargar", async ({ page }) => {
  await page.clock.install()
  const state = await setup(page)
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (1)")
  state.historyStatus = 503
  state.status = {}
  await page.evaluate((sessionID) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID, status: { type: "idle" } } }), sessionID)
  await expect(page.getByRole("alert")).toContainText("Historial temporalmente no disponible")
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
  state.historyStatus = 200
  await page.getByRole("button", { name: "Recargar historial" }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("REST lento conserva texto SSE nuevo y no resucita mensajes eliminados", async ({ page }) => {
  const state = await setup(page)
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (1)")
  let release!: () => void
  state.readGate = new Promise((done) => { release = done })
  const reads = state.reads
  state.status = {}
  await page.evaluate((sessionID) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID, status: { type: "idle" } } }), sessionID)
  await expect.poll(() => state.reads).toBeGreaterThan(reads)
  await page.evaluate(({ sessionID, now }) => {
    const push = (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush
    push({ type: "message.part.updated", properties: { part: { type: "text", id: "p-stream", messageID: "m-assistant", sessionID, text: "Texto SSE nuevo", time: { start: now } } } })
    push({ type: "message.removed", properties: { sessionID, messageID: "m-user" } })
  }, { sessionID, now })
  await expect(page.locator(".msg-assistant")).toContainText("Texto SSE nuevo")
  state.history = [messages()[1]]
  state.history[0].parts = [{ type: "text", id: "p-stream", messageID: "m-assistant", sessionID, text: "Texto SSE nuevo", time: { start: now } }]
  const response = page.waitForResponse((response) => response.url().includes(`/session/${sessionID}/message`))
  release()
  await response
  await page.evaluate(async () => { await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))) })
  await expect(page.locator(".msg-assistant")).toContainText("Texto SSE nuevo")
  await expect(page.locator(".msg-user")).toHaveCount(0)
})

test("Compactar y continuar conserva el modelo, agente y variante del turno original", async ({ page }) => {
  const state = await setup(page)
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (1)")
  state.status = {}
  state.history = messages(true)
  Object.assign(state.history[0].info.model, { variant: "high" })
  await page.evaluate((sid) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } }), sessionID)
  await page.getByTitle("Elegir modelo", { exact: true }).click()
  await page.locator(".quick-row", { hasText: "Otro modelo" }).click()
  await expect(page.getByTitle("Elegir modelo", { exact: true })).toContainText("Otro modelo")
  await page.getByTitle("Modo del agente", { exact: true }).click()
  await expect(page.getByTitle("Modo del agente", { exact: true })).toContainText("plan")
  await page.locator(".msg-error").getByRole("button", { name: "Compactar y continuar" }).click()
  await expect.poll(() => state.prompts.length).toBe(1)
  expect(state.summaries).toBe(1)
  expect(state.summaryRequests[0]).toEqual({ body: { providerID: "openai", modelID: "qa" }, directory: encodeURIComponent(root) })
  expect(state.prompts[0].body).toMatchObject({ model: { providerID: "openai", modelID: "qa" }, agent: "build", variant: "high", parts: [{ type: "text", text: CONTINUE_INTERRUPTED_TURN }] })
})

test("el límite de cuenta muestra una explicación breve y no ofrece compactar", async ({ page }) => {
  const state = await setup(page)
  state.status = {}
  state.history = messages(true)
  state.history[1].info.error = { name: "APIError", data: { message: "The usage limit has been reached", statusCode: 429, isRetryable: true, responseBody: JSON.stringify({ error: { type: "usage_limit_reached" } }) } }
  await page.evaluate((sid) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } }), sessionID)
  const error = page.locator(".msg-error")
  await expect(error).toContainText("La cuenta o el proveedor alcanzó su límite de uso")
  await expect(error).not.toContainText("usage_limit_reached")
  await expect(error).not.toContainText("The usage limit")
  await expect(error.getByRole("button", { name: "Compactar y continuar" })).toHaveCount(0)
  expect(state.summaries).toBe(0)
  expect(state.prompts).toHaveLength(0)
})

test("el 507 de búfer explica el problema y compacta sin repetir herramientas ni crear otro chat", async ({ page }) => {
  const state = await setup(page)
  await expect(page.locator(".retry-banner")).toBeVisible()
  const bufferError = "Insufficient Storage: exceeded request buffer limit while retrying upstream"
  state.status = {}
  state.history = messages(true)
  state.history[1].info.error = { name: "APIError", data: { message: bufferError, statusCode: 507, isRetryable: false } }
  state.history[1].parts = [{ type: "tool", id: "p-edit", messageID: "m-assistant", sessionID, callID: "c-edit", tool: "apply_patch", state: { status: "completed", input: {}, output: "Archivo editado", title: "Edit", metadata: {}, time: { start: now, end: now + 1 } } }]
  await page.evaluate((sid) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } }), sessionID)
  const error = page.locator(".msg-error")
  await expect(error).toContainText("No es falta de espacio en tu PC")
  await expect(error.locator("pre")).not.toBeVisible()
  await error.getByText("Detalles técnicos", { exact: true }).click()
  await expect(error.locator("pre")).toHaveText(bufferError)
  await expect(error.getByRole("button", { name: "Reintentar", exact: true })).toHaveCount(0)
  state.reply = "success"
  await error.getByRole("button", { name: "Compactar y continuar" }).click()
  await expect(page.locator(".msg-assistant").last()).toContainText("La respuesta se recuperó")
  expect(state.summaries).toBe(1)
  expect(state.prompts).toHaveLength(1)
  expect(state.prompts[0].body.parts).toEqual([{ type: "text", text: CONTINUE_INTERRUPTED_TURN }])
  expect(state.created).toBe(0)
  await expect(page.locator(".msg-user").first()).toContainText("Continuá con el trabajo pendiente")
})

for (const result of ["failure", "missing"] as const) {
  test(`no continúa si la compactación devuelve HTTP 200 pero el resumen ${result === "failure" ? "falló" : "no existe"}`, async ({ page }) => {
    const state = await setup(page)
    await expect(page.locator(".retry-banner")).toBeVisible()
    state.status = {}
    state.history = messages(true)
    state.summaryReply = result
    await page.evaluate((sid) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } }), sessionID)
    await page.locator(".msg-error").getByRole("button", { name: "Compactar y continuar" }).click()
    await expect(page.getByText("No se pudo compactar y continuar", { exact: true })).toBeVisible()
    expect(state.summaries).toBe(1)
    expect(state.prompts).toHaveLength(0)
    await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
    await expect(page.locator(".msg-error").getByRole("button", { name: "Compactar y continuar" })).toBeEnabled()
  })
}

test("conserva partes SSE recibidas antes de que REST entregue el mensaje", async ({ page }) => {
  await page.clock.install()
  const state = await setup(page)
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (1)")
  const newer = messages()[1]
  newer.info.id = "new-assistant"
  newer.info.time.created = now + 100
  newer.parts = [{ type: "text", id: "new-part", messageID: newer.info.id, sessionID, text: "REST anterior" }]
  state.history = [...messages(), newer]
  let release!: () => void
  state.readGate = new Promise((done) => { release = done })
  const before = state.reads
  state.status = {}
  await page.evaluate((sessionID) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID, status: { type: "idle" } } }), sessionID)
  await expect.poll(() => state.reads).toBeGreaterThan(before)
  const part = { ...newer.parts[0], text: "Parte nueva antes del mensaje" }
  await page.evaluate((part) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "message.part.updated", properties: { part } }), part)
  await page.evaluate(async () => { await new Promise<void>((done) => requestAnimationFrame(() => done())) })
  newer.parts = [part]
  release()
  await expect(page.locator(".msg-assistant").last()).toContainText("Parte nueva antes del mensaje")
})

test("el cierre prematuro muestra texto parcial y el manual continúa desde el historial", async ({ page }) => {
  await page.clock.install()
  const state = await setup(page)
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
  state.status = {}
  state.history = messages(true)
  state.history[1].parts = [{ type: "text", id: "partial", messageID: "m-assistant", sessionID, text: "Respuesta parcial conservada" }]
  state.history[1].info.error = { name: "UnknownError", data: { message: JSON.stringify({ type: "response.failed", response: { error: { code: "guillecode_interrupted_stream", message: "La respuesta se interrumpió antes de recibir su final" } } }) } } as typeof state.history[1]["info"]["error"]
  await page.clock.fastForward(6000)
  await expect(page.locator(".msg-assistant")).toContainText("Respuesta parcial conservada")
  await expect(page.locator(".msg-error")).toContainText("La respuesta se interrumpió")
  await expect(page.locator(".msg-error")).not.toContainText("guillecode_interrupted_stream")
  await page.clock.fastForward(180000)
  expect(state.prompts).toHaveLength(0)
  await page.locator(".msg-error").getByRole("button", { name: "Reintentar" }).click()
  await expect.poll(() => state.prompts.length).toBe(1)
  expect(state.prompts[0].body.parts).toEqual([{ type: "text", text: CONTINUE_INTERRUPTED_TURN }])
})

test("reconcilia reintentos perdidos y ofrece Compactar y continuar en la misma conversación", async ({ page }) => {
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
  await expect(page.locator(".msg-error")).not.toContainText("Service Unavailable")
  await page.locator(".msg-error").getByRole("button", { name: "Compactar y continuar" }).click()
  await expect.poll(() => state.prompts.length).toBe(1)
  expect(state.summaries).toBe(1)
  expect(state.prompts[0]).toEqual({ path: `/session/${sessionID}/prompt_async`, body: {
    messageID: expect.stringMatching(/^msg_/),
    model: { providerID: "openai", modelID: "qa" }, agent: "build", parts: [{ type: "text", text: CONTINUE_INTERRUPTED_TURN }],
  } })
  expect(state.created).toBe(0)
})

test("verifica herramientas con el historial actual y la recuperación continúa sin reenviar la tarea", async ({ page }) => {
  const state = await setup(page)
  await expect(page.locator(".msg-user")).toContainText("Continuá con el trabajo pendiente")
  state.status = {}
  state.history = messages(true)
  const failed = state.history[1]
  failed.parts = [{ type: "tool", id: "p-edit", messageID: failed.info.id, sessionID, callID: "c-edit", tool: "apply_patch", state: { status: "completed", input: {}, output: "Archivo editado", title: "Edit", metadata: {}, time: { start: now, end: now + 1 } } }]
  await page.evaluate((info) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "message.updated", properties: { info } }), failed.info)
  await expect(page.locator(".msg-error")).toContainText(errorText)
  await expect(page.locator(".msg-error")).not.toContainText("Service Unavailable")
  expect(state.prompts.length).toBe(0)
  await page.locator(".msg-error").getByRole("button", { name: "Compactar y continuar" }).click()
  await expect.poll(() => state.prompts.length).toBe(1)
  expect(state.summaries).toBe(1)
  expect(state.prompts[0].body.parts).toEqual([{ type: "text", text: CONTINUE_INTERRUPTED_TURN }])
})

test("muestra los errores de admisión y permite recuperar aunque el padre salió de la página", async ({ page }) => {
  const state = await setup(page)
  await expect(page.locator(".retry-banner")).toContainText("Reintentando (1)")
  state.status = {}
  state.history = [messages(true)[1]]
  state.rejectPrompt = true
  await page.evaluate((sid) => (window as unknown as { __qaPush: (event: unknown) => void }).__qaPush({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } }), sessionID)
  const recover = page.locator(".msg-error").getByRole("button", { name: "Compactar y continuar" })
  await expect(recover).toBeVisible()
  await recover.click()
  await expect(page.getByText("No se pudo admitir el reintento")).toBeVisible()
  await expect(recover).toBeEnabled()
  expect(state.prompts[0].body.parts).toEqual([{ type: "text", text: CONTINUE_INTERRUPTED_TURN }])
  state.rejectPrompt = false
  state.reply = "success"
  await recover.click()
  await expect(page.locator(".msg-assistant").last()).toContainText("La respuesta se recuperó")
  expect(state.prompts.length).toBe(2)
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
