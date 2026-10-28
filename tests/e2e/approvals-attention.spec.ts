import { expect, test, type Page } from "@playwright/test"

async function setup(page: Page) {
  await page.route("**/attention-test", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Flufy</title>" }))
  await page.goto("/attention-test")
  await page.clock.install()
  await page.evaluate(async () => {
    const effects = { tones: 0, notifications: [] as string[] }
    Object.assign(window, {
      Notification: class {
        static permission = "granted"
        constructor(_title: string, options: { body: string }) { effects.notifications.push(options.body) }
      },
      AudioContext: class {
        currentTime = 0
        destination = {}
        resume() { return Promise.resolve() }
        createOscillator() {
          return { frequency: { value: 0 }, connect: (gain: unknown) => gain, start: () => effects.tones++, stop: () => undefined }
        }
        createGain() {
          return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined }
        }
      },
    })
    const agent = await import("/src/state/agent.ts")
    const approvals = await import("/src/state/approvals.ts")
    const attention = await import("/src/state/attention.ts")
    const { useToasts } = await import("/src/state/toasts.ts")
    const { sessionMark } = await import("/src/state/unseen.ts")
    const now = Date.now()
    const session = (id: string, parentID?: string) => ({ id, parentID, title: id, directory: "C:/qa/demo", time: { created: now, updated: now } })
    agent.useAgent.setState({ allSessions: [session("auto"), session("child", "auto"), session("nested", "child"), session("manual")] })
    approvals.useApprovals.setState({ loaded: true, autoApprove: false, sessions: { auto: true } })
    attention.initAttention()
    const request = (id: string, sessionID: string) => ({ id, sessionID, permission: "bash", patterns: ["npm test"], metadata: {}, always: [] })
    const snapshot = () => {
      const state = agent.useAgent.getState()
      return {
        count: attention.useAttention.getState().count,
        alerting: attention.useAttention.getState().alerting,
        target: attention.pendingSessionId(state),
        mark: sessionMark(state, {}, "auto"),
        toasts: useToasts.getState().toasts.map((t) => t.detail),
        tones: effects.tones,
        notifications: [...effects.notifications],
      }
    }
    Object.assign(window, { qa: { agent, approvals, attention, effects, request, snapshot } })
  })
}

const snapshot = (page: Page) => page.evaluate(() => (window as any).qa.snapshot())

test("los permisos automáticos de la conversación y sus subagentes no avisan; el manual sí", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const { agent, request } = (window as any).qa
    agent.useAgent.setState({ permissions: [request("p1", "auto"), request("p2", "child"), request("p3", "nested")] })
  })
  await page.clock.runFor(6000)
  expect(await snapshot(page)).toEqual({ count: 0, alerting: false, target: null, mark: "idle", toasts: [], tones: 0, notifications: [] })

  await page.evaluate(() => {
    const { agent, approvals, request } = (window as any).qa
    approvals.useApprovals.setState({ autoApprove: true, sessions: { manual: false } })
    agent.useAgent.setState((s: any) => ({ permissions: [...s.permissions, request("p4", "manual")] }))
  })
  expect(await snapshot(page)).toMatchObject({ count: 1, alerting: true, target: "manual", mark: "idle", tones: 2, toasts: ["1 permiso sin responder. El agente está esperando."], notifications: ["1 permiso sin responder. El agente está esperando."] })
})

test("activar Aprueba solo corta la alerta; un fallo o una pregunta vuelven a requerir atención", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const { agent, approvals, request } = (window as any).qa
    approvals.setApprovalForSession("auto", false)
    agent.useAgent.setState({ permissions: [request("p1", "child")] })
  })
  expect(await snapshot(page)).toMatchObject({ count: 1, alerting: true, mark: "attention", tones: 2 })

  await page.evaluate(() => (window as any).qa.approvals.setApprovalForSession("auto", true))
  await page.clock.runFor(6000)
  expect(await snapshot(page)).toMatchObject({ count: 0, alerting: false, mark: "idle", toasts: [], tones: 2 })
  await expect(page).toHaveTitle("Flufy")

  await page.evaluate(() => (window as any).qa.approvals.markApprovalFailed("p1"))
  expect(await snapshot(page)).toMatchObject({ count: 1, alerting: true, target: "child", mark: "attention", tones: 4 })
  await page.evaluate(() => {
    const { agent, approvals } = (window as any).qa
    agent.useAgent.setState({ permissions: [] })
    approvals.clearApprovalFailed("p1")
    agent.useAgent.setState({ questions: [{ id: "q1", sessionID: "child", questions: [] }] })
  })
  expect(await snapshot(page)).toMatchObject({ count: 1, alerting: true, target: "child", mark: "attention", tones: 6, toasts: ["1 pregunta sin responder. El agente está esperando."] })
})

test("cargar la configuración no dispara un aviso transitorio y los permisos manuales se habilitan al cargar", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const { agent, approvals, request } = (window as any).qa
    approvals.useApprovals.setState({ loaded: false, sessions: {} })
    agent.useAgent.setState({ permissions: [request("p1", "auto")] })
  })
  expect(await snapshot(page)).toMatchObject({ count: 0, alerting: false, tones: 0, notifications: [] })
  await page.evaluate(() => (window as any).qa.approvals.useApprovals.setState({ loaded: true, sessions: { auto: true } }))
  expect(await snapshot(page)).toMatchObject({ count: 0, alerting: false, tones: 0, notifications: [] })
  await page.evaluate(() => (window as any).qa.approvals.useApprovals.setState({ sessions: {} }))
  expect(await snapshot(page)).toMatchObject({ count: 1, alerting: true, tones: 2 })
})

test("no llega una notificación tardía si Aprueba solo se activa mientras se pide el permiso de notificar", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const qa = (window as any).qa
    window.Notification.permission = "default"
    window.Notification.requestPermission = () => new Promise((resolve) => { qa.resolvePermission = resolve })
    qa.approvals.setApprovalForSession("auto", false)
    qa.agent.useAgent.setState({ permissions: [qa.request("p1", "auto")] })
  })
  expect(await snapshot(page)).toMatchObject({ count: 1, alerting: true, notifications: [] })
  await page.evaluate(() => {
    const qa = (window as any).qa
    qa.approvals.setApprovalForSession("auto", true)
    qa.resolvePermission("granted")
  })
  expect(await snapshot(page)).toMatchObject({ count: 0, alerting: false, toasts: [], notifications: [] })
})
