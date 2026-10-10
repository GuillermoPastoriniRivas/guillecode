import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/memoria"
const now = Date.now()

const overview = {
  scope: root,
  slug: "memoria",
  preferences: "- respondé en español",
  overview: "- proyecto de prueba",
  notes: [{ id: "decision-base", title: "Base de datos", kind: "decision", updated: new Date(now - 40000).toISOString(), preview: "Usamos PostgreSQL", source: "agent" }],
  tasks: [{ id: "s1", title: "Trabajo de prueba", updated: new Date(now - 20000).toISOString(), directory: root, progress: "Faltan los tests", lastUser: "Implementá el login", source: "agent" }],
}

async function setup(page: Page) {
  await page.addInitScript(({ root, overview }) => {
    const key = root.toLowerCase()
    localStorage.setItem(`guillecode:agent.openSessions@${key}`, JSON.stringify(["s1"]))
    localStorage.setItem(`guillecode:agent.activeSession@${key}`, JSON.stringify("s1"))
    let id = 0
    const calls: Array<{ command: string; args: unknown }> = []
    const noteBodies: Record<string, string> = { "decision-base": "Usamos PostgreSQL" }
    const fullTask = { ...overview.tasks[0], updatedAt: overview.tasks[0].updated, progress: `Faltan los tests\n${"Detalle del trabajo. ".repeat(30)}\nÚltimo paso pendiente: verificar el login.` }
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
          if (command === "memory_overview") return structuredClone(overview)
          if (command === "memory_set_session") return { ok: true, enabled: (args as { enabled: boolean }).enabled }
          if (command === "memory_read_note") {
            const path = (args as { id: string }).id
            if (path.includes("/tasks/")) return { path, content: JSON.stringify(fullTask) }
            const id = path.split("/").at(-1)!.replace(/\.md$/, "")
            const note = overview.notes.find((note) => note.id === id)
            return note ? { path, content: `---\ntitle: ${note.title}\ntype: ${note.kind}\n---\n\n${noteBodies[id]}` } : { error: "No existe" }
          }
          if (command.startsWith("memory_write_") && (window as unknown as { __memoryFail?: boolean }).__memoryFail) return { error: "No se pudo escribir el archivo" }
          if (command === "memory_write_note") {
            const input = args as { id?: string; title: string; kind: string; body: string }
            const id = input.id ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
            overview.notes = overview.notes.filter((note) => note.id !== id)
            overview.notes.push({ id, title: input.title, kind: input.kind, updated: new Date().toISOString(), preview: input.body.slice(0, 140), source: "user" })
            noteBodies[id] = input.body
            return { ok: true, id }
          }
          if (command === "memory_delete_note") {
            const id = (args as { id: string }).id.split("/").at(-1)!.replace(/\.md$/, "")
            overview.notes = overview.notes.filter((note) => note.id !== id)
            return { ok: true }
          }
          if (command === "memory_write_task") {
            Object.assign(fullTask, args, { source: "user" })
            overview.tasks = [{ ...fullTask, progress: fullTask.progress.slice(0, 300) }]
            return { ok: true }
          }
          if (command === "memory_delete_task") { overview.tasks = []; return { ok: true } }
          if (command === "memory_write_preferences") { overview.preferences = (args as { body: string }).body; return { ok: true } }
          if (command === "memory_write_overview") { overview.overview = (args as { body: string }).body; return { ok: true } }
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
  await page.locator(".memory-editor").getByRole("button", { name: "Ver estado", exact: true }).first().click()
  await expect(page.locator(".memory-editor").getByText(/Último paso pendiente: verificar el login\./)).toBeVisible()
  await expect(page.locator(".memory-editor .memory-origin.agent").first()).toContainText("Agente")
  const read = await page.evaluate(() => (window as unknown as { __memoryCalls: Array<{ command: string; args: { id?: string } }> }).__memoryCalls.filter((c) => c.command === "memory_read_note"))
  expect(read.at(-1)?.args.id).toBe("workspaces/memoria/tasks/s1.json")
  await page.getByRole("button", { name: "Continuar en un chat nuevo", exact: true }).click()
  await expect(page.locator(".agent-panel textarea")).toHaveValue(/Continuá con el trabajo «Trabajo de prueba»[\s\S]*Último paso pendiente: verificar el login\./)
})

test("Memoria está junto a Rutinas y permite editar y borrar una nota conservando su identidad", async ({ page }) => {
  await setup(page)
  const activity = page.locator(".activity-bar")
  await expect(activity.locator('button[title="Rutinas"] + button[title="Memoria"]')).toBeVisible()
  await activity.getByRole("button", { name: "Memoria", exact: true }).click()
  const sidebar = page.locator(".memory-view")
  await expect(sidebar).toContainText("Preferencias globales")
  await sidebar.getByRole("button", { name: "Base de datos", exact: true }).click()
  const editor = page.locator(".memory-editor")
  await expect(editor.getByText("Usamos PostgreSQL")).toBeVisible()
  await expect(editor.getByRole("textbox", { name: "Contenido de la nota", exact: true })).toHaveCount(0)
  await editor.getByRole("button", { name: "Editar", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Contenido de la nota", exact: true })).toHaveValue("Usamos PostgreSQL")
  await page.getByRole("textbox", { name: "Título de la nota", exact: true }).fill("Base de datos revisada")
  await page.getByRole("textbox", { name: "Contenido de la nota", exact: true }).fill("PostgreSQL con backups diarios")
  await editor.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(sidebar.getByRole("button", { name: "Base de datos revisada", exact: true })).toBeVisible()
  const write = await page.evaluate(() => (window as unknown as { __memoryCalls: Array<{ command: string; args: unknown }> }).__memoryCalls.filter((c) => c.command === "memory_write_note").at(-1))
  expect(write?.args).toMatchObject({ scope: root, id: "decision-base", title: "Base de datos revisada", kind: "decision", body: "PostgreSQL con backups diarios" })
  await editor.getByRole("button", { name: "Eliminar nota", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click()
  await expect(sidebar.getByRole("button", { name: "Base de datos revisada", exact: true })).toBeVisible()
  await editor.getByRole("button", { name: "Eliminar nota", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click()
  await expect(sidebar.getByRole("button", { name: "Base de datos revisada", exact: true })).toHaveCount(0)
  const removed = await page.evaluate(() => (window as unknown as { __memoryCalls: Array<{ command: string; args: unknown }> }).__memoryCalls.filter((c) => c.command === "memory_delete_note").at(-1))
  expect(removed?.args).toEqual({ id: "workspaces/memoria/notes/decision-base.md" })
})

test("el sidebar navega preferencias y proyecto en la misma pestaña y permite guardar y borrar", async ({ page }) => {
  await setup(page)
  await page.locator('.activity-bar button[title="Memoria"]').click()
  const sidebar = page.locator(".memory-view")
  const editor = page.locator(".memory-editor")
  await sidebar.getByRole("button", { name: "Preferencias globales", exact: true }).click()
  await expect(editor.getByText("- respondé en español")).toBeVisible()
  await editor.getByRole("button", { name: "Editar", exact: true }).click()
  const prefs = page.getByRole("textbox", { name: "Preferencias globales", exact: true })
  await prefs.fill("Respuestas breves en español")
  await editor.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.locator(".toasts")).toContainText("Preferencias guardadas")
  await sidebar.getByRole("button", { name: "Descripción del proyecto", exact: true }).click()
  await expect(editor.getByText("- proyecto de prueba")).toBeVisible()
  await editor.getByRole("button", { name: "Editar", exact: true }).click()
  const project = page.getByRole("textbox", { name: "Descripción del proyecto", exact: true })
  await project.fill("Aplicación de pruebas")
  await editor.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.locator(".toasts")).toContainText("Descripción del proyecto guardada")
  await editor.getByRole("button", { name: "Borrar", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Borrar", exact: true }).click()
  await expect(editor.getByText("Sin descripción del proyecto todavía.")).toBeVisible()
  await sidebar.getByRole("button", { name: "Preferencias globales", exact: true }).click()
  await expect(editor.getByText("Respuestas breves en español")).toBeVisible()
  await editor.getByRole("button", { name: "Borrar", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Borrar", exact: true }).click()
  await expect(editor.getByText("Sin preferencias guardadas todavía.")).toBeVisible()
  await expect(page.locator(".tab-label").filter({ hasText: /^Memoria$/ })).toHaveCount(1)
})

test("el estado completo del trabajo se lee, edita y elimina desde el sidebar", async ({ page }) => {
  await setup(page)
  await page.locator('.activity-bar button[title="Memoria"]').click()
  const sidebar = page.locator(".memory-view")
  const editor = page.locator(".memory-editor")
  await sidebar.getByRole("button", { name: "Trabajo de prueba", exact: true }).click()
  await expect(editor.getByText(/Último paso pendiente: verificar el login\./)).toBeVisible()
  await editor.getByRole("button", { name: "Editar", exact: true }).click()
  const progress = page.getByRole("textbox", { name: "Progreso guardado", exact: true })
  await expect(progress).toHaveValue(/Último paso pendiente: verificar el login\./)
  await progress.fill("Login terminado. Falta desplegar.")
  await editor.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.locator(".toasts")).toContainText("Trabajo actualizado")
  await page.getByRole("button", { name: "Continuar en un chat nuevo", exact: true }).click()
  await expect(page.locator(".agent-panel textarea")).toHaveValue(/Login terminado\. Falta desplegar\./)
  await editor.getByRole("button", { name: "Eliminar", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click()
  await expect(sidebar.getByRole("button", { name: "Trabajo de prueba", exact: true })).toHaveCount(0)
  const removed = await page.evaluate(() => (window as unknown as { __memoryCalls: Array<{ command: string; args: unknown }> }).__memoryCalls.filter((c) => c.command === "memory_delete_task").at(-1))
  expect(removed?.args).toEqual({ scope: root, id: "s1" })
})

test("una escritura fallida muestra el error y conserva el contenido editado", async ({ page }) => {
  await setup(page)
  await page.locator('.activity-bar button[title="Memoria"]').click()
  const editor = page.locator(".memory-editor")
  await page.locator(".memory-view").getByRole("button", { name: "Base de datos", exact: true }).click()
  await editor.getByRole("button", { name: "Editar", exact: true }).click()
  const body = page.getByRole("textbox", { name: "Contenido de la nota", exact: true })
  await body.fill("Cambio que debe conservarse")
  await page.evaluate(() => { (window as unknown as { __memoryFail: boolean }).__memoryFail = true })
  await editor.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.locator(".toasts")).toContainText("No se pudo escribir el archivo")
  await expect(body).toHaveValue("Cambio que debe conservarse")
  await expect(page.locator(".toasts")).not.toContainText("Nota actualizada")
})
