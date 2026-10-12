import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/worktrees"
const worktree = `${root}/.worktrees/login`

const changes = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }

async function setup(page: Page, unknown = false) {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  const settings = { run: "npm run dev", setup: "npm install", copy: [] }
  const mainRepo = { repo: root, name: "worktrees", path: root, root, branch: "develop", head: "base-oid", detached: false, base: null, baseSource: "unknown", kind: "main", missing: false, changes, merging: false, ahead: null, behind: null }
  const featureRepo = { repo: root, name: "worktrees", path: worktree, root: worktree, branch: "feature/login", head: "feature-oid", detached: false, base: unknown ? null : "origin/develop", baseSource: unknown ? "unknown" : "reflog", kind: "feature", missing: false, changes: { staged: 0, unstaged: 1, untracked: 1, conflicts: 0 }, merging: false, ahead: 1, behind: 0 }
  const shared = { id: null, group: null, detached: false, locked: null, prunable: null, missing: false, archived: false, baseOid: "base-oid", createdAt: null, merging: false, ahead: 1, behind: 0 }
  const list = {
    git: true, multi: false, project: root, repo: root, defaultBase: "origin/develop", worktreesDir: `${root}/.worktrees`, settings,
    repos: [{ path: root, main: root, name: "worktrees", branch: "develop", head: "base-oid", detached: false, defaultBase: "origin/develop", worktreesDir: `${root}/.worktrees`, settings, changes, merging: false }],
    features: [
      { ...shared, path: root, root, repo: root, label: "Principal", kind: "main", branch: "develop", head: "base-oid", base: null, baseSource: "unknown", changes },
      { ...shared, path: worktree, root: worktree, repo: root, label: "Login", kind: "external", branch: "feature/login", head: "feature-oid", base: unknown ? null : "origin/develop", baseSource: unknown ? "unknown" : "reflog", changes: { staged: 0, unstaged: 1, untracked: 1, conflicts: 0 } },
    ],
    workspaces: [
      { id: "main", label: "Principal", kind: "main", createdAt: null, archived: false, repos: [mainRepo] },
      { id: "g1", label: "Login", kind: "feature", createdAt: 1, archived: false, repos: [featureRepo] },
    ],
  }
  await page.addInitScript(() => {
    localStorage.clear()
    let id = 0
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "plugin:event|listen") return ++id
        if (command === "plugin:app|version") return "0.11.0"
        if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: "C:/qa/worktrees" }
        if (command.startsWith("plugin:")) return null
        const response = await fetch("/test-native", { method: "POST", body: JSON.stringify({ command, args }) })
        return response.json()
      },
    } })
  })
  await page.route("**/test-native", async (route) => {
    const { command, args } = route.request().postDataJSON() as typeof calls[number]
    calls.push({ command, args })
    let result: unknown = null
    if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions", "fs_read_dir", "fs_list_files", "term_shells", "windows_list"].includes(command)) result = []
    if (command === "features_list") result = list
    if (command === "git_subrepos") result = [root]
    if (command === "git_root") result = root
    if (command === "git_status") result = {
      branch: args.worktree === worktree ? "feature/login" : "develop", detached: false, upstream: null, gone: false, ahead: 0, behind: 0, truncated: false, merging: false,
      staged_added: 0, staged_removed: 0, unstaged_added: 0, unstaged_removed: 0,
      entries: args.worktree === worktree ? [{ path: "pending.txt", orig: null, index: " ", worktree: "M" }, { path: "new.txt", orig: null, index: "?", worktree: "?" }] : [],
    }
    if (command === "git_branches") result = ["main", "develop", "origin/main", "origin/develop"].map((name) => ({ name, full: `refs/${name.startsWith("origin/") ? "remotes" : "heads"}/${name}`, remote: name.startsWith("origin/"), current: false, upstream: name === "develop" ? "origin/develop" : null, time: 0, subject: "" }))
    await route.fulfill({ json: result })
  })
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { m: { id: "m", name: "Modelo QA" } } }] } })
    if (path === "/session/status") return route.fulfill({ json: {} })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().showView("scm", false)
    useLayout.setState({ panelVisible: false })
    const { useTerminals } = await import(/* @vite-ignore */ "/src/state/terminals.ts")
    useTerminals.setState({ terminals: [{ id: "qa-app", shell: null, cwd: "C:/qa/worktrees", root: "C:/qa/worktrees", title: "app", exited: false, exitCode: null, agent: true }], activeId: null })
    const { useFeatures } = await import(/* @vite-ignore */ "/src/state/features.ts")
    useFeatures.setState({ runTerminalId: "qa-app" })
  })
  await expect(page.locator(".feature-row", { hasText: "Principal" })).toBeVisible()
  return { calls, list }
}

async function state(page: Page) {
  return page.evaluate(async () => {
    const { useProject } = await import(/* @vite-ignore */ "/src/state/project.ts")
    const { useTerminals } = await import(/* @vite-ignore */ "/src/state/terminals.ts")
    const { useFeatures } = await import(/* @vite-ignore */ "/src/state/features.ts")
    const { useGit } = await import(/* @vite-ignore */ "/src/state/git.ts")
    return {
      root: useProject.getState().root,
      terminals: useTerminals.getState().terminals.map((t: { id: string }) => t.id),
      workspace: useFeatures.getState().activeWorkspace,
      repos: useGit.getState().repos,
      activeRepo: useGit.getState().activeRepo,
    }
  })
}

test("muestra Principal y cada trabajo, y cambia de espacio sin cerrar terminales ni cambiar la carpeta", async ({ page }) => {
  const { calls } = await setup(page)
  const killsBefore = calls.filter((c) => c.command.startsWith("term_kill")).length
  const login = page.locator(".feature-row", { hasText: "Login" })
  await expect(login).toBeVisible()
  await expect(login).toContainText("feature/login")
  await login.click()
  await expect.poll(async () => (await state(page)).workspace).toBe("g1")
  const after = await state(page)
  expect(after.root).toBe(root)
  expect(after.terminals).toContain("qa-app")
  expect(after.repos).toEqual([worktree])
  expect(after.activeRepo).toBe(worktree)
  expect(calls.filter((c) => c.command.startsWith("term_kill"))).toHaveLength(killsBefore)
  expect(calls.some((c) => c.command === "features_update" || c.command === "git_checkout")).toBe(false)
  expect(calls.some((c) => c.command === "git_status" && c.args.worktree === worktree)).toBe(true)
  // Volver a Principal reapunta los repos a la copia principal.
  await page.locator(".feature-row", { hasText: "Principal" }).click()
  await expect.poll(async () => (await state(page)).workspace).toBe("main")
  expect((await state(page)).repos).toEqual([root])
})

test("un origen desconocido no se presenta como main", async ({ page }) => {
  await setup(page, true)
  const base = await page.evaluate(async () => {
    const { useFeatures } = await import(/* @vite-ignore */ "/src/state/features.ts")
    return useFeatures.getState().list?.workspaces.find((w: { id: string }) => w.id === "g1")?.repos[0].base ?? null
  })
  expect(base).toBeNull()
  await page.locator(".feature-row", { hasText: "Login" }).click()
  await expect.poll(async () => (await state(page)).workspace).toBe("g1")
})

test("pedir un trabajo nuevo lleva al pedido al agente y no a un formulario Git", async ({ page }) => {
  const { calls } = await setup(page)
  await page.getByTitle("Pedirle al agente un trabajo nuevo").click()
  await expect(page.getByPlaceholder(/^Pedile algo al agente/)).toHaveValue(/Quiero trabajar en un trabajo separado/)
  expect(calls.some((c) => c.command === "features_create" || c.command === "workspace_create" || c.command === "features_copy_candidates")).toBe(false)
  const after = await state(page)
  expect(after.root).toBe(root)
  expect(after.terminals).toContain("qa-app")
})

test("el chip del título muestra el espacio de trabajo activo", async ({ page }) => {
  await setup(page)
  await expect(page.locator(".title-feature")).toContainText("Principal")
  await page.locator(".feature-row", { hasText: "Login" }).click()
  await expect(page.locator(".title-feature")).toContainText("Login")
})
