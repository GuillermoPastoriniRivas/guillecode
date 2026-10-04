import { create } from "zustand"
import {
  featuresCreate,
  featuresList,
  featuresRemove,
  featuresRemoveCheck,
  featuresSetSettings,
  featuresUpdate,
  featuresUpdateFromBase,
  type Feature,
  type FeatureList,
  type MergeResult,
  type ProjectSettings,
  type RepoGroup,
} from "../lib/features"
import { gitBranches } from "../lib/git"
import { api } from "../lib/opencode"
import { readFile, stat } from "../lib/fs"
import { joinPath, samePath } from "../lib/paths"
import { debounce } from "../lib/persist"
import { errorMessage, isTauri, onEvent } from "../lib/tauri"
import { useProject } from "./project"
import { activateRoot } from "./workspace"
import {
  focusComposer,
  loadOtherSessions,
  newSession,
  onForeignSession,
  selectSession,
  sessionInRoot,
  setKnownDirectories,
  useAgent,
} from "./agent"
import { killTerminal, runInTerminal, useTerminals } from "./terminals"
import { repoForPath, setActiveRepo, useGit } from "./git"
import { useLayout } from "./layout"
import { openEditor } from "./editors"
import { pickOne, promptInput } from "./quickinput"
import { notify } from "./toasts"
import { ask } from "../components/Dialog"
import { dirtyPaths } from "../editor/documents"

type FeaturesState = {
  list: FeatureList | null
  loading: boolean
  error: string | null
  runTerminalId: string | null
  showArchived: boolean
}

export const useFeatures = create<FeaturesState>(() => ({
  list: null,
  loading: false,
  error: null,
  runTerminalId: null,
  showArchived: false,
}))

export function featureTitle(f: Pick<Feature, "kind" | "label" | "group">): string {
  if (f.kind === "main") return "Principal"
  return f.group ? `${f.group} · ${f.label}` : f.label
}

export function findFeature(root: string | null, list: FeatureList | null = useFeatures.getState().list): Feature | null {
  if (!root || !list) return null
  return list.features.find((f) => samePath(f.root, root)) ?? null
}

export function activeFeature(): Feature | null {
  return findFeature(useProject.getState().root)
}

function requireProject(): string {
  const project = useProject.getState().project
  if (!project) throw new Error("Abrí un proyecto primero")
  return project
}

function scopeOf(feature: Pick<Feature, "repo">): string {
  return feature.repo || requireProject()
}

export function findGroup(path: string | null | undefined, list: FeatureList | null = useFeatures.getState().list): RepoGroup | null {
  if (!path || !list) return null
  return list.repos.find((g) => samePath(g.path, path) || samePath(g.main, path)) ?? null
}

function contextScope(): string {
  return activeFeature()?.repo || requireProject()
}

export function contextSettings(list: FeatureList | null = useFeatures.getState().list, root = useProject.getState().root): ProjectSettings | null {
  if (!list) return null
  const feature = findFeature(root, list)
  return findGroup(feature?.repo, list)?.settings ?? list.settings
}

export async function openFeatureCreate(repo?: string): Promise<void> {
  const list = useFeatures.getState().list
  if (!list?.git) {
    notify.info("Las features necesitan un repositorio git", "Abrí un repo, o una carpeta que tenga repos adentro")
    return
  }
  if (!list.multi) {
    openEditor({ kind: "featureCreate" })
    return
  }
  let target = repo ? findGroup(repo, list) : null
  if (!target) {
    const preferred = activeFeature()?.repo || useGit.getState().activeRepo
    const ordered = [...list.repos].sort((a, b) => Number(samePath(b.main, preferred ?? "")) - Number(samePath(a.main, preferred ?? "")))
    const choice = await pickOne(
      ordered.map((g) => ({ id: g.path, label: g.name, description: g.branch ?? "HEAD detached", icon: "repo" })),
      { title: "Nueva feature", placeholder: "¿En qué repositorio?" },
    )
    if (!choice) return
    target = findGroup(choice.id, list)
  }
  if (target) openEditor({ kind: "featureCreate", repo: target.path })
}

let generation = 0

export async function refreshFeatures(): Promise<void> {
  const project = useProject.getState().project
  if (!project || !isTauri) return
  const gen = ++generation
  useFeatures.setState({ loading: true })
  try {
    const list = await featuresList(project)
    if (gen !== generation) return
    useFeatures.setState({ list, loading: false, error: null })
    setKnownDirectories(list.features.filter((f) => !f.missing).map((f) => f.root))
    void loadOtherSessions()
    keepActiveRootValid(list)
  } catch (e) {
    if (gen === generation) useFeatures.setState({ loading: false, error: errorMessage(e) })
  }
}

const scheduleRefresh = debounce(() => void refreshFeatures(), 2500)

function keepActiveRootValid(list: FeatureList): void {
  const { root, project } = useProject.getState()
  if (!root || !project || samePath(root, project)) return
  const current = findFeature(root, list)
  if (current && !current.missing) return
  notify.warning("La feature que tenías abierta ya no existe", "Volviste a la copia principal del proyecto")
  void activateRoot(project, { silent: true })
}

let started = false

export function initFeatures(): void {
  if (started) return
  started = true
  onForeignSession((directory, sessionID) => void openSessionIn(directory, sessionID))
  void refreshFeatures()
  if (!isTauri) return
  onEvent("features://changed", () => scheduleRefresh())
  window.addEventListener("focus", () => scheduleRefresh())
  setInterval(() => {
    if (!document.hidden) scheduleRefresh()
  }, 30000)
  useGit.subscribe((s, prev) => {
    if (s.revision !== prev.revision) scheduleRefresh()
  })
}

async function openSessionIn(directory: string, sessionID: string): Promise<void> {
  const feature = findFeature(directory)
  if (!feature || feature.missing) {
    notify.warning("Esa conversación es de una feature que ya no está disponible")
    return
  }
  const ok = await activateRoot(feature.root, { label: featureTitle(feature) })
  if (!ok) return
  useLayout.getState().toggleAgent(true)
  selectSession(sessionID)
}

export async function switchToFeature(feature: Feature): Promise<boolean> {
  if (feature.missing) {
    notify.warning("La carpeta de esta feature ya no existe", "Eliminala de la lista o restaurá la carpeta")
    return false
  }
  const ok = await activateRoot(feature.root, { label: featureTitle(feature) })
  if (ok) notify.info(`Ahora en ${featureTitle(feature)}`, feature.branch ?? undefined)
  return ok
}

export async function pickFeature(): Promise<void> {
  const list = useFeatures.getState().list
  if (!list?.git) {
    notify.info("Las features necesitan un repositorio git", "Abrí un repo, o una carpeta que tenga repos adentro")
    return
  }
  const root = useProject.getState().root
  const visible = list.features.filter((f) => !f.archived || (root && samePath(f.root, root)))
  const choice = await pickOne(
    [
      ...visible.map((f) => ({
        id: f.root,
        label: featureTitle(f),
        description: f.missing
          ? "carpeta no encontrada"
          : list.multi && f.kind === "main"
            ? `${list.repos.length} repositorios`
            : (f.branch ?? "HEAD detached"),
        icon: root && samePath(f.root, root) ? "check" : f.kind === "main" ? "home" : "git-branch",
      })),
      { id: "__new__", label: "Nueva feature…", icon: "add" },
    ],
    { title: "Cambiar de feature", placeholder: "Elegí una feature" },
  )
  if (!choice) return
  if (choice.id === "__new__") {
    await openFeatureCreate()
    return
  }
  const feature = list.features.find((f) => samePath(f.root, choice.id))
  if (feature) await switchToFeature(feature)
}

export type CreateInput = {
  repo: string | null
  label: string
  branch: string
  base: string
  existing: boolean
  copy: string[]
  setup: string | null
  open: boolean
  prompt: string
}

export async function createFeature(input: CreateInput): Promise<Feature | null> {
  try {
    const project = input.repo || requireProject()
    const result = await featuresCreate({
      project,
      label: input.label,
      branch: input.branch,
      base: input.base,
      existing: input.existing,
      copy: input.copy,
    })
    if (result.skipped.length > 0) notify.warning("Algunos archivos no se copiaron", result.skipped.join("\n"))
    const settings = settingsOf(project)
    if ((input.setup ?? null) !== (settings?.setup ?? null)) await saveSettings({ setup: input.setup }, project)
    await refreshFeatures()
    notify.success(`Feature «${result.feature.label}» creada`, result.feature.branch ?? undefined)
    if (input.open) {
      const ok = await activateRoot(result.feature.root, { label: result.feature.label })
      if (ok) {
        if (input.setup) void runInTerminal(input.setup, { newTerminal: true, cwd: result.feature.root, title: "preparar" })
        if (input.prompt.trim()) {
          useLayout.getState().toggleAgent(true)
          newSession()
          focusComposer(input.prompt.trim())
        }
      }
    }
    return result.feature
  } catch (e) {
    notify.error("No se pudo crear la feature", errorMessage(e))
    return null
  }
}

export function settingsOf(scope: string, list: FeatureList | null = useFeatures.getState().list): ProjectSettings | null {
  if (!list) return null
  return findGroup(scope, list)?.settings ?? list.settings
}

export async function saveSettings(patch: Partial<ProjectSettings>, scope: string = contextScope()): Promise<void> {
  const current = settingsOf(scope) ?? { run: null, setup: null, copy: [] }
  const next = { ...current, ...patch }
  await featuresSetSettings(scope, next)
  useFeatures.setState((s) => {
    if (!s.list) return {}
    const repos = s.list.repos.map((g) => (samePath(g.path, scope) ? { ...g, settings: next } : g))
    const settings = samePath(s.list.project, scope) ? next : s.list.settings
    return { list: { ...s.list, repos, settings } }
  })
}

export async function renameFeature(feature: Feature): Promise<void> {
  const label = await promptInput({
    title: "Renombrar feature",
    value: feature.label,
    validate: (v) => (v.trim() ? null : "Escribí un nombre"),
  })
  if (!label) return
  try {
    await featuresUpdate({ project: scopeOf(feature), path: feature.path, label: label.trim() })
    await refreshFeatures()
  } catch (e) {
    notify.error("No se pudo renombrar", errorMessage(e))
  }
}

export async function setArchived(feature: Feature, archived: boolean): Promise<void> {
  try {
    await featuresUpdate({ project: scopeOf(feature), path: feature.path, archived })
    await refreshFeatures()
    notify.info(archived ? `«${feature.label}» archivada` : `«${feature.label}» vuelve a la lista`)
  } catch (e) {
    notify.error(archived ? "No se pudo archivar" : "No se pudo desarchivar", errorMessage(e))
  }
}

export async function changeBase(feature: Feature): Promise<void> {
  let branches
  try {
    branches = await gitBranches(feature.path)
  } catch (e) {
    notify.error("No se pudieron listar las ramas", errorMessage(e))
    return
  }
  const choice = await pickOne(
    branches
      .filter((b) => b.name !== feature.branch)
      .map((b) => ({
        id: b.name,
        label: b.name,
        description: b.name === feature.base ? "base actual" : b.subject,
        icon: b.name === feature.base ? "check" : b.remote ? "cloud" : "git-branch",
        group: b.remote ? "remotas" : "locales",
      })),
    { title: `Rama base de «${feature.label}»`, placeholder: "Contra qué rama se compara e integra" },
  )
  if (!choice) return
  try {
    await featuresUpdate({ project: scopeOf(feature), path: feature.path, base: choice.id })
    await refreshFeatures()
  } catch (e) {
    notify.error("No se pudo cambiar la base", errorMessage(e))
  }
}

export function featureSessions(feature: Feature): { busy: number; waiting: number; total: number } {
  const s = useAgent.getState()
  const sessions = s.allSessions.filter((x) => sessionInRoot(x, feature.root))
  const ids = new Set(sessions.map((x) => x.id))
  const busy = sessions.filter((x) => s.statuses[x.id] && s.statuses[x.id].type !== "idle").length
  const waiting = s.permissions.filter((p) => ids.has(p.sessionID)).length + s.questions.filter((q) => ids.has(q.sessionID)).length
  return { busy, waiting, total: sessions.length }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export async function removeFeature(feature: Feature): Promise<void> {
  if (feature.kind === "main") return
  const project = requireProject()
  const scope = scopeOf(feature)
  const activity = featureSessions(feature)
  if (activity.busy > 0) {
    notify.warning("Hay agentes trabajando en esta feature", "Esperá a que terminen o detenelos antes de eliminarla")
    return
  }
  let check
  try {
    check = await featuresRemoveCheck(scope, feature.path)
  } catch (e) {
    notify.error("No se pudo revisar la feature", errorMessage(e))
    return
  }
  if (check.locked) {
    notify.warning("La feature está bloqueada", `${check.locked}. Desbloqueala con git worktree unlock`)
    return
  }
  const tracked = check.changes.staged + check.changes.unstaged + check.changes.conflicts
  const risks: string[] = []
  if (tracked > 0) risks.push(plural(tracked, "archivo con cambios sin commitear", "archivos con cambios sin commitear"))
  if (check.changes.untracked > 0) risks.push(plural(check.changes.untracked, "archivo nuevo sin commitear", "archivos nuevos sin commitear"))
  if (check.ignoredTotal > 0) risks.push(`${plural(check.ignoredTotal, "archivo ignorado por git", "archivos ignorados por git")} (por ejemplo ${check.ignored.slice(0, 3).join(", ")})`)
  if (check.unmerged > 0 && check.base) risks.push(`${plural(check.unmerged, "commit", "commits")} que no están en ${check.base}`)
  const dirty = tracked > 0 || check.changes.untracked > 0
  const message = check.missing
    ? "La carpeta ya no existe: se limpia el registro de git. Las conversaciones quedan en el historial."
    : `${risks.length > 0 ? `Ojo: ${risks.join("; ")}. ` : "No tiene cambios sin commitear. "}Las conversaciones quedan en el historial.`
  const choice = await ask(`Eliminar «${feature.label}»`, {
    message,
    icon: risks.length > 0 ? "warning" : "question",
    buttons: [
      { id: "cancel", label: "Cancelar" },
      { id: "folder", label: "Solo la carpeta" },
      { id: "branch", label: `Carpeta y rama ${check.branch ?? ""}`.trim(), danger: true },
    ],
  })
  if (choice !== "folder" && choice !== "branch") return
  let force = false
  if (dirty && !check.missing) {
    const sure = await ask("Se pierden los cambios sin commitear", {
      message: `${check.dirty.slice(0, 6).join(", ")}${check.dirty.length > 6 ? "…" : ""}. Esto no se puede deshacer.`,
      icon: "warning",
      buttons: [
        { id: "cancel", label: "Cancelar" },
        { id: "force", label: "Eliminar igual", danger: true },
      ],
    })
    if (sure !== "force") return
    force = true
  }
  let forceBranch = false
  if (choice === "branch" && check.unmerged > 0) {
    const sure = await ask(`La rama tiene ${plural(check.unmerged, "commit", "commits")} sin integrar`, {
      message: `Si la borrás, esos commits quedan sin rama. ¿Borrarla igual o conservarla?`,
      icon: "warning",
      buttons: [
        { id: "cancel", label: "Cancelar" },
        { id: "keep", label: "Conservar la rama" },
        { id: "force", label: "Borrarla igual", danger: true },
      ],
    })
    if (sure === "cancel" || !sure) return
    forceBranch = sure === "force"
  }
  const root = useProject.getState().root
  if (root && samePath(root, feature.root)) {
    const ok = await activateRoot(project, { label: "Principal" })
    if (!ok) return
  }
  await api("POST", "/instance/dispose", undefined, undefined, { directory: feature.root }).catch(() => undefined)
  try {
    const result = await featuresRemove({
      project: scope,
      path: feature.path,
      deleteBranch: choice === "branch" && (check.unmerged === 0 || forceBranch),
      force,
      forceBranch,
    })
    if (result.warning) notify.warning(`«${feature.label}» eliminada`, result.warning)
    else notify.success(`«${feature.label}» eliminada`, result.branchDeleted ? `También se borró la rama ${check.branch}` : undefined)
  } catch (e) {
    notify.error("No se pudo eliminar la feature", errorMessage(e))
  }
  await refreshFeatures()
}

function focusRepo(path: string): void {
  const apply = () => {
    const repo = repoForPath(path)
    if (repo) setActiveRepo(repo)
    return !!repo
  }
  if (apply()) return
  const off = useGit.subscribe((s) => {
    if (s.repos.length === 0) return
    off()
    apply()
  })
  setTimeout(off, 10000)
}

export async function handleMergeResult(result: MergeResult, success: string): Promise<void> {
  if (result.status === "up_to_date") {
    notify.info("Ya estaba al día", "No había nada nuevo para traer")
    return
  }
  if (result.status === "merged") {
    notify.success(success, result.head ? `commit ${result.head.slice(0, 7)}` : undefined)
    await refreshFeatures()
    return
  }
  const files = result.conflicts.slice(0, 5).join(", ") + (result.conflicts.length > 5 ? "…" : "")
  if (!result.checkout) {
    notify.error(
      "Hay conflictos",
      `${files}. La rama destino no está abierta en ninguna feature: traé la base a la feature, resolvé los conflictos ahí y volvé a integrar.`,
    )
    return
  }
  await refreshFeatures()
  const checkout = result.checkout
  const list = useFeatures.getState().list
  const target = list?.features.find((f) => samePath(f.path, checkout)) ?? (findGroup(checkout, list) ? list?.features.find((f) => f.kind === "main") : undefined)
  const root = useProject.getState().root
  if (target && root && !samePath(target.root, root)) {
    const ok = await activateRoot(target.root, { label: featureTitle(target) })
    if (!ok) return
  }
  focusRepo(checkout)
  useLayout.getState().showView("scm", false)
  notify.warning(
    `Merge con conflictos en ${plural(result.conflicts.length, "archivo", "archivos")}`,
    `${files}. Resolvelos, pasalos al stage y tocá «Continuar merge» en Control de código.`,
  )
}

export function hasUnsavedIn(feature: Pick<Feature, "root">): boolean {
  const root = useProject.getState().root
  return !!root && samePath(root, feature.root) && dirtyPaths().length > 0
}

export async function updateFromBase(feature: Feature): Promise<void> {
  if (!feature.base) {
    notify.warning("La feature no tiene rama base", "Elegila desde el menú de la feature")
    return
  }
  if (hasUnsavedIn(feature)) {
    notify.warning("Hay archivos sin guardar en esta feature", "Guardalos antes de traer la base: el merge puede cambiar esos archivos")
    return
  }
  try {
    const result = await featuresUpdateFromBase(scopeOf(feature), feature.path)
    await handleMergeResult(result, `«${feature.label}» actualizada con ${feature.base}`)
  } catch (e) {
    notify.error("No se pudo traer la base", errorMessage(e))
  }
}

export async function newSessionIn(feature: Feature): Promise<void> {
  const ok = await switchToFeature(feature)
  if (!ok) return
  useLayout.getState().toggleAgent(true)
  newSession()
}

export async function openPullRequest(feature: Feature): Promise<void> {
  const root = useProject.getState().root
  if (!root || !samePath(root, feature.root)) {
    const ok = await switchToFeature(feature)
    if (!ok) return
  }
  openEditor({ kind: "prCreate", repo: feature.path })
}

type PackageJson = { scripts?: Record<string, string> }

async function packageManager(root: string): Promise<string> {
  const exists = (name: string) => stat(joinPath(root, name)).then((s) => s.exists).catch(() => false)
  if (await exists("pnpm-lock.yaml")) return "pnpm"
  if (await exists("yarn.lock")) return "yarn"
  if (await exists("bun.lockb")) return "bun"
  return "npm"
}

const RUN_SCRIPTS = ["dev", "start", "serve", "preview", "tauri", "watch"]

export async function suggestSetupCommand(root: string): Promise<string | null> {
  const hasPackage = await stat(joinPath(root, "package.json")).then((s) => s.exists).catch(() => false)
  if (!hasPackage) return null
  const pm = await packageManager(root)
  return pm === "yarn" ? "yarn" : `${pm} install`
}

async function chooseRunCommand(root: string): Promise<string | null> {
  const items: Array<{ id: string; label: string; description?: string; icon: string }> = []
  try {
    const pkg = JSON.parse((await readFile(joinPath(root, "package.json"))).content) as PackageJson
    const pm = await packageManager(root)
    const scripts = Object.entries(pkg.scripts ?? {})
    scripts.sort(([a], [b]) => {
      const ia = RUN_SCRIPTS.indexOf(a)
      const ib = RUN_SCRIPTS.indexOf(b)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
    for (const [name, script] of scripts) {
      const command = pm === "npm" ? `npm run ${name}` : `${pm} ${name}`
      items.push({ id: command, label: command, description: script, icon: RUN_SCRIPTS.includes(name) ? "play" : "terminal" })
    }
  } catch {
    items.length = 0
  }
  items.push({ id: "__custom__", label: "Escribir otro comando…", icon: "edit" })
  const choice = await pickOne(items, { title: "¿Cómo se corre la app de este proyecto?", placeholder: "Elegí un script o escribí uno" })
  if (!choice) return null
  if (choice.id !== "__custom__") return choice.id
  const custom = await promptInput({
    title: "Comando para correr la app",
    placeholder: "npm run dev",
    validate: (v) => (v.trim() ? null : "Escribí un comando"),
  })
  return custom?.trim() || null
}

export async function configureRunCommand(): Promise<string | null> {
  const root = useProject.getState().root
  if (!root) return null
  const command = await chooseRunCommand(root)
  if (!command) return null
  try {
    await saveSettings({ run: command })
  } catch (e) {
    notify.error("No se pudo guardar el comando", errorMessage(e))
  }
  return command
}

export function isAppRunning(runTerminalId: string | null, terminals = useTerminals.getState().terminals): boolean {
  return !!runTerminalId && terminals.some((t) => t.id === runTerminalId && !t.exited)
}

export async function runApp(): Promise<void> {
  const root = useProject.getState().root
  if (!root) return
  const command = contextSettings()?.run ?? (await configureRunCommand())
  if (!command) return
  const current = useFeatures.getState().runTerminalId
  if (current && isAppRunning(current)) await killTerminal(current)
  const id = await runInTerminal(command, { newTerminal: true, cwd: root, title: "app" })
  useFeatures.setState({ runTerminalId: id })
}

export async function stopApp(): Promise<void> {
  const id = useFeatures.getState().runTerminalId
  if (!id) return
  await killTerminal(id)
  useFeatures.setState({ runTerminalId: null })
  notify.info("La app se detuvo", "Se cerró su terminal y se liberaron los puertos")
}

useTerminals.subscribe((s) => {
  const id = useFeatures.getState().runTerminalId
  if (id && !s.terminals.some((t) => t.id === id)) useFeatures.setState({ runTerminalId: null })
})
