import { expect, test, type Page } from "@playwright/test"

async function setup(page: Page, failSend = false, transcript = "Mensaje dictado") {
  page.on("pageerror", (error) => console.error(error.message))
  const sent: unknown[] = []
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => ({ getTracks: () => [{ stop() {} }] }),
    })
    class FakeRecorder {
      static isTypeSupported() { return true }
      state = "inactive"
      mimeType = "audio/webm"
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start() { this.state = "recording" }
      stop() {
        this.state = "inactive"
        this.ondataavailable?.({ data: new Blob(["fake audio"]) })
        this.onstop?.()
      }
    }
    Object.assign(window, { MediaRecorder: FakeRecorder })
  })
  await page.route("**/oc/config/providers?*", (route) => route.fulfill({ json: {
    providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { model: { id: "model", name: "Test model" } } }],
  } }))
  await page.route("**/hub/transcribe", (route) => route.fulfill({ json: { text: transcript } }))
  await page.route("**/test-send", async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: failSend ? 500 : 200, body: "" })
  })
  await page.route("**/voice-test", (route) => route.fulfill({ contentType: "text/html", body: `
    <div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { Composer } = await import('/src/pwa/Composer.tsx');
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Composer, {
        directory: 'test-project', placeholder: 'Mensaje', initialModel: { providerID: 'openai', modelID: 'model' },
        favorites: [], voice: true,
        onSend: async (draft) => {
          const response = await fetch('/test-send', { method: 'POST', body: JSON.stringify(draft) });
          if (!response.ok) throw new Error('No se pudo enviar');
        },
      }));
    </script>
  ` }))
  await page.goto("/voice-test", { waitUntil: "domcontentloaded" })
  await expect(page.getByText("Test model", { exact: true })).toBeVisible()
  return sent
}

async function record(page: Page) {
  await page.getByRole("button", { name: "Grabar audio", exact: true }).click()
  await expect(page.getByText(/Grabando/)).toBeVisible()
  await page.waitForTimeout(750)
  await page.getByRole("button", { name: "Terminar y enviar" }).click()
}

for (const prefix of ["", "Contexto escrito"]) {
  test(`envía el audio automáticamente${prefix ? " junto con el borrador" : ""}`, async ({ page }) => {
    const sent = await setup(page)
    if (prefix) await page.getByRole("textbox").fill(prefix)
    await record(page)
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toEqual({ text: prefix ? `${prefix} Mensaje dictado` : "Mensaje dictado", attachments: [], model: { providerID: "openai", modelID: "model" } })
    await expect(page.getByRole("textbox")).toHaveValue("")
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeDisabled()
    expect(sent).toHaveLength(1)
  })
}

test("conserva la transcripción si falla el envío y permite reintentar", async ({ page }) => {
  const sent = await setup(page, true)
  await record(page)
  await expect(page.getByText("No se pudo enviar", { exact: true })).toBeVisible()
  await expect(page.getByRole("textbox")).toHaveValue("Mensaje dictado")
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
  await expect.poll(() => sent.length).toBe(2)
})

test("no envía un audio sin transcripción", async ({ page }) => {
  const sent = await setup(page, false, "")
  await record(page)
  await expect(page.getByText("No se entendió nada en el audio.", { exact: true })).toBeVisible()
  expect(sent).toHaveLength(0)
})
