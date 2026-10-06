import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/worktrees"
const worktree = `${root}/.worktrees/login`

async function setup(page: Page, unknown = false) {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  const settings = { run: "npm run dev", setup: "npm install", copy: [] }
  const shared = { id: null, group: null, detached: false, locked: null, prunable: null, missing: false, archived: false, baseOid: "base-oid", createdAt: null, merging: false, ahead: 1, behind: 0 }
  const list = {
    git: true, multi: false, project: root, repo: root, defaultBase: "origin/develop", worktreesDir: `${root}/.worktrees`, settings,
    repos: [{ path: root, main: root, name: "worktrees", branch: "develop", head: "base-oid", detached: false, defaultBase: "origin/develop", worktreesDir: `${root}/.worktrees`, settings, changes: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, merging: false }],
    features: [
      { ...shared, path: root, root, repo: root, label: "Principal", kind: "main", branch: "develop", head: "base-oid", base: null, baseSource: "unknown", changes: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 } },
      { ...shared, path: worktree, root: worktree, repo: root, label: "Login", kind: "external", branch: "feature/login", head: "feature-oid", base: unknown ? null : "origin/develop", baseSource: unknown ? "unknown" : "reflog", changes: { staged: 0, unstaged: 1, untracked: 1, conflicts: 0 } },
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
        if (command === "plugin:app|version") return "0.6.0"
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
    if (command === "features_diff") {
      const base = args.base || list.features[1].base
      result = { base, mergeBase: base ? "base-oid" : null, head: base ? "feature-oid" : null, commits: base ? 1 : 0, files: base ? [
        { path: "login.txt", orig: null, status: "A", additions: 12, deletions: 0 },
        ...(base === "origin/main" ? [{ path: "develop-only.txt", orig: null, status: "A", additions: 5, deletions: 0 }] : []),
      ] : [] }
    }
    if (command === "git_show_file") result = args.rev === "base-oid" ? "base\n" : "login\n"
    if (command === "git_diff_file") result = "diff --git a/pending.txt b/pending.txt\n--- a/pending.txt\n+++ b/pending.txt\n@@ -1 +1 @@\n-base\n+pending\n"
    if (command === "fs_read_file") result = { content: "pending\n", bom: false, size: 8, mtime: 1 }
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
  await expect(page.locator(".feature-row", { hasText: "Login" })).toBeVisible()
  return { calls, list }
}

async function assertPrincipalAndAppPreserved(page: Page) {
  const state = await page.evaluate(async () => {
    const { useProject } = await import(/* @vite-ignore */ "/src/state/project.ts")
    const { useTerminals } = await import(/* @vite-ignore */ "/src/state/terminals.ts")
    return { root: useProject.getState().root, terminals: useTerminals.getState().terminals.map((t: { id: string }) => t.id) }
  })
  expect(state.root).toBe(root)
  expect(state.terminals).toContain("qa-app")
}

test("supervisa commits y pendientes contra origin/develop sin activar el worktree ni detener la app", async ({ page }) => {
  const { calls } = await setup(page)
  const killsBefore = calls.filter((c) => c.command.startsWith("term_kill")).length
  const row = page.locator(".feature-row", { hasText: "Login" })
  await expect(row).toContainText("Base: origin/develop")
  await row.click()
  const changes = page.locator(".feature-changes")
  await expect(changes).toContainText("Cambios propios vs origin/develop")
  await expect(changes).toContainText("1 commit")
  await expect(changes).toContainText("login.txt")
  await expect(changes).toContainText("pending.txt")
  await expect(changes).toContainText("new.txt")
  await expect(changes).not.toContainText("develop-only.txt")
  await changes.getByTitle("Comparar sin cambiar la base del worktree ni la carpeta activa").click()
  await page.getByRole("option", { name: "origin/main", exact: false }).click()
  await expect(changes).toContainText("Cambios propios vs origin/main")
  await expect(changes).toContainText("develop-only.txt")
  await expect(row).toContainText("Base: origin/develop")
  await changes.getByTitle("Comparar sin cambiar la base del worktree ni la carpeta activa").click()
  await page.getByRole("option", { name: "Base: origin/develop" }).click()
  await expect(changes).not.toContainText("develop-only.txt")
  await changes.locator(".scm-row", { hasText: "login.txt" }).click()
  await expect(page.locator(".tabs .tab", { hasText: "Login vs origin/develop" })).toBeVisible()
  await changes.locator(".scm-row", { hasText: "pending.txt" }).click()
  await assertPrincipalAndAppPreserved(page)
  expect(calls.filter((c) => c.command.startsWith("term_kill"))).toHaveLength(killsBefore)
  expect(calls.some((c) => c.command === "features_update" || c.command === "git_checkout")).toBe(false)
  expect(calls.filter((c) => c.command === "features_diff").every((c) => c.args.path === worktree && c.args.project === root)).toBe(true)
  expect(calls.some((c) => c.command === "git_show_file" && c.args.worktree === worktree)).toBe(true)
})

test("un origen desconocido no se presenta como main y permite una comparación temporal", async ({ page }) => {
  const { calls } = await setup(page, true)
  const row = page.locator(".feature-row", { hasText: "Login" })
  await expect(row).toContainText("Base: por determinar")
  await row.click()
  const changes = page.locator(".feature-changes")
  await expect(changes).toContainText("No se asume main")
  await changes.getByTitle("Comparar sin cambiar la base del worktree ni la carpeta activa").click()
  await page.getByRole("option", { name: "origin/develop", exact: false }).click()
  await expect(changes).toContainText("Cambios propios vs origin/develop")
  await expect(row).toContainText("Base: por determinar")
  await assertPrincipalAndAppPreserved(page)
  await row.hover()
  await row.getByTitle("Integrar…").click()
  await expect(page.locator(".feature-page h1")).toHaveText("Login")
  await page.locator(".feature-page .select-trigger").click()
  await expect(page.getByRole("option", { name: "main", exact: true })).toBeVisible()
  await expect(page.locator(".feature-page .select-trigger")).toContainText("Elegí")
  expect((await page.evaluate(async () => {
    const { useFeatures } = await import(/* @vite-ignore */ "/src/state/features.ts")
    return useFeatures.getState().list?.features.find((f: { label: string }) => f.label === "Login")?.base
  }))).toBeNull()
  expect(calls.some((c) => c.command === "features_merge_preview")).toBe(false)
})

test("nuevo worktree lleva al pedido al agente y no a un formulario Git", async ({ page }) => {
  const { calls } = await setup(page)
  await page.getByTitle("Pedir al agente un nuevo worktree").click()
  await expect(page.getByPlaceholder(/^Pedile algo al agente/)).toHaveValue(/Quiero trabajar en un worktree separado/)
  await expect(page.getByText("Preparar el entorno", { exact: true })).not.toBeVisible()
  expect(calls.some((c) => c.command === "features_create" || c.command === "features_copy_candidates")).toBe(false)
  await assertPrincipalAndAppPreserved(page)
})

test("dos worktrees con los mismos commits y archivo mantienen revisiones independientes", async ({ page }) => {
  const { list } = await setup(page)
  const other = `${root}/.worktrees/reportes`
  list.features.push({ ...list.features[1], path: other, root: other, label: "Reportes", branch: "feature/reportes" })
  await page.evaluate(async () => {
    const { refreshFeatures } = await import(/* @vite-ignore */ "/src/state/features.ts")
    await refreshFeatures()
  })
  await page.locator(".feature-row", { hasText: "Login" }).click()
  await page.locator(".feature-changes .scm-row", { hasText: "login.txt" }).click()
  const first = page.locator(".tabs .tab", { hasText: "Login vs origin/develop" })
  await expect(first).toBeVisible()
  await first.dblclick()
  await page.locator(".feature-row", { hasText: "Reportes" }).click()
  await page.locator(".feature-changes").nth(1).locator(".scm-row", { hasText: "login.txt" }).click()
  await expect(first).toBeVisible()
  await expect(page.locator(".tabs .tab", { hasText: "Reportes vs origin/develop" })).toBeVisible()
  await assertPrincipalAndAppPreserved(page)
})
