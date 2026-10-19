import { expect, test, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Team, TeamChatRecord, TeamStore } from "../../src/team/types"

async function setup(page: Page) {
  const store: TeamStore = { schemaVersion: 1, teams: [], chats: [], skills: ["Frontend", "Backend", "QA"].map((name) => ({ id: name.toLowerCase(), name, version: 1, description: name, instructions: `Trabajar en ${name}`, verificationGuidelines: ["Comprobar cambios"] })) }
  const imageUrls = new Map<string, string>()
  const calls: { command: string; args: Record<string, unknown> }[] = []
  await page.addInitScript(() => {
    localStorage.clear()
    let next = 0
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++next, unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "plugin:event|listen") return ++next
        if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: "C:/qa/teams" }
        if (command.startsWith("plugin:")) return null
        const response = await fetch("/test-native", { method: "POST", body: JSON.stringify({ command, args }) })
        return response.json()
      },
    } })
    Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined } })
  })
  await page.route("**/test-native", async (route) => {
    const { command, args } = route.request().postDataJSON() as typeof calls[number]
    calls.push({ command, args })
    let result: unknown = null
    if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions", "fs_read_dir", "fs_list_files", "term_shells", "windows_list", "git_subrepos"].includes(command)) result = []
    if (command === "teams_state") result = store
    if (command === "teams_save") {
      const team = structuredClone(args.team as Team)
      if (!team.id) team.id = `team-${store.teams.length}`
      team.updatedAt = Date.now()
      store.teams = [...store.teams.filter((v) => v.id !== team.id), team]
      result = team
    }
    if (command === "team_chats_create") {
      const team = store.teams.find((v) => v.id === args.teamId)!
      const chat: TeamChatRecord = { id: `chat-${store.chats.length}`, title: team.name, team: structuredClone(team), skills: structuredClone(store.skills), archived: false, createdAt: Date.now(), runs: [] }
      store.chats.push(chat); result = chat
    }
    if (command === "team_chats_auto") {
      const team: Team = { autonomous: true, id: "auto", name: "Modo equipo", projectRoot: String(args.projectRoot), allowedRepositories: [String(args.projectRoot)], leadAgentId: "lead", maxParallelTasks: 8, maxRetriesPerTask: 1, updatedAt: Date.now(), members: [{ id: "lead", name: "Lead", role: "Lead", model: args.model as Team["members"][number]["model"], variant: args.variant as string | null, instructions: "", tools: ["read", "write", "bash"], skillRefs: [], maxConcurrentTasks: 1 }] }
      const chat: TeamChatRecord = { id: `chat-${store.chats.length}`, title: "Modo equipo", team, skills: structuredClone(store.skills), archived: false, createdAt: Date.now(), runs: [] }
      store.chats.push(chat); result = chat
    }
    if (command === "team_chat_send") {
      const chat = store.chats.find(c => c.id === args.chatId)!
      chat.messages ??= []
      const text = String(args.text)
      const images = (args.images as {filename: string; mime: string; url: string}[] ?? []).map((input, i) => {
        const id = `image-${imageUrls.size}-${i}`; imageUrls.set(id, input.url)
        return {id, filename: input.filename, mime: input.mime, bytes: 68, sha256: "fixture"}
      })
      const run = chat.runs.at(-1)
      chat.messages.push({ id: `u-${chat.messages.length}`, role: "user", text, images, status: "complete", createdAt: Date.now(), runId: run?.id ?? null, sessionId: null })
      if (/qué falló|cómo va/i.test(text)) {
        chat.messages.push({ id: `a-${chat.messages.length}`, role: "assistant", text: "Frontend quedó frenado en la página. Falta registrar la prueba HTTP. La tarea Backend terminada se conserva.", status: "complete", createdAt: Date.now(), runId: run?.id ?? null, sessionId: null })
      } else if (/corregilo/i.test(text) && run) {
        run.status = "running"; run.guidance = [text]
        chat.messages.push({ id: `a-${chat.messages.length}`, role: "assistant", text: "Voy a corregir lo pendiente. Las tareas terminadas se conservan.", status: "complete", createdAt: Date.now(), runId: run.id, sessionId: null })
      } else {
        const runId = `run-${chat.runs.length}`
        chat.runs.push({ id: runId, goal: text, images, team: structuredClone(chat.team), skills: structuredClone(chat.skills), status: "running", startedAt: Date.now(), finishedAt: null, planSessionId: "plan", tasks: [], summary: "", error: null, evidenceDir: "C:/qa/evidence/" + runId, artifacts: [], notified: false })
      }
      result = "reply"
    }
    if (command === "team_runs_start") {
      const chat = store.chats.find((v) => v.id === args.chatId)!
      const runId = `run-${chat.runs.length}`
      chat.runs.push({ id: runId, goal: String(args.goal), team: structuredClone(chat.team), skills: structuredClone(chat.skills), status: "running", startedAt: Date.now(), finishedAt: null, planSessionId: "plan", tasks: [], summary: "", error: null, evidenceDir: "C:/qa/evidence/" + runId, artifacts: [], notified: false }); result = runId
    }
    if (command === "team_runs_control") {
      const run = store.chats.flatMap((c) => c.runs).find((r) => r.id === args.runId)!
      if (args.action === "pause") run.status = "paused"
      if (args.action === "resume") run.status = "running"
      if (args.action === "approve") run.status = "qa_approved"
      result = true
    }
    if (command === "team_image_read") result = imageUrls.get(String(args.imageId)) ?? null
    if (command === "team_evidence_read") result = "Evidencia observada por el test de interfaz"
    if (command === "team_evidence_image") result = { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", sha256: "fixture" }
    if (command === "team_evidence_image" && process.env.GUILLE_TEAM_VISUAL_EVIDENCE_DIR) result = { mime: "image/png", data: (await readFile(join(process.env.GUILLE_TEAM_VISUAL_EVIDENCE_DIR, args.path === "before.png" ? "before.png" : "after.png"))).toString("base64"), sha256: "verified-by-native-integration" }
    if (command === "team_chats_edit") {
      const chat = store.chats.find((c) => c.id === args.id)!
      chat.title = String(args.title); chat.archived = Boolean(args.archived)
    }
    await route.fulfill({ json: result })
  })
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path === "/event") return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { lead: { id: "lead", name: "Lead Model", variants: { high: {} } }, worker: { id: "worker", name: "Worker Model" } } }] } })
    return route.fulfill({ json: path === "/session/status" ? {} : [] })
  })
  await page.goto("/")
  await page.getByTitle("Equipos IA", { exact: true }).click()
  await expect(page.getByRole("button", { name: "Crear equipo", exact: true })).toBeVisible()
  return { store, calls }
}

async function createTeam(page: Page) {
  await page.getByRole("button", { name: "Crear equipo", exact: true }).click()
  await page.getByLabel("Nombre del equipo", { exact: true }).fill("Team Backend")
  const members = page.locator(".team-employee")
  await expect(members).toHaveCount(4)
  await members.nth(0).getByLabel("Modelo del integrante").selectOption("openai/lead")
  await members.nth(0).getByLabel("Variante", { exact: true }).selectOption("high")
  await members.nth(2).getByLabel("Nombre del integrante").fill("Ana Backend")
  await members.nth(2).getByLabel("Modelo del integrante").selectOption("openai/worker")
  await members.nth(2).getByLabel("QA v1", { exact: true }).check()
  await page.screenshot({ path: test.info().outputPath("equipo-configurado.png") })
  await page.getByRole("button", { name: "Guardar y abrir Team Chat", exact: true }).click()
  await expect(page.locator(".team-chat-header")).toContainText("Team Backend")
}

test("modo equipo abre sin plantilla y muestra integrantes elegidos por el Lead y respuestas breves", async ({ page }) => {
  const { store, calls } = await setup(page)
  await page.getByRole("button", { name: "Modo equipo", exact: true }).click()
  await expect(page.locator(".team-chat-welcome")).toContainText("Él decide cuántos especialistas")
  expect(store.teams).toHaveLength(0)
  expect(store.chats[0].team.members).toHaveLength(1)
  expect(calls.filter(c => c.command === "team_chats_auto")).toHaveLength(1)
  await page.getByLabel("Mensaje para el equipo").fill("Necesito dos servicios backend y una pantalla")
  await page.getByLabel("Mensaje para el equipo").press("Enter")
  const run = store.chats[0].runs[0]
  for (const [id, name, role] of [["back-1", "Backend 1", "Backend"], ["back-2", "Backend 2", "Backend"], ["front-1", "Frontend 1", "Frontend"]]) {
    run.team.members.push({ ...structuredClone(run.team.members[0]), id, name, role })
    run.tasks.push({ id, title: name, objective: "Implementar y comprobar", assignedAgentId: id, repository: run.team.projectRoot, dependencies: [], expectedFiles: [], writePaths: [`${id}/`], acceptanceCriteria: ["Pruebas satisfactorias"], status: "running", attempts: [], error: null })
  }
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await expect(page.locator(".team-chat-header")).toContainText("4 integrantes")
  await page.getByText("Equipo elegido por el Lead", { exact: true }).click()
  await expect(page.locator(".team-roster")).toContainText("Backend 2")
  await page.screenshot({ path: test.info().outputPath("modo-equipo-paralelo.png") })
  run.status = "awaiting_manual_qa"; run.finishedAt = Date.now()
  run.chatSummary = { done: "Creé los dos servicios y la pantalla.", tested: "Las pruebas de integración pasaron.", pending: "Nada pendiente." }
  run.summary = "Detalle técnico completo: comando interno node --check backend/server.js y puertos de la integración. ".repeat(15)
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  const brief = page.locator(".team-lead-message .lead-brief")
  await expect(brief).toContainText("Creé los dos servicios")
  await expect(brief).toContainText("Falta tu revisión manual")
  await expect(page.locator(".lead-details")).not.toHaveAttribute("open", "")
  await expect(page.getByText(/Detalle técnico completo:/).first()).not.toBeVisible()
  await page.screenshot({ path: test.info().outputPath("lead-respuesta-breve.png") })
  await page.getByText("Detalles técnicos", { exact: true }).click()
  await expect(page.getByText(/Detalle técnico completo:/).first()).toBeVisible()
  await page.reload()
  await page.getByTitle("Equipos IA", { exact: true }).click()
  await page.locator(".team-sidebar-card").getByRole("button", { name: "Modo equipo", exact: true }).click()
  await expect(page.locator(".team-chat-header")).toContainText("4 integrantes")
  await expect(brief).toContainText("Las pruebas de integración pasaron")
  await expect(page.locator(".lead-details")).not.toHaveAttribute("open", "")
})

test("equipo con modelos distintos y skills combinables persiste; chat normal sigue accesible", async ({ page }) => {
  const { store } = await setup(page)
  await createTeam(page)
  expect(store.teams[0].members[0].model.modelID).toBe("lead")
  expect(store.teams[0].members[0].variant).toBe("high")
  const backend = store.teams[0].members.find((member) => member.name === "Ana Backend")!
  expect(backend.model.modelID).toBe("worker")
  expect(backend.skillRefs.map((s) => s.id)).toEqual(["backend", "qa"])
  await page.reload()
  await page.getByTitle("Equipos IA", { exact: true }).click()
  await page.locator(".team-sidebar-card").first().getByRole("button", { name: "Configurar", exact: true }).click()
  await expect(page.locator(".team-employee").nth(2).getByLabel("Nombre del integrante")).toHaveValue("Ana Backend")
  await page.getByRole("button", { name: "Nuevo chat (Ctrl+Alt+N)", exact: true }).click()
  await page.getByText("Chat normal", { exact: true }).click()
  await expect(page.locator(".team-chat")).toHaveCount(0)
  await expect(page.locator(".composer")).toBeVisible()
  await page.locator(".team-sidebar-card").last().getByRole("button", { name: "Team Backend", exact: true }).click()
  await expect(page.locator(".team-chat")).toBeVisible()
  await page.keyboard.press("Control+Alt+n")
  await expect(page.locator(".team-chat")).toHaveCount(0)
})

test("perfil Backend conserva skills extra y perfil Review quita herramientas de edición", async ({ page }) => {
  const { store } = await setup(page)
  store.skills.push({ id: "security", version: 2, name: "Security", description: "Guards", instructions: "Probar autorización", verificationGuidelines: ["Casos negativos"] })
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await createTeam(page)
  const member = page.locator(".team-employee").nth(2)
  await member.getByLabel("Aplicar perfil de skills").selectOption("Backend")
  await expect(member.getByLabel("Security v2", { exact: true })).toBeChecked()
  await expect(member.getByLabel("QA v1", { exact: true })).toBeChecked()
  await member.getByLabel("Aplicar perfil de skills").selectOption("Code Review")
  await member.getByText("Herramientas permitidas", { exact: true }).click()
  await expect(member.getByLabel("edit", { exact: true })).not.toBeChecked()
  await expect(member.getByLabel("write", { exact: true })).not.toBeChecked()
})

test("objetivo, pausa, entrega pendiente y feedback conservan revisiones en el mismo chat", async ({ page }) => {
  const { store, calls } = await setup(page)
  await createTeam(page)
  await page.getByLabel("Mensaje para el equipo").fill("Implementen usuarios y pruebas")
  await page.getByLabel("Mensaje para el equipo").press("Enter")
  await expect(page.getByRole("button", { name: "Pausar nuevas tareas" })).toBeVisible()
  const approvals = await page.evaluate(async () => {
    const a = await import(/* @vite-ignore */ "/src/state/approvals.ts")
    a.useApprovals.setState({ autoApprove: true, loaded: true })
    return { team: a.approveFor("plan"), normal: a.approveFor("unrelated") }
  })
  expect(approvals).toEqual({ team: false, normal: true })
  await page.getByRole("button", { name: "Pausar nuevas tareas" }).click()
  await expect(page.getByRole("button", { name: "Reanudar", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Reanudar", exact: true }).click()
  const first = store.chats[0].runs[0]
  first.status = "awaiting_manual_qa"; first.finishedAt = Date.now(); first.summary = "Terminamos. Cambios implementados. Pendiente de QA manual."
  first.artifacts = [{ id: "evidence", taskId: null, phase: "test", kind: "log", relativePath: "pruebas/log.txt", capturedAt: Date.now(), status: "captured", source: "fixture E2E", reason: null }]
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await page.getByRole("button", { name: "Resultados / Comportamientos", exact: true }).click()
  await expect(page.locator(".team-results").getByRole("heading", { name: "Pendiente de QA manual" })).toBeVisible()
  await page.getByRole("button", { name: "Ver evidencia", exact: true }).click()
  await expect(page.locator(".team-evidence-preview")).toContainText("Evidencia observada")
  await page.screenshot({ path: test.info().outputPath("entrega-qa-pendiente.png") })
  await page.getByLabel("Feedback de QA / siguiente mensaje").fill("Email duplicado devuelve 500. Corríjanlo")
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
  expect(store.chats).toHaveLength(1)
  expect(store.chats[0].runs).toHaveLength(2)
  expect(store.chats[0].runs[0].artifacts[0].relativePath).toBe("pruebas/log.txt")
  expect(calls.filter((c) => c.command === "team_chat_send")).toHaveLength(2)
})

test("el equipo abre como chat, envía con Enter y oculta controles técnicos irrelevantes", async ({ page }) => {
  const { store } = await setup(page)
  await createTeam(page)
  await expect(page.getByLabel("Presupuesto USD")).not.toBeVisible()
  await page.getByLabel("Mensaje para el equipo").fill("Corregí el flujo sin pedirme límites")
  await page.getByLabel("Mensaje para el equipo").press("Enter")
  const run = store.chats[0].runs[0]
  run.status = "blocked"
  run.error = "El plan debe contener entre 1 y 100 tareas"
  run.sessionUsage = { plan: { tokens: 100, costUsd: 0 } }
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await expect(page.getByRole("status")).toContainText("lo reparará automáticamente")
  await expect(page.getByRole("button", { name: "Reintentar automáticamente" })).toBeVisible()
  await expect(page.getByText("Ajustar límites de esta ejecución")).toHaveCount(0)
  await expect(page.getByText("Cambiar el modelo que falló")).toHaveCount(0)
  await expect(page.getByText("Uso de esta ejecución")).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("grupo-recuperacion-automatica.png") })
})

test("los errores guardados del proveedor son legibles en chat, tareas y actividad", async ({ page }) => {
  const { store } = await setup(page)
  await createTeam(page)
  await page.getByLabel("Mensaje para el equipo").fill("Revisá el proyecto")
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
  const run = store.chats[0].runs[0]
  const raw = JSON.stringify({ name: "APIError", data: { isRetryable: true, message: "The usage limit has been reached", responseBody: JSON.stringify({ error: { type: "usage_limit_reached" } }), responseHeaders: { "set-cookie": "PRIVATE-COOKIE", "x-codex-turn-state": "PRIVATE-STATE".repeat(500) } } })
  run.status = "blocked"; run.error = raw
  run.tasks = [{ id: "backend", title: "Backend", objective: "Revisar API", assignedAgentId: run.team.members[2].id, repository: "C:/qa/teams", dependencies: [], expectedFiles: [], acceptanceCriteria: ["API comprobada"], status: "blocked", error: raw, attempts: [{ id: "attempt", agent: run.team.members[2], sessionId: "worker", reviewSessionId: null, startedAt: Date.now(), finishedAt: null, status: "blocked", summary: "", error: raw, review: null, commands: [] }] }]
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  for (const view of ["Chat", "Tareas", "Actividad"]) {
    await page.getByRole("button", { name: view, exact: true }).click()
    await expect(page.locator(".team-chat")).toContainText("alcanzó su límite de uso")
    await expect(page.locator(".team-chat")).not.toContainText("responseHeaders")
    await expect(page.locator(".team-chat")).not.toContainText("PRIVATE-")
    const banner = await page.locator(".team-chat > .team-error").boundingBox()
    expect(banner!.height).toBeLessThan(160)
  }
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await expect(page.getByText("Ajustar límites de esta ejecución")).toHaveCount(0)
  run.tasks = []
  run.error = "fatal: not a git repository (or any of the parent directories): .git"
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await expect(page.locator(".team-chat > .team-error")).toContainText("Eso no impide trabajar en esa carpeta")
  await expect(page.locator(".team-chat > .team-error")).not.toContainText("fatal:")
  run.error = "Falta una comprobación satisfactoria observada para cada comando declarado."
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await expect(page.locator(".team-chat > .team-error")).toContainText("El agente dio pruebas por aprobadas, pero falta el registro")
  await page.screenshot({ path: test.info().outputPath("error-proveedor-legible.png") })
})

test("actividad muestra el pedido entre agentes y las respuestas del Lead", async ({ page }) => {
  const { store } = await setup(page)
  await createTeam(page)
  await page.getByLabel("Mensaje para el equipo").fill("Frontend y Backend en paralelo")
  await page.getByLabel("Mensaje para el equipo").press("Enter")
  const run = store.chats[0].runs[0]
  run.tasks = ["Backend", "Frontend"].map((role, index) => ({ id: role.toLowerCase(), title: role, objective: `Implementar ${role}`, assignedAgentId: run.team.members[index + 2].id, repository: "C:/qa/teams", dependencies: [], expectedFiles: [], writePaths: [`src/${role.toLowerCase()}/`], acceptanceCriteria: ["Integración comprobada"], status: index === 0 ? "running" : "waiting_dependency", attempts: [], error: null }))
  run.coordination = [{ id: "request", fromTaskId: "frontend", message: "Lead, falta el contrato de la API de usuarios", taskIds: ["backend"], status: "waiting", summary: "Backend está preparando el DTO", createdAt: Date.now(), sessions: ["coordination"], replies: [{ at: Date.now(), sessionId: "coordination", status: "wait", summary: "Backend está preparando el DTO; conservá la UI y seguí después con la integración", taskIds: ["backend"] }] }]
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await page.getByRole("button", { name: "Tareas", exact: true }).click()
  await expect(page.locator(".team-task-list")).toContainText("src/frontend/")
  await expect(page.locator(".team-task-list")).toContainText("Esperando respuesta del Lead")
  await page.getByRole("button", { name: "Actividad", exact: true }).click()
  await expect(page.locator(".team-chat-body")).toContainText("Frontend → Lead")
  await expect(page.locator(".team-chat-body")).toContainText("falta el contrato de la API")
  await expect(page.locator(".team-chat-body")).toContainText("Backend (Trabajando)")
  await expect(page.locator(".team-chat-body")).toContainText("conservá la UI")
  const approvals = await page.evaluate(async () => { const a = await import(/* @vite-ignore */ "/src/state/approvals.ts"); a.useApprovals.setState({ autoApprove: true, loaded: true }); return a.approveFor("coordination") })
  expect(approvals).toBe(false)
  await page.screenshot({ path: test.info().outputPath("coordinacion-paralela.png") })
})

test("comparador muestra ambos estados, desliza y conserva la ausencia de una captura", async ({ page }) => {
  const { store } = await setup(page)
  await page.setViewportSize({ width: 1600, height: 1600 })
  await createTeam(page)
  await page.getByTitle("Foco en el chat (Ctrl+Alt+M)", { exact: true }).click()
  await page.getByLabel("Mensaje para el equipo").fill("Mejorar el flujo visual")
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
  const run = store.chats[0].runs[0]
  run.status = "awaiting_manual_qa"
  run.summary = "Terminamos. Archivos modificados y capturas reales registradas. Queda pendiente tu QA manual."
  run.captureTargets = [{ id: "project", name: "Proyecto de prueba", url: "http://localhost:5173/app", width: 1280, height: 800, actions: [], maskSelectors: [], required: true }]
  run.observations = ["before", "after"].map((phase) => ({ id: phase, targetId: "project", phase, status: "captured", capturedAt: Date.now(), artifactPath: phase + ".png", reportPath: phase + ".json", sha256: phase, details: { width: 1280, height: 800, source: "fixture de imagen E2E" } }))
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await page.getByRole("button", { name: "Resultados / Comportamientos", exact: true }).click()
  const compare = page.getByRole("region", { name: "Comparador de evidencias" })
  await expect(compare.getByAltText("Antes del cambio")).toBeVisible()
  await expect(compare.getByAltText("Después del cambio")).toBeVisible()
  await compare.screenshot({ path: test.info().outputPath("comparador-lado-a-lado.png") })
  await compare.getByRole("button", { name: "Ampliar antes" }).click()
  await expect(page.getByRole("dialog", { name: "Antes del cambio ampliado" })).toBeVisible()
  await page.getByRole("button", { name: "Cerrar imagen" }).click()
  await compare.getByRole("button", { name: "Deslizar antes / después" }).click()
  await expect(compare.getByRole("slider", { name: "Posición antes y después" })).toHaveValue("50")
  await compare.getByRole("slider", { name: "Posición antes y después" }).fill("75")
  await expect(compare.locator(".team-image-divider")).toHaveCSS("left", /px$/)
  await compare.screenshot({ path: test.info().outputPath("comparador-deslizador.png") })
  run.observations[0] = { ...run.observations[0], id: "missing", status: "unavailable", artifactPath: null, details: { reason: "La aplicación no estaba iniciada antes del cambio" } }
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await expect(compare.getByText("La aplicación no estaba iniciada antes del cambio")).toBeVisible()
  await expect(compare.getByRole("button", { name: "Deslizar antes / después" })).toBeDisabled()
  const previous = structuredClone(run)
  previous.id = "previous-run"; previous.startedAt = run.startedAt - 1000
  previous.observations = [structuredClone(run.observations[1])]
  store.chats[0].runs.unshift(previous)
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await compare.getByLabel("Comparar contra").selectOption("previous-run")
  await expect(compare.getByAltText("Antes del cambio")).toBeVisible()
  await expect(compare.getByRole("button", { name: "Deslizar antes / después" })).toBeEnabled()
  previous.observations[0].status = "expired"
  previous.observations[0].details.reason = "Expiró según la retención configurada"
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await expect(compare.getByAltText("Antes del cambio")).toHaveCount(0)
  await expect(compare.getByText("Expiró según la retención configurada")).toBeVisible()
  await expect(compare.getByRole("button", { name: "Deslizar antes / después" })).toBeDisabled()
})


test("se conversa con el Lead durante bloqueos y trabajo sin duplicar las tareas", async ({ page }) => {
  const { store, calls } = await setup(page)
  await createTeam(page)
  const composer = page.getByLabel("Mensaje para el equipo")
  await composer.fill("Creá una página")
  await composer.press("Enter")
  await expect(page.getByRole("button", { name: "Pausar nuevas tareas" })).toBeVisible()
  const run = store.chats[0].runs[0]
  run.status = "blocked"; run.error = "Falta una comprobación satisfactoria observada"
  const member = run.team.members[1]
  run.tasks = [{ id: "front", title: "Página de saludo", objective: "Página", assignedAgentId: member.id, repository: run.team.projectRoot, dependencies: [], expectedFiles: [], acceptanceCriteria: [], status: "blocked", error: run.error, attempts: [{ id: "a", agent: member, sessionId: null, reviewSessionId: null, startedAt: Date.now(), finishedAt: null, status: "blocked", summary: "", error: null, review: null, commands: [{ command: "node --check app.js", exitCode: 0, output: "" }], declaredChecks: ["node test-http.js"] }] }]
  await page.evaluate(async () => { const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts"); await refreshTeams() })
  await expect(page.locator(".team-chat > .team-error")).toContainText("Página de saludo")
  await expect(page.locator(".team-chat > .team-error")).toContainText("Falta registrar el resultado")
  await composer.fill("¿Qué falló?")
  await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
  await composer.press("Enter")
  await expect(page.locator(".team-conversation.assistant")).toContainText("prueba HTTP")
  expect(store.chats[0].runs).toHaveLength(1)
  expect(run.status).toBe("blocked")
  await composer.fill("Corregilo y reintentá")
  await composer.press("Enter")
  await expect(page.getByRole("button", { name: "Pausar nuevas tareas" })).toBeVisible()
  await composer.fill("¿Cómo va?")
  await composer.press("Enter")
  await expect(page.locator(".team-conversation.assistant")).toHaveCount(3)
  expect(run.guidance).toEqual(["Corregilo y reintentá"])
  expect(store.chats[0].runs).toHaveLength(1)
  expect(calls.filter(c => c.command === "team_runs_start" || c.command === "team_runs_control")).toHaveLength(0)
  await page.reload()
  await page.getByTitle("Equipos IA", { exact: true }).click()
  await page.locator(".team-sidebar-card").last().getByRole("button", { name: "Team Backend", exact: true }).click()
  await expect(page.locator(".team-conversation.assistant")).toHaveCount(3)
  await page.screenshot({ path: test.info().outputPath("lead-conversacion-recuperada.png") })
})


test("imágenes: adjuntar, quitar, enviar y recuperar del historial", async ({ page }) => {
  const { store, calls } = await setup(page)
  await createTeam(page)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64")
  const input = page.getByLabel("Imágenes para el equipo")
  await input.setInputFiles([{name:"referencia.png",mimeType:"image/png",buffer:png},{name:"quitar.png",mimeType:"image/png",buffer:png}])
  await expect(page.locator(".team-image-drafts img")).toHaveCount(2)
  await page.getByRole("button",{name:"Quitar quitar.png",exact:true}).click()
  await expect(page.locator(".team-image-drafts img")).toHaveCount(1)
  await page.getByLabel("Mensaje para el equipo").fill("Creá la pantalla de esta imagen")
  await page.getByRole("button",{name:"Enviar",exact:true}).click()
  await expect(page.locator(".team-image-drafts img")).toHaveCount(0)
  await expect(page.locator(".team-chat-message img[alt='referencia.png']")).toBeVisible()
  const send = calls.find(c=>c.command==="team_chat_send")!
  expect((send.args.images as {url:string}[])[0].url).toBe(`data:image/png;base64,${png.toString("base64")}`)
  expect(store.chats[0].messages?.[0].images).toHaveLength(1)
  await page.reload()
  await page.getByTitle("Equipos IA",{exact:true}).click()
  await page.locator(".team-sidebar-card").last().getByRole("button",{name:"Team Backend",exact:true}).click()
  const image = page.locator(".team-chat-message img[alt='referencia.png']")
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src",`data:image/png;base64,${png.toString("base64")}`)
  await page.screenshot({path:test.info().outputPath("equipo-imagen-recuperada.png")})
})

test("imágenes: pegado, envío sin texto y error legible para formatos no admitidos", async ({ page }) => {
  const { calls } = await setup(page)
  await createTeam(page)
  await page.getByLabel("Imágenes para el equipo").setInputFiles({name:"vector.svg",mimeType:"image/svg+xml",buffer:Buffer.from("<svg/>")})
  await expect(page.getByRole("alert")).toContainText("PNG, JPEG, WebP o GIF")
  await page.getByLabel("Mensaje para el equipo").evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])],"pegada.png",{type:"image/png"}))
    element.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:transfer}))
  })
  await expect(page.locator(".team-image-drafts img")).toHaveCount(1)
  await expect(page.getByRole("button",{name:"Enviar",exact:true})).toBeEnabled()
  await page.getByRole("button",{name:"Enviar",exact:true}).click()
  await expect(page.locator(".team-image-drafts img")).toHaveCount(0)
  expect(calls.find(c=>c.command==="team_chat_send")?.args.text).toBe("")
  expect((calls.find(c=>c.command==="team_chat_send")?.args.images as unknown[])).toHaveLength(1)
})

test("configuración muestra asignación actual y modelos históricos de cada intento", async ({ page }) => {
  const {store} = await setup(page)
  await createTeam(page)
  await page.getByRole("button",{name:"Configuración del equipo",exact:true}).click()
  await expect(page.locator(".team-settings")).toContainText("Lead Model")
  await expect(page.locator(".team-settings")).toContainText("Worker Model")
  await expect(page.locator(".team-settings")).toContainText("high")
  await page.getByLabel("Mensaje para el equipo").fill("Implementá una pantalla")
  await page.getByRole("button",{name:"Enviar",exact:true}).click()
  const run = store.chats[0].runs[0], agent = run.team.members[2]
  run.tasks=[{id:"t",title:"API",objective:"API",assignedAgentId:agent.id,repository:run.team.projectRoot,dependencies:[],expectedFiles:[],acceptanceCriteria:[],status:"running",error:null,attempts:[{id:"a",agent:{...structuredClone(agent),model:{providerID:"openai",modelID:"lead"},variant:"high"},sessionId:"s",reviewSessionId:null,startedAt:Date.now(),finishedAt:null,status:"running",summary:"",error:null,review:null,commands:[]}]}]
  await page.evaluate(async()=>{const {refreshTeams}=await import(/* @vite-ignore */ "/src/state/teams.ts");await refreshTeams()})
  await page.getByRole("button",{name:"Configuración del equipo",exact:true}).click()
  const backend = page.locator(".team-settings > .team-card").filter({has:page.getByRole("heading",{name:"Ana Backend · Backend",exact:true})})
  await expect(backend).toContainText("Worker Model")
  await backend.getByText("Modelo del intento en curso · API",{exact:true}).click()
  await expect(backend).toContainText("Lead Model")
  await page.screenshot({path:test.info().outputPath("configuracion-modelos-equipo.png")})
})
