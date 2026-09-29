import { expect, test, type Page } from "@playwright/test"

// All credentials, IPC and provider HTTP calls are simulated; never touches auth.json.
async function setup(page: Page, initial: string[] = []) {
  const accounts = new Set(initial)
  const mutations: string[] = []
  await page.addInitScript(() => {
    let next = 0
    const callbacks = new Map()
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (fn: unknown) => { callbacks.set(++next, fn); return next },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === "server_config") return { url: `${location.origin}/test-oc`, username: "test", password: "test", worktree: "" }
        if (cmd === "auth_entries") return fetch("/test-auth").then((r) => r.json())
        if (cmd === "validate_opencode_key") { if (args.key !== "test-go-key") throw "OpenCode Go rechazó la clave"; return null }
        if (cmd === "recent_projects" || cmd === "live_busy_sessions" || cmd === "routines_list") return []
        if (cmd === "plugin:event|listen") return ++next
        if (cmd.startsWith("plugin:window|is_")) return false
        return null
      },
    } })
  })
  await page.route("**/test-auth", (route) => route.fulfill({ json: [...accounts].map((id) => ({ id, kind: id === "openai" ? "oauth" : "api" })) }))
  await page.route("**/test-oc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path === "/event") return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path.startsWith("/auth/")) {
      const id = path.split("/").pop()!
      mutations.push(`${route.request().method()} ${id}`)
      if (route.request().method() === "DELETE") accounts.delete(id)
      else accounts.add(id)
      return route.fulfill({ json: true })
    }
    if (path === "/provider/openai/oauth/authorize") return route.fulfill({ json: { url: "https://example.test/login", method: "code", instructions: "Enter code: TEST-CODE" } })
    if (path === "/provider/openai/oauth/callback") { accounts.add("openai"); return route.fulfill({ json: true }) }
    if (path === "/config/providers") return route.fulfill({ json: { providers: [
      // The engine includes free models even without an account: they must not bypass onboarding.
      { id: "opencode", name: "OpenCode", source: "custom", options: { apiKey: "public" }, models: { free: { id: "free", name: "Free" } } },
      ...[...accounts].map((id) => ({ id, name: id === "openai" ? "ChatGPT" : "OpenCode Go", source: "api", options: { apiKey: id === "openai" ? "opencode-oauth-dummy-key" : "test" }, models: { model: { id: `${id}-model`, name: `${id} model` } } })),
    ] } })
    return route.fulfill({ json: path === "/session/status" ? {} : [] })
  })
  await page.goto("/")
  return { accounts, mutations }
}

test("sin cuentas exige una; key inválida no se guarda; OpenCode solo habilita continuar", async ({ page }) => {
  const { mutations } = await setup(page)
  await expect(page.getByRole("heading", { name: "Bienvenido a GuilleCode" })).toBeVisible()
  const proceed = page.getByRole("button", { name: "Continuar con GuilleCode" })
  await expect(proceed).toBeDisabled()
  await page.getByLabel("API key de OpenCode Go").fill("invalid-test-key")
  await page.getByRole("button", { name: "Conectar OpenCode", exact: true }).click()
  await expect(page.getByText("OpenCode Go rechazó la clave")).toBeVisible()
  expect(mutations).toEqual([])
  await page.getByLabel("API key de OpenCode Go").fill("test-go-key")
  await page.getByRole("button", { name: "Conectar OpenCode", exact: true }).click()
  await expect(proceed).toBeEnabled()
  await expect(page.getByLabel("Elegí el modelo que querés usar")).toHaveValue("opencode-go/opencode-go-model")
  await expect(page.getByLabel("API key de OpenCode Go")).toHaveValue("")
  expect(mutations).toEqual(["PUT opencode-go"])
  await proceed.click()
  await expect(page.locator(".no-project").getByRole("button", { name: "Abrir carpeta" })).toBeVisible()
})

test("ChatGPT solo puede continuar sin key de OpenCode", async ({ page }) => {
  const { mutations } = await setup(page)
  await page.getByRole("button", { name: "Con un código", exact: true }).click()
  await expect(page.getByRole("button", { name: "Continuar con GuilleCode" })).toBeEnabled()
  await expect(page.getByLabel("Elegí el modelo que querés usar")).toHaveValue("openai/openai-model")
  expect(mutations).toEqual([])
})

test("ambos: selecciona cualquiera, quitar el activo pasa al restante; quitar último vuelve al onboarding", async ({ page }) => {
  await setup(page, ["openai", "opencode-go"])
  await page.getByRole("button", { name: "Cuentas de IA", exact: true }).click()
  await page.getByLabel("Elegí el modelo que querés usar").selectOption("opencode-go/opencode-go-model")
  const goRow = page.locator(".accounts-list li").filter({ hasText: "OpenCode Go" })
  await goRow.getByRole("button", { name: "Quitar", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Quitar", exact: true }).click()
  await expect(page.getByLabel("Elegí el modelo que querés usar")).toHaveValue("openai/openai-model")
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Desconectar", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Bienvenido a GuilleCode" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Continuar con GuilleCode" })).toBeDisabled()
})
