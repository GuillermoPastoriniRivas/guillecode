import { expect, test, type Page } from "@playwright/test"

async function setup(page: Page) {
  const state = { available: true, failed: false, busy: false, blocked: false, downloads: 0, installs: 0 }
  await page.addInitScript(() => {
    let id = 0
    const callbacks = new Map<number, (event: unknown) => void>()
    const events = new Map<string, number>()
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (fn: (event: unknown) => void) => { callbacks.set(++id, fn); return id },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "plugin:event|listen") { events.set(String(args.event), Number(args.handler)); return ++id }
        if (command === "plugin:app|version") return "0.3.0"
        if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: "" }
        if (["update_check", "update_download", "update_install", "live_busy_sessions"].includes(command)) {
          if (command === "update_download") callbacks.get(events.get("update://progress")!)?.({ payload: { downloaded: 500, total: 1000 } })
          const response = await fetch(`/test-updates/${command}`)
          const data = await response.json()
          if (!response.ok) throw data.error
          return data
        }
        if (["recent_projects", "routines_list", "auth_entries"].includes(command)) return []
        return null
      },
    } })
  })
  await page.route("**/test-updates/*", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop()
    if (command === "update_check") return route.fulfill({ json: state.available ? { version: "0.3.1", currentVersion: "0.3.0", notes: "Mejoras de prueba" } : null })
    if (command === "live_busy_sessions") return route.fulfill({ json: state.busy ? ["session-other-project"] : [] })
    if (command === "update_download") {
      state.downloads++
      return route.fulfill({ status: state.failed ? 500 : 200, json: state.failed ? { error: "firma inválida" } : true })
    }
    if (command === "update_install") {
      state.installs++
      return route.fulfill({ status: state.blocked ? 409 : 200, json: state.blocked ? { error: "Hay rutinas trabajando" } : true })
    }
    return route.fulfill({ json: null })
  })
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path === "/event") return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [] } })
    return route.fulfill({ json: path === "/session/status" ? {} : [] })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Actualizaciones", exact: true }).click()
  await expect(page.getByText("Nueva versión disponible: 0.3.1")).toBeVisible()
  return state
}

test("descarga sin instalar, Más tarde conserva la descarga y reinicio exige confirmación", async ({ page }) => {
  const state = await setup(page)
  await page.getByRole("button", { name: "Descargar actualización", exact: true }).click()
  await expect(page.getByText("Lista para instalar: 0.3.1")).toBeVisible()
  expect(state.installs).toBe(0)
  await page.getByRole("button", { name: "Más tarde", exact: true }).click()
  await page.getByRole("button", { name: "Reiniciar para actualizar", exact: true }).click()
  await page.getByRole("button", { name: "Instalar y reiniciar", exact: true }).click()
  const confirmation = page.getByRole("dialog").filter({ hasText: "Instalar actualización y reiniciar" })
  await confirmation.getByRole("button", { name: "Más tarde" }).click()
  expect(state.installs).toBe(0)
  await page.getByRole("button", { name: "Instalar y reiniciar", exact: true }).click()
  await confirmation.getByRole("button", { name: "Instalar y reiniciar", exact: true }).click()
  await expect(page.getByText("Instalando actualización…")).toBeVisible()
  expect(state.downloads).toBe(1)
  expect(state.installs).toBe(1)
})

test("firma inválida permite reintentar sin instalar y agentes de otro proyecto bloquean reinicio", async ({ page }) => {
  const state = await setup(page)
  state.failed = true
  await page.getByRole("button", { name: "Descargar actualización", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("firma inválida")
  expect(state.installs).toBe(0)
  state.failed = false
  await page.getByRole("button", { name: "Reintentar descarga" }).click()
  state.busy = true
  await page.getByRole("button", { name: "Instalar y reiniciar", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Hay agentes trabajando")
  expect(state.installs).toBe(0)
})

test("si comienza una rutina durante la confirmación el backend conserva la descarga", async ({ page }) => {
  const state = await setup(page)
  await page.getByRole("button", { name: "Descargar actualización", exact: true }).click()
  await page.getByRole("button", { name: "Instalar y reiniciar", exact: true }).click()
  state.blocked = true
  await page.getByRole("dialog").filter({ hasText: "Instalar actualización y reiniciar" }).getByRole("button", { name: "Instalar y reiniciar", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Hay rutinas trabajando")
  await expect(page.getByText("Lista para instalar: 0.3.1")).toBeVisible()
  expect(state.downloads).toBe(1)
})
