import { expect, test, type Page } from "@playwright/test"
import type { LiveEvent, Message } from "../../src/pwa/api"

const project = "C:/qa/pwa-live"
const sessionID = "ses_live"
const now = Date.now()
const assistant = (text = "Preparando el trabajo"): Message => ({
  info: { id: "msg_assistant", sessionID, role: "assistant", time: { created: now + 60000 } },
  parts: [{ id: "prt_text", messageID: "msg_assistant", sessionID, type: "text", text }],
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function setup(page: Page) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const state = {
    messages: [] as Message[], busy: false, failSend: false,
    sending: deferred(), accept: null as ReturnType<typeof deferred> | null,
    reading: deferred(), refresh: null as ReturnType<typeof deferred> | null,
    requests: 0, sent: [] as Array<{ messageID: string; parts: Message["parts"] }>,
  }
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input).startsWith("/hub/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            Object.assign(window, { emitLive: (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) })
            controller.enqueue(new TextEncoder().encode(": ok\n\n"))
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true })
          },
        })
        return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }))
      }
      return fetch(input, init)
    }
  })
  await page.route("**/hub/**", (route) => route.fulfill({ json: {
    current: project, projects: [project], routines: [],
    prefs: { model: { providerID: "openai", modelID: "model" }, agent: "build" },
  } }))
  await page.route("**/oc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/oc", "")
    if (path === "/config/providers") return route.fulfill({ json: {
      providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { model: { id: "model", name: "Test model" } } }],
    } })
    if (path === `/session/${sessionID}/prompt_async`) {
      const body = route.request().postDataJSON()
      state.sent.push(body)
      state.sending.resolve()
      if (state.accept) await state.accept.promise
      if (state.failSend) return route.fulfill({ status: 500, json: { error: "No se pudo enviar" } })
      state.messages.push({ info: { id: body.messageID, sessionID, role: "user", time: { created: Date.now() } }, parts: body.parts })
      state.busy = true
      return route.fulfill({ status: 204 })
    }
    if (path === `/session/${sessionID}/message`) {
      state.requests += 1
      const snapshot = structuredClone(state.messages)
      const refresh = state.refresh
      state.refresh = null
      if (refresh) {
        state.reading.resolve()
        await refresh.promise
      }
      return route.fulfill({ json: snapshot })
    }
    if (path === "/session/status") return route.fulfill({ json: state.busy ? { [sessionID]: { type: "busy" } } : {} })
    if (path === `/session/${sessionID}`) return route.fulfill({ json: { id: sessionID, title: "Conversación en vivo", time: { created: now, updated: now } } })
    return route.fulfill({ json: [] })
  })
  await page.route("**/live-test", (route) => route.fulfill({ contentType: "text/html", body: `
    <div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/src/pwa/pwa.css');
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { SessionScreen } = await import('/src/pwa/Session.tsx');
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(SessionScreen, {
        route: { kind: 'session', id: '${sessionID}', project: '${project}', title: 'Conversación en vivo' },
        back: () => { throw new Error('La prueba no debe salir de la conversación'); },
      }));
    </script>
  ` }))
  await page.goto("/live-test", { waitUntil: "domcontentloaded" })
  await expect(page.getByText("Test model", { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.locator(".loading")).toHaveCount(0)
  return { state, errors }
}

async function emit(page: Page, event: LiveEvent) {
  await page.evaluate((e) => (window as unknown as { emitLive: (event: LiveEvent) => void }).emitLive(e), event)
}

async function send(page: Page) {
  await page.getByRole("textbox").fill("Revisá el proyecto")
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
}

test("muestra el mensaje al enviar y no lo duplica cuando llega la confirmación", async ({ page }) => {
  const { state, errors } = await setup(page)
  state.accept = deferred()
  await send(page)
  await state.sending.promise
  await expect(page.locator(".bubble.user")).toHaveText("Revisá el proyecto")
  // An older/empty refresh cannot remove a prompt while the POST is pending.
  await emit(page, { type: "resync" })
  await expect.poll(() => state.requests).toBeGreaterThan(1)
  await expect(page.locator(".bubble.user")).toHaveCount(1)
  state.accept.resolve()
  await expect(page.getByRole("textbox")).toHaveValue("")
  await expect(page.locator(".topbar-title")).toContainText("trabajando…")
  const message = state.messages[0]
  await emit(page, { type: "message.updated", properties: { info: message.info } })
  await emit(page, { type: "message.part.updated", properties: { part: message.parts[0] } })
  await expect(page.locator(".bubble.user")).toHaveCount(1)
  expect(state.sent[0].messageID).toBe(message.info.id)
  expect(errors).toEqual([])
})

test("sigue mostrando trabajo y finalización aunque SSE esté abierto sin eventos", async ({ page }) => {
  const { state, errors } = await setup(page)
  await send(page)
  await expect(page.getByRole("textbox")).toHaveValue("")
  const reply = assistant()
  reply.parts.push({ id: "prt_tool", messageID: reply.info.id, sessionID, type: "tool", tool: "read", state: { status: "running", title: "Inspeccionando archivos" } })
  state.messages.push(reply)
  await expect(page.getByText("Preparando el trabajo", { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.locator(".tool.running")).toContainText("Inspeccionando archivos")
  reply.parts[0].text = "Trabajo terminado"
  reply.parts[1].state!.status = "completed"
  state.busy = false
  await expect(page.getByText("Trabajo terminado", { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.locator(".topbar-title")).toContainText("en espera")
  await expect(page.locator(".tool.completed")).toBeVisible()
  expect(page.url()).toContain("/live-test")
  expect(errors).toEqual([])
})

test("un refresco lento no pisa el texto ni el estado que ya llegó por SSE", async ({ page }) => {
  const { state, errors } = await setup(page)
  const reply = assistant("Respuesta")
  state.messages.push(reply)
  state.busy = true
  await emit(page, { type: "resync" })
  await expect(page.getByText("Respuesta", { exact: true })).toBeVisible()
  state.refresh = deferred()
  const held = state.refresh
  await emit(page, { type: "resync" })
  await state.reading.promise
  await emit(page, { type: "message.part.delta", properties: { sessionID, messageID: reply.info.id, partID: reply.parts[0].id, field: "text", delta: " en vivo" } })
  await emit(page, { type: "session.idle", properties: { sessionID } })
  await expect(page.getByText("Respuesta en vivo", { exact: true })).toBeVisible()
  await expect(page.locator(".topbar-title")).toContainText("en espera")
  reply.parts[0].text = "Respuesta en vivo"
  state.busy = false
  held.resolve()
  await expect(page.getByText("Respuesta en vivo", { exact: true })).toBeVisible()
  await expect(page.locator(".topbar-title")).toContainText("en espera")
  expect(errors).toEqual([])
})

test("si el envío falla, quita la burbuja provisional y conserva el borrador", async ({ page }) => {
  const { state, errors } = await setup(page)
  state.failSend = true
  await send(page)
  await expect(page.getByText("No se pudo enviar", { exact: true })).toBeVisible()
  await expect(page.getByRole("textbox")).toHaveValue("Revisá el proyecto")
  await expect(page.locator(".bubble.user")).toHaveCount(0)
  expect(errors).toEqual([])
})
