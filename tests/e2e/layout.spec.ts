import { expect, test, type Page } from "@playwright/test"

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    let id = 0
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
      invoke: async () => null,
    } })
  })
  await page.route("**/test-native", (route) => route.fulfill({ json: [] }))
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
}

const width = (page: Page) =>
  page.evaluate(async () => (await import(/* @vite-ignore */ "/src/state/layout.ts")).useLayout.getState().agentWidth)

test("el chat en foco se puede redimensionar y vuelve a su ancho al salir", async ({ page }) => {
  await boot(page)
  const before = await width(page)
  expect(before).toBeGreaterThan(0)

  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(true)
  })
  const focus = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    return { width: useLayout.getState().agentWidth, win: window.innerWidth, on: useLayout.getState().focusChat }
  })
  expect(focus.on).toBe(true)
  // En foco-chat el chat puede ocupar más que el tope del modo normal (0.72 del ancho).
  expect(focus.width).toBeGreaterThan(Math.round(focus.win * 0.72))

  // Se puede achicar a mano (antes quedaba fijo).
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().setAgentWidth(420)
  })
  expect(await width(page)).toBe(420)

  // Al salir del foco vuelve al ancho previo, no al ancho expandido.
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(false)
  })
  expect(await width(page)).toBe(before)
})

test("abrir el panel inferior cancela el foco y restaura el ancho", async ({ page }) => {
  await boot(page)
  const before = await width(page)
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(true)
    useLayout.getState().togglePanel()
  })
  const state = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    return { on: useLayout.getState().focusChat, width: useLayout.getState().agentWidth }
  })
  expect(state.on).toBe(false)
  expect(state.width).toBe(before)
})

test("en foco-chat con ventana angosta el ancho igual se puede mover", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 })
  await boot(page)
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(true)
  })
  const range = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().setAgentWidth(99999)
    const hi = useLayout.getState().agentWidth
    useLayout.getState().setAgentWidth(1)
    const lo = useLayout.getState().agentWidth
    return { hi, lo, focus: useLayout.getState().focusChat }
  })
  expect(range.focus).toBe(true)
  // Debe haber margen para agrandar y achicar (antes quedaba trabado con min == max).
  expect(range.hi).toBeGreaterThan(range.lo)
})
