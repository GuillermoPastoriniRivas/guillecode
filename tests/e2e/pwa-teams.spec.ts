import { test, expect, type Page } from "@playwright/test"
import type { TeamRun } from "../../src/team/types"

const fixture = (): TeamRun => ({ id: "run", goal: "Validar registro y errores del formulario", team: { id: "t", name: "Equipo", projectRoot: "C:/qa/mobile", allowedRepositories: ["C:/qa/mobile"], leadAgentId: "lead", maxParallelTasks: 2, maxRetriesPerTask: 1, updatedAt: 1, members: ["lead", "frontend"].map(id => ({ id, name: id === "lead" ? "Lead" : "Frontend", role: id, model: { providerID: "openai", modelID: "observed-model" }, variant: null, tools: [], instructions: "", skillRefs: [], maxConcurrentTasks: 1 })) }, skills: [], status: "plan_ready", startedAt: 1, finishedAt: null, planSessionId: null, summary: "", error: null, evidenceDir: "", notified: false, artifacts: [{ id: "artifact", taskId: null, phase: "test", kind: "report", relativePath: "tests/report.txt", capturedAt: 1, status: "captured", source: "command", reason: null }], tasks: [{ id: "T1", title: "Validar formulario", objective: "Rechazar correos inválidos", assignedAgentId: "frontend", repository: "C:/qa/mobile", dependencies: [], expectedFiles: ["form.ts"], writePaths: ["form.ts"], acceptanceCriteria: ["El formulario rechaza correo inválido"], verificationPlan: [{ kind: "command", command: "node --test", expected: "Casos negativos y positivos pasan" }], risk: "low", status: "pending", attempts: [], error: null }], planV2: { enabled: true, reviewBeforeStart: true, stage: "validated", revisionNumber: 1, digest: "digest-1", sequence: 1, validation: { valid: true, issues: [] }, discovery: [], revisions: [{ id: "v1", number: 1, parentRevisionId: null, runId: "run", baseDigest: "", actor: "lead", reason: "Contrato inicial comprobado", operationId: "initial", operations: [], resultingDigest: "digest-1", createdAt: 1, validation: { valid: true, issues: [] } }] } })

async function setup(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  const state = { run: fixture(), offline: false, unauthorized: false, rejectPatch: false, patches: [] as Record<string, unknown>[], controls: [] as string[], messages: [] as string[], authenticated: [] as string[] }
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input).startsWith("/hub/events")) {
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          Object.assign(window, { emitTeam: (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)) })
          controller.enqueue(new TextEncoder().encode(": connected\n\n"))
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true })
        } })
        return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }))
      }
      return original(input, init)
    }
  })
  await page.route("**/hub/teams**", async route => {
    state.authenticated.push(route.request().headers().authorization)
    if (state.unauthorized) return route.fulfill({ status: 401, json: { error: "revoked" } })
    if (state.offline) return route.abort("internetdisconnected")
    const url = new URL(route.request().url())
    if (url.pathname === "/hub/teams") return route.fulfill({ json: { chats: [{ id: "chat", title: "Equipo móvil", archived: false, runs: [{ id: "run", goal: state.run.goal, status: state.run.status }] }] } })
    if (url.pathname === "/hub/teams/run") return route.fulfill({ json: { run: state.run, sequence: state.run.planV2!.sequence } })
    const body = route.request().postDataJSON()
    if (url.pathname.endsWith("/patch")) {
      state.patches.push(body.patch)
      if (state.rejectPatch) { state.run.planV2!.revisionNumber = 3; state.run.planV2!.sequence = 3; state.run.planV2!.digest = "digest-3"; return route.fulfill({ status: 409, json: { error: "REVISION_CONFLICT: otra ventana modificó el plan" } }) }
      state.run.planV2!.revisionNumber++; state.run.planV2!.sequence++; state.run.planV2!.digest = "digest-2"
      state.run.tasks[0].priority = 1
      return route.fulfill({ json: { id: "receipt" } })
    }
    if (url.pathname.endsWith("/control")) { state.controls.push(body.action); state.run.status = body.action === "start_plan" ? "running" : body.action === "pause" ? "paused" : "running"; state.run.planV2!.sequence++; return route.fulfill({ json: { ok: true } }) }
    if (url.pathname.endsWith("/message")) { state.messages.push(body.text); return route.fulfill({ json: { replyId: "reply" } }) }
    if (url.pathname.endsWith("/evidence")) return route.fulfill({ json: { text: "Negative validation: passed" } })
    return route.fulfill({ status: 404, json: { error: "unknown" } })
  })
  await page.goto("/pwa.html?teams=1&chat=chat&run=run&t=test-token")
  await expect(page.getByRole("region", { name: "Tablero de tareas", exact: true })).toBeVisible()
  return { state, errors }
}
async function emit(page: Page) { await page.evaluate(() => (window as unknown as { emitTeam: (e: unknown) => void }).emitTeam({ type: "team.changed" })) }

test("PWA autenticada: revisión, cambios por teclado, controles y evidencia comparten el tablero", async ({ page }) => {
  const { state, errors } = await setup(page)
  await page.getByRole("button", { name: "Abrir tarea T1: Validar formulario" }).click()
  await page.getByRole("button", { name: "Priorizar tarea pendiente" }).focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => state.patches.length).toBe(1)
  expect(state.patches[0]).toMatchObject({ runId: "run", expectedRevision: 1, expectedDigest: "digest-1", operations: [{ type: "REPRIORITIZE_PENDING", taskId: "T1" }] })
  await expect(page.getByText("PLAN VIVO · v2")).toBeVisible()
  await page.getByRole("button", { name: "Cerrar detalle" }).click()
  await page.getByRole("button", { name: "Revisiones", exact: true }).click()
  await expect(page.getByText("Contrato inicial comprobado")).toBeVisible()
  await page.getByRole("button", { name: "Tablero", exact: true }).click()
  await page.getByRole("button", { name: "Iniciar plan validado" }).click()
  await expect(page.getByRole("button", { name: "Pausar", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Pausar", exact: true }).click()
  await expect(page.getByRole("button", { name: "Reanudar", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Ver evidencias" }).click()
  await page.getByRole("button", { name: "tests/report.txt · captured" }).click()
  await expect(page.getByText("Negative validation: passed")).toBeVisible()
  await page.getByRole("button", { name: "Cerrar", exact: true }).click()
  await page.getByLabel("Escribir al Lead").fill("Agregar el caso de correo vacío")
  await page.getByRole("button", { name: "Enviar al Lead" }).click()
  await expect.poll(() => state.messages.length).toBe(1)
  expect(state.authenticated.every(header => header === "Bearer test-token")).toBe(true)
  expect(errors).toEqual([])
  await expect(page.getByLabel("Escribir al Lead")).toHaveValue("")
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByRole("heading", { name: state.run.goal })).toBeInViewport()
  await page.screenshot({ path: "test-results/pwa-plan-vivo.png", fullPage: true })
})

test("PWA resincro: eventos duplicados, secuencias viejas y desconexión conservan evidencia", async ({ page }) => {
  const { state, errors } = await setup(page)
  state.run.status = "running"
  const task = state.run.tasks[0]
  task.status = "running"
  task.attempts = [{ id: "attempt", agent: state.run.team.members[1], sessionId: "ses-observed", reviewSessionId: null, startedAt: 1, finishedAt: null, status: "running", summary: "", error: null, review: null, commands: [] }]
  state.run.planV2!.sequence = 10
  await emit(page); await emit(page)
  await expect(page.locator('[data-task-id="T1"][data-column="running"]')).toHaveCount(1)
  state.run.planV2!.sequence = 2; task.status = "pending"
  await emit(page)
  await expect(page.locator('[data-task-id="T1"][data-column="running"]')).toHaveCount(1)
  state.offline = true
  await page.getByRole("button", { name: "Actualizar", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Sin conexión")
  await expect(page.getByRole("button", { name: "Pausar", exact: true })).toBeDisabled()
  state.offline = false; state.run.planV2!.sequence = 11; task.status = "completed"
  task.attempts[0].status = "completed"; task.attempts[0].finishedAt = 2
  await page.getByRole("button", { name: "Actualizar", exact: true }).click()
  await expect(page.locator('[data-task-id="T1"][data-column="verifying"]')).toHaveCount(1)
  task.attempts[0].reviewSessionId = "review-observed"
  task.attempts[0].review = { status: "approved", criteriaSatisfied: true, summary: "Resultados comprobados" }
  task.attempts[0].declaredChecks = ["node --test"]; task.attempts[0].commands = [{ command: "node --test", output: "passed", exitCode: 0 }]
  state.run.planV2!.sequence = 12; await emit(page)
  await expect(page.locator('[data-task-id="T1"][data-column="verified"]')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('[data-task-id="T1"][data-column="verified"]')).toHaveCount(1)
  expect(errors).toEqual([])
})

test("PWA conflicto entre ventanas: rechaza y recupera revisión durable sin repetir la operación", async ({ page }) => {
  const { state } = await setup(page)
  state.rejectPatch = true
  await page.getByRole("button", { name: "Abrir tarea T1: Validar formulario" }).click()
  await page.getByRole("button", { name: "Priorizar tarea pendiente" }).click()
  await expect(page.getByRole("alert")).toContainText("REVISION_CONFLICT")
  await expect(page.getByText("PLAN VIVO · v3")).toBeVisible()
  expect(state.patches).toHaveLength(1)
  expect(state.run.tasks[0].priority).toBeUndefined()
})

test("PWA sin token no consulta el tablero privado", async ({ page }) => {
  let requests = 0
  await page.addInitScript(() => localStorage.clear())
  await page.route("**/hub/teams**", route => { requests++; return route.fulfill({ status: 401 }) })
  await page.goto("/pwa.html?teams=1&chat=chat&run=run")
  await expect(page.getByText("Abrí este link desde el QR de Flufy", { exact: false })).toBeVisible()
  expect(requests).toBe(0)
})

test("PWA token revocado retira el snapshot privado y deshabilita las acciones", async ({ page }) => {
  const { state } = await setup(page)
  state.unauthorized = true
  await page.getByRole("button", { name: "Actualizar", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Acceso revocado")
  await expect(page.getByRole("region", { name: "Tablero de tareas", exact: true })).toHaveCount(0)
})
