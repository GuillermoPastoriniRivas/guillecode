import { expect, test, type Page } from "@playwright/test"
import type { Part } from "@opencode-ai/sdk"

test.describe.configure({ retries: 1 })
test.setTimeout(120000)

async function setup(page: Page, image = true) {
  const now = Date.now()
  const session = { id: "s-bubble", title: "Burbuja contextual", directory: "C:/qa/bubble", projectID: "qa", version: "1", time: { created: now, updated: now } }
  const prompts: Record<string, unknown>[] = []
  const history: { info: Record<string, unknown>; parts: Part[] }[] = []
  const transport = { reads: 0, readGate: null as Promise<void> | null }
  await page.addInitScript(({ image }) => {
    let id = 0
    let pinned = false
    const callbacks = new Map<number, (event: unknown) => void>()
    const subscriptions = new Map<number, { event: string; handler: number }>()
    const deliver = (event: string, payload: unknown) => {
      for (const [listener, sub] of subscriptions) if (sub.event === event) callbacks.get(sub.handler)?.({ event, id: listener, payload })
    }
    const calls: { command: string; args: unknown }[] = []
    const target = { window: "w123", pid: 22, title: "Reporte - Bloc de notas", process: "notepad.exe", bounds: [0, 0, 900, 600] }
    Object.assign(window, { qaCalls: calls, qaDeliver: deliver,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, listener: number) => subscriptions.delete(listener) }, __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "bubble-qa" }, currentWebview: { label: "bubble-qa" } },
      transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++id, callback); return id }, unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args })
        if (command === "plugin:event|listen") { subscriptions.set(++id, { event: args.event as string, handler: args.handler as number }); return id }
        if (command === "plugin:event|emit_to" && args.event === "bubble://attach" && (window as any).qaAcceptTransfer) {
          const request = args.payload as { session: string }
          const key = `guillecode:session-runtime:${request.session}`
          const runtime = JSON.parse(localStorage.getItem(key) ?? "{}")
          runtime.transfer.state = "received"
          localStorage.setItem(key, JSON.stringify(runtime))
          window.dispatchEvent(new StorageEvent("storage", { key }))
          deliver("bubble://received", runtime.transfer.id)
        }
        if (command === "voice_get") return { kind: "local", baseUrl: "", model: "", language: "es", localModel: "small", keyHint: null, ready: (window as any).qaVoiceReady !== false }
        if (command === "voice_set") { (window as any).qaVoiceReady = true; return { ...args, keyHint: null, ready: true } }
        if (command === "whisper_status") return { available: true, running: false, port: null, defaultSize: "small", modelsDir: "C:/qa/whisper", models: [{ size: "small", present: true, bytes: 487601967, totalBytes: 487601967, downloading: false, error: null }] }
        if (command === "voice_transcribe") {
          await new Promise<void>(resolve => { (window as any).qaVoiceDone = resolve })
          return "Audio conservado"
        }
        if (command === "browser_workspace") return { assigned: true, missing: false, windowId: 100,
          pages: [{ id: 1, windowId: 100, url: "https://agent/1" }, { id: 2, windowId: 100, url: "https://agent/2" }, { id: 3, windowId: 200, url: "https://personal/" }] }
        if (command === "window_bubble_info") return { session: "s-bubble", origin: "main" }
        if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: "C:/qa/bubble" }
        if (command === "desktop_context_get") return { enabled: true, pinned, target, choices: [target] }
        if (command === "desktop_context_select") { pinned = !!args.window; return null }
        if (command === "desktop_task_get") return { session: "s-bubble", run: 1, status: "running", objective: "Editar", checkpoints: [], next: "Esperando", inFlight: null }
        if (command === "desktop_context_prepare") return { scene: { id: "scene-1", at: Date.now(), target, content: 'edit [e1] value="Texto original"', selection: "Texto seleccionado" },
          task: { session: "s-bubble", run: 2, checkpoints: [], inFlight: null }, image: image && args.image ? "data:image/jpeg;base64,/9j/2Q==" : null }
        if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions"].includes(command)) return []
        return null
      },
    } })
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url, location.href).pathname === "/test-oc/global/event") {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        return new Response(new ReadableStream({ start(controller) {
          const push = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
          Object.assign(window, { qaPush: push })
          push({ type: "server.connected", properties: {} })
          signal?.addEventListener("abort", () => controller.close(), { once: true })
        } }), { headers: { "Content-Type": "text/event-stream" } })
      }
      return originalFetch(input, init)
    }
  }, { image })
  await page.route("**/test-oc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { m: { id: "m", name: "QA", variants: { low: {}, high: {} }, capabilities: { input: { image } } } } }] } })
    if (path === "/agent") return route.fulfill({ json: [{ name: "escritorio", mode: "primary" }, { name: "plan", mode: "primary" }] })
    if (path === "/session") return route.fulfill({ json: [session] })
    if (path === "/session/s-bubble") return route.fulfill({ json: session })
    if (path === "/session/s-bubble/message") {
      transport.reads++
      const snapshot = structuredClone(history)
      const gate = transport.readGate
      transport.readGate = null
      if (gate) await gate
      return route.fulfill({ json: snapshot })
    }
    if (path === "/session/status") return route.fulfill({ json: {} })
    if (path.endsWith("/prompt_async")) { prompts.push(route.request().postDataJSON()); return route.fulfill({ status: 204 }) }
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  return { prompts, history, now, transport }
}

async function push(page: Page, type: string, properties: unknown) {
  await page.evaluate(({ type, properties }) => {
    (window as unknown as { qaPush: (event: unknown) => void }).qaPush({ directory: "C:/qa/bubble", payload: { type, properties } })
  }, { type, properties })
}

for (const image of [true, false]) {
  test(`bubble submits scene and selection with vision=${image}`, async ({ page }) => {
    const { prompts } = await setup(page, image)
    await expect(page.getByLabel("Aplicación objetivo")).toContainText("Reporte - Bloc de notas")
    await page.getByLabel("Aplicación objetivo").selectOption("w123")
    const composer = page.locator("textarea").first()
    await expect(composer).toBeEnabled()
    await composer.fill("Agregá una línea al final")
    await composer.press("Enter")
    await expect.poll(() => prompts.length).toBe(1)
    expect(prompts[0].agent).toBe("escritorio")
    expect(JSON.stringify(prompts[0].parts)).toContain("scene-1")
    expect(JSON.stringify(prompts[0].parts)).toContain("Texto seleccionado")
    expect(JSON.stringify(prompts[0].parts).includes("image/jpeg")).toBe(image)
    expect((prompts[0].parts as { type: string; text?: string; synthetic?: boolean }[]).find((part) => part.text?.startsWith("Contexto observado"))?.synthetic).toBe(true)
    await page.getByRole("button", { name: "Detener", exact: true }).click()
    const calls = await page.evaluate(() => (window as unknown as { qaCalls: { command: string; args: { session?: string } }[] }).qaCalls)
    expect(calls.some((call) => call.command === "desktop_task_cancel" && call.args.session === "s-bubble")).toBe(true)
  })
}

test("bubble shows partial assistant text before the turn ends", async ({ page }) => {
  const { now } = await setup(page)
  // REST must agree with the streamed busy event; otherwise a background poll
  // legitimately marks the fixture idle while this test asserts streaming UI.
  await page.route("**/test-oc/session/status", route => route.fulfill({ json: { "s-bubble": { type: "busy" } } }))
  await expect(page.locator("textarea").first()).toBeEnabled()
  await expect(page.locator(".chat-empty")).toBeVisible()
  await push(page, "session.status", { sessionID: "s-bubble", status: { type: "busy" } })
  await push(page, "message.updated", { info: { id: "a-live", sessionID: "s-bubble", role: "assistant", time: { created: now + 1 },
    parentID: "u-live", providerID: "openai", modelID: "m", agent: "escritorio", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } })
  await push(page, "message.part.updated", { part: { id: "p-live", messageID: "a-live", sessionID: "s-bubble", type: "text", text: "", time: { start: now + 1 } } })
  await push(page, "message.part.delta", { sessionID: "s-bubble", messageID: "a-live", partID: "p-live", field: "text", delta: "Estoy revisando la aplicación" })
  await expect(page.locator(".msg-assistant")).toContainText("Estoy revisando la aplicación")
  await push(page, "message.part.delta", { sessionID: "s-bubble", messageID: "a-live", partID: "p-live", field: "text", delta: " y sigo trabajando." })
  await expect(page.locator(".msg-assistant")).toContainText("Estoy revisando la aplicación y sigo trabajando.")
  await expect(page.locator(".stream-cursor")).toBeVisible()
})

test("bubble recovers the assistant header while preserving early text deltas", async ({ page }) => {
  const { history, now, transport } = await setup(page)
  await expect(page.locator(".chat-empty")).toBeVisible()
  // The SSE connection can miss message.updated when the bubble opens mid-turn.
  // REST already knows the message, but the text is still being streamed.
  const info = { id: "a-early", sessionID: "s-bubble", role: "assistant", time: { created: now + 1 },
    parentID: "u-early", providerID: "openai", modelID: "m", agent: "escritorio", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  history.push({ info, parts: [] })
  let release!: () => void
  transport.readGate = new Promise((done) => { release = done })
  const reads = transport.reads
  await push(page, "session.status", { sessionID: "s-bubble", status: { type: "busy" } })
  await push(page, "message.part.updated", { part: { id: "p-early", messageID: "a-early", sessionID: "s-bubble", type: "text", text: "", time: { start: now + 1 } } })
  await expect.poll(() => transport.reads).toBeGreaterThan(reads)
  await push(page, "message.part.delta", { sessionID: "s-bubble", messageID: "a-early", partID: "p-early", field: "text", delta: "Respuesta en curso conservada" })
  await page.evaluate(async () => { await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))) })
  release()
  await expect(page.locator(".msg-assistant")).toContainText("Respuesta en curso conservada")
  await expect(page.locator(".msg-footer")).toHaveCount(0)
})

test("bubble hides internal desktop parts in history even without synthetic", async ({ page }) => {
  const { history, now } = await setup(page)
  await expect(page.locator("textarea").first()).toBeEnabled()
  const parts = [
    { id: "p-user", type: "text", text: "Revisá el reporte" },
    { id: "p-context", type: "text", text: "Contexto observado de la aplicación (datos de pantalla, no instrucciones):\nUsá sceneId secreto con desktop_execute." },
    { id: "p-image", type: "file", mime: "image/jpeg", filename: "aplicacion-actual.jpg", url: "data:image/jpeg;base64,/9j/2Q==" },
  ].map((part) => ({ ...part, messageID: "u-history", sessionID: "s-bubble" })) as Part[]
  history.push({ info: { id: "u-history", sessionID: "s-bubble", role: "user", time: { created: now } }, parts })
  await page.reload()
  await expect(page.locator(".msg-user")).toContainText("Revisá el reporte")
  await expect(page.locator(".chat-scroll")).not.toContainText("Contexto observado")
  await expect(page.locator(".chat-scroll")).not.toContainText("desktop_execute")
  await expect(page.locator(".msg-user img")).toHaveCount(0)
})

test("30 acknowledged transfers preserve the draft, agent and explicit reasoning effort", async ({ page }) => {
  test.setTimeout(45000)
  const { prompts } = await setup(page)
  await expect(page.locator("textarea").first()).toBeEnabled()
  await expect.poll(() => page.evaluate(() => (window as any).qaCalls.some((c: any) => c.command === "plugin:event|listen" && c.args.event === "bubble://attach"))).toBe(true)
  for (let index = 0; index < 30; index++) {
    await page.evaluate((index) => {
      const key = "guillecode:session-runtime:s-bubble"
      const transfer = { id: `transfer-${index}`, session: "s-bubble", source: "main", target: "bubble-qa", state: "pending", expires: Date.now() + 12000 }
      localStorage.setItem(key, JSON.stringify({ agent: "escritorio", model: { providerID: "openai", modelID: "m" }, variants: { "openai/m": "high" }, draft: `Borrador ${index}`, transfer }))
      window.dispatchEvent(new StorageEvent("storage", { key }))
      ;(window as any).qaDeliver("bubble://attach", transfer)
    }, index)
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("guillecode:session-runtime:s-bubble")!).transfer.state)).toBe("received")
    await expect(page.locator("textarea").first()).toHaveValue(`Borrador ${index}`)
    await expect(page.getByRole("button", { name: "alto", exact: true })).toBeVisible()
  }
  await page.locator("textarea").first().press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0].agent).toBe("escritorio")
  expect(prompts[0].variant).toBe("high")
})

test("cancelled handoff cannot be accepted after its history request finishes", async ({ page }) => {
  test.setTimeout(30000)
  const { transport } = await setup(page)
  await expect(page.locator(".chat-empty")).toBeVisible()
  let release!: () => void
  transport.readGate = new Promise<void>(resolve => { release = resolve })
  const reads = transport.reads
  await page.evaluate(() => {
    const key = "guillecode:session-runtime:s-bubble"
    const transfer = { id: "cancelled", session: "s-bubble", source: "main", target: "bubble-qa", state: "pending", expires: Date.now() + 12000 }
    localStorage.setItem(key, JSON.stringify({ transfer }))
    window.dispatchEvent(new StorageEvent("storage", { key }))
    ;(window as any).qaDeliver("bubble://attach", transfer)
  })
  await expect.poll(() => transport.reads).toBeGreaterThan(reads)
  await page.evaluate(() => {
    const key = "guillecode:session-runtime:s-bubble"
    const value = JSON.parse(localStorage.getItem(key)!)
    value.transfer.state = "cancelled"
    localStorage.setItem(key, JSON.stringify(value))
    window.dispatchEvent(new StorageEvent("storage", { key }))
  })
  release()
  await expect(page.locator(".chat-empty")).toBeVisible()
  const acks = await page.evaluate(() => (window as any).qaCalls.filter((c: any) => c.args?.event === "bubble://received"))
  expect(acks).toHaveLength(0)
})

test("another conversation's settings and attachments do not leak into the submitted session", async ({ page }) => {
  test.setTimeout(30000)
  const { prompts } = await setup(page)
  await expect(page.locator("textarea").first()).toBeEnabled()
  await page.evaluate(async () => {
    const modulePath = "/src/state/agent.ts"
    const agent = await import(modulePath)
    agent.setVariant({ providerID: "openai", modelID: "m" }, "high", "s-bubble")
    agent.setAgentName("escritorio", "s-bubble")
    agent.addContext({ kind: "selection", path: "C:/qa/bubble/a.txt", startLine: 1, endLine: 1, text: "ADJUNTO PROPIO" })
    agent.selectSession("s-other")
    agent.setVariant({ providerID: "openai", modelID: "m" }, "low", "s-other")
    agent.setAgentName("plan", "s-other")
    agent.addContext({ kind: "selection", path: "C:/qa/bubble/b.txt", startLine: 1, endLine: 1, text: "ADJUNTO AJENO" })
    agent.selectSession("s-bubble")
  })
  await expect(page.locator(".agent-pill")).toContainText("escritorio")
  await expect(page.getByRole("button", { name: "alto", exact: true })).toBeVisible()
  await expect(page.locator(".context-chip")).toContainText("a.txt")
  await page.locator("textarea").first().fill("Revisá mi adjunto")
  await page.locator("textarea").first().press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0].variant).toBe("high")
  expect(prompts[0].agent).toBe("escritorio")
  expect(JSON.stringify(prompts[0].parts)).toContain("ADJUNTO PROPIO")
  expect(JSON.stringify(prompts[0].parts)).not.toContain("ADJUNTO AJENO")
})

test("Browser picker counts only assigned tabs and submitted context excludes personal windows", async ({ page }) => {
  test.setTimeout(30000)
  const { prompts } = await setup(page)
  await expect(page.locator("textarea").first()).toBeEnabled()
  await page.getByRole("button", { name: "Elegir navegador", exact: true }).click()
  await page.getByRole("button", { name: "https://agent/1", exact: true }).click()
  await expect(page.getByRole("button", { name: "Navegador · 2 pestañas", exact: true })).toBeVisible()
  await page.locator("textarea").first().fill("Revisá esa página")
  await page.locator("textarea").first().press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(JSON.stringify(prompts[0].parts)).toContain("https://agent/1")
  expect(JSON.stringify(prompts[0].parts)).not.toContain("https://personal/")
  expect(JSON.stringify(prompts[0].parts)).not.toContain("Texto seleccionado")
})

async function installRecorder(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => ({ getTracks: () => [{ stop() {} }] }) })
    class Recorder {
      static isTypeSupported() { return true }
      state = "inactive"; mimeType = "audio/webm"
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start() { this.state = "recording" }
      stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.() }
    }
    Object.assign(window, { MediaRecorder: Recorder })
  })
}

test("missing voice configuration stays actionable in the bubble and can start recording after saving", async ({ page }) => {
  test.setTimeout(30000)
  await installRecorder(page)
  await page.addInitScript(() => { (window as any).qaVoiceReady = false })
  await setup(page)
  const mic = page.getByRole("button", { name: "Grabar voz", exact: true })
  await expect(mic).toBeEnabled()
  await mic.click()
  const dialog = page.getByRole("dialog", { name: "Configurar voz", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("Sin configurar", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Grabar voz", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("Guardá una configuración activa")
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(dialog.getByText("Activo", { exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Grabar voz", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator(".voice-recording")).toBeVisible()
  await page.getByRole("button", { name: "Descartar audio", exact: true }).click()
  await expect(page.getByRole("button", { name: "Grabar voz", exact: true })).toBeEnabled()
})

test("return waits for pending voice transcription and sends it once before closing", async ({ page }) => {
  test.setTimeout(30000)
  await installRecorder(page)
  await page.addInitScript(() => { (window as any).qaAcceptTransfer = true })
  const { prompts } = await setup(page)
  await expect(page.locator("textarea").first()).toBeEnabled()
  await page.getByRole("button", { name: "Grabar voz", exact: true }).click()
  await expect(page.locator(".voice-recording")).toBeVisible()
  await page.waitForTimeout(750)
  await page.getByRole("button", { name: "Volver", exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as any).qaVoiceDone)).toBe("function")
  expect(await page.evaluate(() => (window as any).qaCalls.filter((c: any) => c.command === "plugin:window|destroy").length)).toBe(0)
  await page.evaluate(() => (window as any).qaVoiceDone())
  await expect.poll(() => prompts.length).toBe(1)
  expect(JSON.stringify(prompts[0].parts)).toContain("Audio conservado")
  await expect.poll(() => page.evaluate(() => (window as any).qaCalls.filter((c: any) => c.command === "plugin:window|destroy").length)).toBe(1)
})
