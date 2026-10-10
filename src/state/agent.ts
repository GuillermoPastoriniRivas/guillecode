import { create } from "zustand"
import type { Message, Part, Session, SessionStatus } from "@opencode-ai/sdk"
import {
  api,
  client,
  clientForDirectory,
  currentDirectory,
  DEFAULT_MODEL,
  modelKey,
  rememberSessionDirectory,
  resetConnection,
  sessionDirectory,
  type ModelRef,
} from "../lib/opencode"
import { loadJson, projectKey, saveJson } from "../lib/persist"
import { call, isTauri } from "../lib/tauri"
import { normalizePath, relativePath, samePath, toFileUrl } from "../lib/paths"
import { notify } from "./toasts"
import { clearApprovalFailed } from "./approvals"
import { chooseAvailableModel, hasAccount, modelAvailable, modelVisible } from "../lib/providers"
import { isArchivedSession, sessionTreeIds } from "../lib/sessions"
import { AUTO_RETRY_MAX, autoRetryDelayMs, isRetryableProviderError, latestFailedAssistant, retryMessageID, retryPromptParts, shouldAutoRetry } from "../lib/autoretry"

export type ChatMessage = { info: Message; parts: Part[] }

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

export type QuestionOption = { label: string; description: string }
export type QuestionInfo = { question: string; header: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean }
export type QuestionRequest = { id: string; sessionID: string; questions: QuestionInfo[]; tool?: { messageID: string; callID: string } }

export type Todo = { id?: string; content: string; status: string; priority: string }

export type ProviderModel = {
  providerID: string
  providerName: string
  modelID: string
  name: string
  reasoning: boolean
  image: boolean
  variants: string[]
  contextLimit: number
}

export type ConnectedProvider = { id: string; name: string; oauth: boolean; source: string; env: string[] }

export type AgentInfo = { name: string; description?: string; mode: string; hidden?: boolean; color?: string }
export type CommandInfo = { name: string; description?: string; source?: string; template: string; hints: string[] }

export type ContextItem =
  | { kind: "file"; path: string }
  | { kind: "selection"; path: string; startLine: number; endLine: number; text: string }
  | { kind: "image"; mime: string; url: string; filename: string }

export type SessionView = { messages: ChatMessage[]; loading: boolean; hasMore: boolean; error: string | null }
export type ProviderRetry = { messageID: string; attempt: number; phase: "waiting" | "sending" | "exhausted" }

type AgentState = {
  connected: boolean
  modelsLoaded: boolean
  modelsError: string | null
  sessions: Session[]
  allSessions: Session[]
  sessionsLoaded: boolean
  statuses: Record<string, SessionStatus>
  providerRetries: Record<string, ProviderRetry>
  doneFlash: Record<string, number>
  views: Record<string, SessionView>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  todos: Record<string, Todo[]>
  activeSessionId: string | null
  openSessionIds: string[]
  context: ContextItem[]
  includeActiveFile: boolean
  model: ModelRef
  agentName: string
  models: ProviderModel[]
  providers: ConnectedProvider[]
  favoriteModels: string[]
  variants: Record<string, string>
  zenFreeOnly: boolean
  memoryEnabled: Record<string, boolean>
  agents: AgentInfo[]
  commands: CommandInfo[]
  composerFocus: number
  draft: { text: string; nonce: number } | null
}

export const HELPER_TITLE_PREFIX = "guillecode·"
export const DRAFT_TAB = "__draft__"
const PAGE_SIZE = 40
const DONE_FLASH_MS = 7000
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export const useAgent = create<AgentState>(() => ({
  connected: false,
  modelsLoaded: false,
  modelsError: null,
  sessions: [],
  allSessions: [],
  sessionsLoaded: false,
  statuses: {},
  providerRetries: {},
  doneFlash: {},
  views: {},
  permissions: [],
  questions: [],
  todos: {},
  activeSessionId: null,
  openSessionIds: [DRAFT_TAB],
  context: [],
  includeActiveFile: loadJson("agent.includeActiveFile", true),
  model: loadJson<ModelRef>("agent.model", DEFAULT_MODEL),
  agentName: loadJson("agent.name", "build"),
  models: [],
  providers: [],
  favoriteModels: loadJson("agent.favoriteModels", []),
  variants: loadJson("agent.variants", {}),
  zenFreeOnly: loadJson("agent.zenFreeOnly", true),
  memoryEnabled: loadJson("agent.memoryEnabled", {}),
  agents: [],
  commands: [],
  composerFocus: 0,
  draft: null,
}))

let boundProject: string | null = null
let knownDirectories: string[] = []

export function sessionInRoot(s: Pick<Session, "directory">, root: string | null): boolean {
  if (!root) return true
  return !!s.directory && samePath(s.directory, root)
}

export function bindAgentProject(root: string | null): void {
  boundProject = root
  const active = loadJson<string | null>(projectKey(root, "agent.activeSession"), null)
  let open = loadJson<string[] | null>(projectKey(root, "agent.openSessions"), null) ?? []
  if (active && !open.includes(active)) open = [...open, active]
  if (!active && !open.includes(DRAFT_TAB)) open = [...open, DRAFT_TAB]
  if (open.length === 0) open = [DRAFT_TAB]
  useAgent.setState((s) => ({
    activeSessionId: active,
    openSessionIds: open,
    context: [],
    sessions: sortSessions(s.allSessions.filter((x) => sessionInRoot(x, root))),
  }))
}

export function setKnownDirectories(dirs: string[]): void {
  const unique: string[] = []
  for (const d of dirs) if (d && !unique.some((u) => samePath(u, d))) unique.push(d)
  knownDirectories = unique
}

function directoriesToQuery(): string[] {
  const dirs = [...knownDirectories]
  if (boundProject && !dirs.some((d) => samePath(d, boundProject!))) dirs.unshift(boundProject)
  return dirs
}

type ForeignSessionHandler = (directory: string, sessionID: string) => void
let foreignSessionHandler: ForeignSessionHandler | null = null

export function onForeignSession(handler: ForeignSessionHandler | null): void {
  foreignSessionHandler = handler
}

export function foreignDirectory(sessionID: string): string | null {
  const dir = sessionDirectory(sessionID)
  if (!dir || !boundProject || samePath(dir, boundProject)) return null
  return dir
}

function shareRemotePrefs(s: AgentState): void {
  if (!isTauri) return
  void call("remote_set_prefs", { prefs: { model: s.model, favorites: s.favoriteModels, variants: s.variants, agent: s.agentName, zenFreeOnly: s.zenFreeOnly } }).catch(() => undefined)
}

shareRemotePrefs(useAgent.getState())

useAgent.subscribe((s, prev) => {
  if (s.model !== prev.model || s.favoriteModels !== prev.favoriteModels || s.variants !== prev.variants || s.agentName !== prev.agentName || s.zenFreeOnly !== prev.zenFreeOnly) shareRemotePrefs(s)
  if (s.model !== prev.model) saveJson("agent.model", s.model)
  if (s.favoriteModels !== prev.favoriteModels) saveJson("agent.favoriteModels", s.favoriteModels)
  if (s.variants !== prev.variants) saveJson("agent.variants", s.variants)
  if (s.zenFreeOnly !== prev.zenFreeOnly) saveJson("agent.zenFreeOnly", s.zenFreeOnly)
  if (s.memoryEnabled !== prev.memoryEnabled) saveJson("agent.memoryEnabled", s.memoryEnabled)
  if (s.agentName !== prev.agentName) saveJson("agent.name", s.agentName)
  if (s.includeActiveFile !== prev.includeActiveFile) saveJson("agent.includeActiveFile", s.includeActiveFile)
  if (s.activeSessionId !== prev.activeSessionId) saveJson(projectKey(boundProject, "agent.activeSession"), s.activeSessionId)
  if (s.openSessionIds !== prev.openSessionIds) saveJson(projectKey(boundProject, "agent.openSessions"), s.openSessionIds)
})

type Mutation = (s: AgentState) => Partial<AgentState>
let queue: Mutation[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function enqueue(m: Mutation) {
  queue.push(m)
  if (!flushTimer) flushTimer = setTimeout(flush, 16)
}

function flush() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  const pending = queue
  queue = []
  if (pending.length === 0) return
  useAgent.setState((s) => {
    let current = s
    for (const m of pending) current = { ...current, ...m(current) }
    return current
  })
}

export function isHelperSession(s: Session): boolean {
  return s.title?.startsWith(HELPER_TITLE_PREFIX) ?? false
}

function sortSessions(list: Session[]): Session[] {
  return [...list].filter((s) => !isHelperSession(s)).sort((a, b) => b.time.updated - a.time.updated)
}

function sessionUpdate(s: AgentState, info: Session): Partial<AgentState> {
  const previous = s.allSessions.find((x) => x.id === info.id)
  const allSessions = sortSessions([info, ...s.allSessions.filter((x) => x.id !== info.id)])
  const others = s.sessions.filter((x) => x.id !== info.id)
  const patch: Partial<AgentState> = {
    allSessions,
    sessions: sessionInRoot(info, boundProject) ? sortSessions([info, ...others]) : others,
  }
  if (!isArchivedSession(info) || (previous && isArchivedSession(previous))) return patch
  return { ...patch, ...withoutSessionTabs(s, sessionTreeIds(allSessions, [info.id])) }
}

function withoutSessionTabs(s: AgentState, ids: Set<string>): Partial<AgentState> {
  const open = s.openSessionIds.filter((id) => !ids.has(id))
  if (open.length === s.openSessionIds.length) return {}
  if (open.length === 0) open.push(DRAFT_TAB)
  const patch: Partial<AgentState> = { openSessionIds: open }
  if (s.activeSessionId && ids.has(s.activeSessionId)) {
    const index = Math.max(0, s.openSessionIds.indexOf(s.activeSessionId))
    const next = open[Math.min(index, open.length - 1)]
    patch.activeSessionId = next === DRAFT_TAB ? null : next
  }
  return patch
}

function withView(s: AgentState, sessionID: string, fn: (v: SessionView) => SessionView): Partial<AgentState> {
  const view = s.views[sessionID]
  if (!view) return {}
  return { views: { ...s.views, [sessionID]: fn(view) } }
}

function upsertMessage(messages: ChatMessage[], info: Message): ChatMessage[] {
  const index = messages.findIndex((m) => m.info.id === info.id)
  if (index === -1) {
    const next = [...messages, { info, parts: pendingParts.get(info.id) ?? [] }]
    pendingParts.delete(info.id)
    next.sort((a, b) => a.info.time.created - b.info.time.created)
    return next
  }
  const next = [...messages]
  next[index] = { ...next[index], info }
  return next
}

const pendingParts = new Map<string, Part[]>()
const fullHistory = new Map<string, ChatMessage[]>()

// Closing a tab must release the whole conversation, not only hide it: otherwise
// every session opened during a long run stays in memory with all its parts.
function pruneSessionCaches(keep: Set<string>): Partial<AgentState> {
  const pick = <T,>(map: Record<string, T>): Record<string, T> | null => {
    let changed = false
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(map)) {
      if (keep.has(id)) out[id] = value
      else changed = true
    }
    return changed ? out : null
  }
  const staleHistory = [...fullHistory.keys()].filter((id) => !keep.has(id))
  for (const id of staleHistory) fullHistory.delete(id)
  const views = pick(useAgent.getState().views)
  const todos = pick(useAgent.getState().todos)
  const doneFlash = pick(useAgent.getState().doneFlash)
  if (!views && !todos && !doneFlash && staleHistory.length === 0) return {}
  return {
    views: views ?? useAgent.getState().views,
    todos: todos ?? useAgent.getState().todos,
    doneFlash: doneFlash ?? useAgent.getState().doneFlash,
  }
}

function upsertPart(messages: ChatMessage[], part: Part): ChatMessage[] {
  const index = messages.findIndex((m) => m.info.id === part.messageID)
  if (index === -1) {
    const list = pendingParts.get(part.messageID) ?? []
    const i = list.findIndex((p) => p.id === part.id)
    if (i === -1) list.push(part)
    else list[i] = part
    pendingParts.set(part.messageID, list)
    return messages
  }
  const message = messages[index]
  const partIndex = message.parts.findIndex((p) => p.id === part.id)
  const parts = [...message.parts]
  if (partIndex === -1) parts.push(part)
  else parts[partIndex] = part
  const next = [...messages]
  next[index] = { ...message, parts }
  return next
}

function appendDelta(messages: ChatMessage[], messageID: string, partID: string, field: string, delta: string): ChatMessage[] {
  const index = messages.findIndex((m) => m.info.id === messageID)
  if (index === -1) return messages
  const message = messages[index]
  const partIndex = message.parts.findIndex((p) => p.id === partID)
  if (partIndex === -1) return messages
  const part = message.parts[partIndex] as unknown as Record<string, unknown>
  const current = typeof part[field] === "string" ? (part[field] as string) : ""
  const parts = [...message.parts]
  parts[partIndex] = { ...part, [field]: current + delta } as unknown as Part
  const next = [...messages]
  next[index] = { ...message, parts }
  return next
}

function mergeDirectorySessions(all: Session[], directory: string, list: Session[]): Session[] {
  const ids = new Set(list.map((x) => x.id))
  return [...all.filter((x) => !ids.has(x.id) && !sessionInRoot(x, directory)), ...list]
}

async function listSessionsIn(directory: string): Promise<Session[]> {
  const res = await client.session.list({ query: { directory } })
  const list = ((res.data ?? []) as Session[]).filter((x) => sessionInRoot(x, directory))
  for (const x of list) rememberSessionDirectory(x.id, x.directory)
  return list
}

export async function loadSessions(): Promise<boolean> {
  const root = boundProject ?? (await currentDirectory())
  try {
    const list = await listSessionsIn(root)
    if (boundProject && !samePath(root, boundProject)) return true
    const valid = new Set(list.map((x) => x.id))
    useAgent.setState((s) => {
      const newlyArchived = list.filter((x) => {
        const previous = s.allSessions.find((p) => p.id === x.id)
        return isArchivedSession(x) && previous && !isArchivedSession(previous)
      }).map((x) => x.id)
      const tabs = { ...s, ...withoutSessionTabs(s, sessionTreeIds(list, newlyArchived)) }
      const active = tabs.activeSessionId && valid.has(tabs.activeSessionId) ? tabs.activeSessionId : null
      let open = tabs.openSessionIds.filter((x) => x === DRAFT_TAB || valid.has(x))
      if (active && !open.includes(active)) open = [...open, active]
      if (!active && !open.includes(DRAFT_TAB)) open = [...open, DRAFT_TAB]
      if (open.length === 0) open = [DRAFT_TAB]
      return {
        sessions: sortSessions(list),
        allSessions: sortSessions(mergeDirectorySessions(s.allSessions, root, list)),
        sessionsLoaded: true,
        activeSessionId: active,
        openSessionIds: open,
      }
    })
    return true
  } catch {
    return false
  }
}

export async function loadOtherSessions(): Promise<void> {
  const others = directoriesToQuery().filter((d) => !boundProject || !samePath(d, boundProject))
  const results = await Promise.allSettled(others.map(async (d) => ({ d, list: await listSessionsIn(d) })))
  useAgent.setState((s) => {
    let all = s.allSessions
    for (const r of results) if (r.status === "fulfilled") all = mergeDirectorySessions(all, r.value.d, r.value.list)
    return { allSessions: sortSessions(all) }
  })
}

export async function ensureSessionView(sessionID: string, force = false): Promise<void> {
  const existing = useAgent.getState().views[sessionID]
  if (existing && !force && !existing.error) return
  useAgent.setState((s) => ({
    views: { ...s.views, [sessionID]: { messages: existing?.messages ?? [], loading: true, hasMore: false, error: null } },
  }))
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: PAGE_SIZE } })
    const messages = (res.data ?? []) as ChatMessage[]
    fullHistory.delete(sessionID)
    useAgent.setState((s) => ({
      views: { ...s.views, [sessionID]: { messages, loading: false, hasMore: messages.length >= PAGE_SIZE, error: null } },
    }))
    const failed = latestFailedAssistant(messages)
    if (failed?.info.role === "assistant") void maybeAutoRetry(sessionID, failed.info.error, messages)
    else {
      const last = messages.at(-1)?.info
      if (last?.role === "assistant" && last.time.completed && autoRetry.get(sessionID)?.parentIDs.has(last.parentID))
        cancelAutoRetry(sessionID)
    }
  } catch (e) {
    useAgent.setState((s) => ({
      views: {
        ...s.views,
        [sessionID]: { messages: [], loading: false, hasMore: false, error: e instanceof Error ? e.message : String(e) },
      },
    }))
  }
  void loadTodos(sessionID)
}

export async function loadOlderMessages(sessionID: string): Promise<void> {
  const view = useAgent.getState().views[sessionID]
  if (!view || !view.hasMore) return
  let all = fullHistory.get(sessionID)
  if (!all) {
    const res = await client.session.messages({ path: { id: sessionID } })
    all = (res.data ?? []) as ChatMessage[]
    fullHistory.set(sessionID, all)
  }
  const shown = Math.min(all.length, view.messages.length + PAGE_SIZE)
  const oldest = view.messages[0]?.info.id
  const cut = oldest ? all.findIndex((m) => m.info.id === oldest) : all.length
  const start = Math.max(0, (cut === -1 ? all.length : cut) - (shown - view.messages.length))
  const older = all.slice(start, cut === -1 ? all.length : cut)
  useAgent.setState((s) =>
    withView(s, sessionID, (v) => ({ ...v, messages: [...older, ...v.messages], hasMore: start > 0 })),
  )
}

async function loadTodos(sessionID: string) {
  try {
    const todos = await api<Todo[]>("GET", `/session/${sessionID}/todo`)
    useAgent.setState((s) => ({ todos: { ...s.todos, [sessionID]: todos ?? [] } }))
  } catch {
    return
  }
}

let metaGeneration = 0

async function acrossDirectories<T extends { id: string }>(path: string): Promise<T[]> {
  const results = await Promise.allSettled(directoriesToQuery().map((directory) => api<T[]>("GET", path, undefined, undefined, { directory })))
  const out: T[] = []
  let failed = 0
  for (const r of results) {
    if (r.status !== "fulfilled") {
      failed += 1
      continue
    }
    for (const item of r.value ?? []) if (!out.some((x) => x.id === item.id)) out.push(item)
  }
  if (results.length > 0 && failed === results.length) throw new Error(`no se pudo leer ${path}`)
  return out
}

async function statusesEverywhere(): Promise<Record<string, SessionStatus>> {
  const results = await Promise.allSettled(
    directoriesToQuery().map((directory) => api<Record<string, SessionStatus>>("GET", "/session/status", undefined, undefined, { directory })),
  )
  const merged: Record<string, SessionStatus> = {}
  let ok = false
  for (const r of results) {
    if (r.status !== "fulfilled") continue
    ok = true
    Object.assign(merged, r.value ?? {})
  }
  if (!ok) throw new Error("no se pudo leer el estado de las sesiones")
  return merged
}

export async function loadAgentMeta(): Promise<void> {
  const generation = ++metaGeneration
  const [providers, agents, commands, permissions, questions, statuses] = await Promise.allSettled([
    api<{
      providers: Array<{
        id: string
        name: string
        source?: string
        env?: string[]
        options?: { apiKey?: unknown }
        models: Record<
          string,
          {
            id: string
            name: string
            capabilities?: { reasoning?: boolean; input?: { image?: boolean } }
            variants?: Record<string, unknown>
            limit?: { context?: number }
            cost?: { input?: number; output?: number }
          }
        >
      }>
    }>(
      "GET",
      "/config/providers",
    ),
    api<AgentInfo[]>("GET", "/agent"),
    api<CommandInfo[]>("GET", "/command"),
    acrossDirectories<PermissionRequest>("/permission"),
    acrossDirectories<QuestionRequest>("/question"),
    statusesEverywhere(),
  ])
  if (generation !== metaGeneration) return
  const patch: Partial<AgentState> = {}
  if (providers.status === "fulfilled") {
    const models: ProviderModel[] = []
    const accounts = (providers.value.providers ?? []).filter(hasAccount)
    const zenFreeOnly = useAgent.getState().zenFreeOnly
    for (const p of accounts) {
      for (const m of Object.values(p.models ?? {})) {
        if (!modelVisible({ providerID: p.id, modelID: m.id, cost: m.cost }, zenFreeOnly)) continue
        models.push({
          providerID: p.id,
          providerName: p.name,
          modelID: m.id,
          name: m.name ?? m.id,
          reasoning: m.capabilities?.reasoning ?? false,
          image: m.capabilities?.input?.image ?? false,
          variants: Object.keys(m.variants ?? {}),
          contextLimit: m.limit?.context ?? 0,
        })
      }
    }
    patch.models = models
    patch.modelsLoaded = true
    patch.modelsError = null
    const state = useAgent.getState()
    const next = chooseAvailableModel(models, state.model, state.favoriteModels)
    if (modelKey(next) !== modelKey(state.model)) patch.model = next
    patch.providers = accounts.map((p) => ({
      id: p.id,
      name: p.name,
      oauth: p.options?.apiKey === OAUTH_DUMMY_KEY,
      source: p.source ?? "",
      env: p.env ?? [],
    }))
  } else {
    patch.modelsError = providers.reason instanceof Error ? providers.reason.message : "No se pudieron cargar las cuentas de IA"
  }
  if (agents.status === "fulfilled") patch.agents = agents.value.filter((a) => !a.hidden && a.mode !== "subagent")
  if (commands.status === "fulfilled") patch.commands = commands.value
  if (permissions.status === "fulfilled") patch.permissions = permissions.value
  if (questions.status === "fulfilled") patch.questions = questions.value
  useAgent.setState(patch)
  if (statuses.status === "fulfilled") syncStatuses(statuses.value)
}

const statusMirror: Record<string, SessionStatus["type"]> = {}

function applyStatus(sessionID: string, st: SessionStatus) {
  const prev = statusMirror[sessionID]
  statusMirror[sessionID] = st.type
  if (st.type === "busy" || st.type === "retry") cancelAutoRetryTimer(sessionID)
  const finished = (prev === "busy" || prev === "retry") && st.type === "idle"
  enqueue((s) => {
    const patch: Partial<AgentState> = { statuses: { ...s.statuses, [sessionID]: st } }
    if (finished) patch.doneFlash = { ...s.doneFlash, [sessionID]: Date.now() }
    return patch
  })
  if (finished) {
    setTimeout(() => {
      useAgent.setState((s) => {
        if (!(sessionID in s.doneFlash)) return {}
        const doneFlash = { ...s.doneFlash }
        delete doneFlash[sessionID]
        return { doneFlash }
      })
    }, DONE_FLASH_MS)
    if (useAgent.getState().views[sessionID]) void ensureSessionView(sessionID, true)
    onSessionFinished(sessionID)
  }
}

export function syncStatuses(map: Record<string, SessionStatus>) {
  for (const [id, st] of Object.entries(map)) {
    const prev = statusMirror[id]
    if (st.type === "idle" && (!prev || prev === "idle")) continue
    if (prev === st.type) {
      if (st.type !== "retry") continue
      const current = useAgent.getState().statuses[id]
      if (current?.type === "retry" && current.attempt === st.attempt && current.message === st.message && current.next === st.next) continue
    }
    applyStatus(id, st)
  }
  for (const [id, prev] of Object.entries(statusMirror)) {
    if (prev !== "idle" && !(id in map)) applyStatus(id, { type: "idle" })
  }
}

// When the engine gives up on a retryable provider error (the ChatGPT/Codex
// backend returns transient 503s) resend the turn on our own, but only when no
// tool ran in it: replaying tools could repeat side effects.
type AutoRetryEntry = { parentIDs: Set<string>; handledFailures: Set<string>; count: number; timer: ReturnType<typeof setTimeout> | null }
const autoRetry = new Map<string, AutoRetryEntry>()
const autoRetryEvaluating = new Map<string, object>()
const retryInFlight = new Set<string>()

function cancelAutoRetryTimer(sessionID: string): void {
  const entry = autoRetry.get(sessionID)
  if (entry?.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}

export function cancelAutoRetry(sessionID: string): void {
  cancelAutoRetryTimer(sessionID)
  autoRetry.delete(sessionID)
  autoRetryEvaluating.delete(sessionID)
  useAgent.setState((s) => {
    if (!s.providerRetries[sessionID]) return {}
    const providerRetries = { ...s.providerRetries }
    delete providerRetries[sessionID]
    return { providerRetries }
  })
}

async function messagesForRetry(sessionID: string): Promise<ChatMessage[] | null> {
  try {
    // SSE updates are batched and can be missing. Never decide which turn to
    // replay (or whether tools ran) from the potentially stale rendered page.
    return await api<ChatMessage[]>("GET", `/session/${sessionID}/message`, undefined, { limit: String(PAGE_SIZE) })
  } catch {
    return null
  }
}

function showProviderRetry(sessionID: string, retry: ProviderRetry): void {
  useAgent.setState((s) => ({ providerRetries: { ...s.providerRetries, [sessionID]: retry } }))
}

async function maybeAutoRetry(sessionID: string, error: unknown, snapshot?: ChatMessage[]): Promise<boolean> {
  if (!isRetryableProviderError(error)) return false
  if (autoRetry.get(sessionID)?.timer || autoRetryEvaluating.has(sessionID)) return true
  const evaluation = {}
  autoRetryEvaluating.set(sessionID, evaluation)
  try {
    const messages = snapshot ?? await messagesForRetry(sessionID)
    if (!messages || autoRetryEvaluating.get(sessionID) !== evaluation) return false
    const failed = latestFailedAssistant(messages)
    if (failed?.info.role !== "assistant" || !isRetryableProviderError(failed.info.error)) return false
    if (!shouldAutoRetry(messages, failed.info.parentID)) return false
    const parentID = failed.info.parentID
    const previous = autoRetry.get(sessionID)
    const entry: AutoRetryEntry = previous?.parentIDs.has(parentID) ? previous : {
      parentIDs: new Set([parentID]), handledFailures: new Set(), count: 0, timer: null,
    }
    autoRetry.set(sessionID, entry)
    if (entry.handledFailures.has(failed.info.id)) return true
    if (entry.count >= AUTO_RETRY_MAX) {
      showProviderRetry(sessionID, { messageID: failed.info.id, attempt: entry.count, phase: "exhausted" })
      return false
    }
    showProviderRetry(sessionID, { messageID: failed.info.id, attempt: entry.count + 1, phase: "waiting" })
    entry.timer = setTimeout(() => {
      if (autoRetry.get(sessionID) !== entry) return
      entry.timer = null
      void retryMessage(sessionID, failed, entry).catch((e) => {
        if (autoRetry.get(sessionID) !== entry) return
        cancelAutoRetry(sessionID)
        notify.error("No se pudo enviar el reintento", e instanceof Error ? e.message : String(e))
      })
    }, autoRetryDelayMs(entry.count))
    return true
  } finally {
    if (autoRetryEvaluating.get(sessionID) === evaluation) autoRetryEvaluating.delete(sessionID)
  }
}

const finishedListeners = new Set<(sessionID: string) => void>()
export function onSessionFinished(sessionID: string) {
  for (const l of finishedListeners) l(sessionID)
}
export function subscribeSessionFinished(fn: (sessionID: string) => void): () => void {
  finishedListeners.add(fn)
  return () => finishedListeners.delete(fn)
}

const fileEditListeners = new Set<(path: string) => void>()
export function subscribeAgentFileEdits(fn: (path: string) => void): () => void {
  fileEditListeners.add(fn)
  return () => fileEditListeners.delete(fn)
}

const branchListeners = new Set<() => void>()
export function subscribeBranchChanges(fn: () => void): () => void {
  branchListeners.add(fn)
  return () => branchListeners.delete(fn)
}

type ServerEvent = { type: string; properties: Record<string, unknown> }

function inActiveDirectory(directory: string | undefined): boolean {
  if (!directory || !boundProject || directory === "global") return true
  return samePath(directory, boundProject)
}

function belongsToThisWindow(directory: string | undefined): boolean {
  if (!directory || directory === "global" || !boundProject) return true
  if (samePath(directory, boundProject)) return true
  return knownDirectories.some((d) => samePath(d, directory))
}

function handleEvent(e: ServerEvent, directory?: string) {
  if (!belongsToThisWindow(directory)) return
  const p = e.properties ?? {}
  switch (e.type) {
    case "message.updated": {
      const info = p.info as Message
      if (info.role === "assistant") {
        if (info.time.completed && info.error) void maybeAutoRetry(info.sessionID, info.error)
        else if (info.time.completed) {
          const entry = autoRetry.get(info.sessionID)
          if (entry?.parentIDs.has(info.parentID)) cancelAutoRetry(info.sessionID)
        }
      }
      enqueue((s) => withView(s, info.sessionID, (v) => ({ ...v, messages: upsertMessage(v.messages, info) })))
      fullHistory.delete(info.sessionID)
      break
    }
    case "message.removed": {
      const sessionID = p.sessionID as string
      const messageID = p.messageID as string
      enqueue((s) => withView(s, sessionID, (v) => ({ ...v, messages: v.messages.filter((m) => m.info.id !== messageID) })))
      break
    }
    case "message.part.updated": {
      const part = p.part as Part
      enqueue((s) => withView(s, part.sessionID, (v) => ({ ...v, messages: upsertPart(v.messages, part) })))
      break
    }
    case "message.part.delta": {
      const { sessionID, messageID, partID, field, delta } = p as Record<string, string>
      enqueue((s) => withView(s, sessionID, (v) => ({ ...v, messages: appendDelta(v.messages, messageID, partID, field, delta) })))
      break
    }
    case "message.part.removed": {
      const { sessionID, messageID, partID } = p as Record<string, string>
      enqueue((s) =>
        withView(s, sessionID, (v) => ({
          ...v,
          messages: v.messages.map((m) =>
            m.info.id === messageID ? { ...m, parts: m.parts.filter((x) => x.id !== partID) } : m,
          ),
        })),
      )
      break
    }
    case "session.created":
    case "session.updated": {
      const info = p.info as Session
      rememberSessionDirectory(info.id, info.directory ?? directory)
      enqueue((s) => sessionUpdate(s, info))
      break
    }
    case "session.deleted": {
      const info = p.info as Session
      delete statusMirror[info.id]
      cancelAutoRetry(info.id)
      enqueue((s) => {
        const resetActive = s.activeSessionId === info.id
        let open = s.openSessionIds.filter((x) => x !== info.id)
        if (resetActive && !open.includes(DRAFT_TAB)) open = [...open, DRAFT_TAB]
        if (open.length === 0) open = [DRAFT_TAB]
        const statuses = { ...s.statuses }
        delete statuses[info.id]
        return {
          sessions: s.sessions.filter((x) => x.id !== info.id),
          allSessions: s.allSessions.filter((x) => x.id !== info.id),
          openSessionIds: open,
          activeSessionId: resetActive ? null : s.activeSessionId,
          statuses,
          ...pruneSessionCaches(new Set([...open, DRAFT_TAB])),
        }
      })
      break
    }
    case "session.status":
      applyStatus(p.sessionID as string, p.status as SessionStatus)
      break
    case "session.idle":
      if (statusMirror[p.sessionID as string] && statusMirror[p.sessionID as string] !== "idle")
        applyStatus(p.sessionID as string, { type: "idle" })
      break
    case "session.error": {
      const err = p.error as { name?: string; data?: { message?: string } } | undefined
      const sessionID = p.sessionID as string | undefined
      const retryable = isRetryableProviderError(err)
      if (err && err.name !== "MessageAbortedError" && !retryable) {
        notify.error("El agente tuvo un error", err.data?.message ?? err.name)
      }
      if (sessionID) void maybeAutoRetry(sessionID, err)
      break
    }
    case "permission.asked": {
      const req = p as unknown as PermissionRequest
      enqueue((s) => ({ permissions: [...s.permissions.filter((x) => x.id !== req.id), req] }))
      break
    }
    case "permission.replied": {
      const requestID = (p.requestID ?? p.permissionID) as string
      clearApprovalFailed(requestID)
      enqueue((s) => ({ permissions: s.permissions.filter((x) => x.id !== requestID) }))
      break
    }
    case "question.asked": {
      const req = p as unknown as QuestionRequest
      enqueue((s) => ({ questions: [...s.questions.filter((x) => x.id !== req.id), req] }))
      break
    }
    case "question.replied":
    case "question.rejected": {
      const requestID = p.requestID as string
      enqueue((s) => ({ questions: s.questions.filter((x) => x.id !== requestID) }))
      break
    }
    case "todo.updated": {
      const sessionID = p.sessionID as string
      const todos = p.todos as Todo[]
      enqueue((s) => ({ todos: { ...s.todos, [sessionID]: todos } }))
      break
    }
    case "file.edited": {
      if (!inActiveDirectory(directory)) break
      const file = normalizePath(p.file as string)
      for (const l of fileEditListeners) l(file)
      break
    }
    case "vcs.branch.updated":
      if (!inActiveDirectory(directory)) break
      for (const l of branchListeners) l()
      break
  }
}

async function refreshAfterConnect(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await loadSessions()) break
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
  }
  void loadOtherSessions()
  await loadAgentMeta().catch(() => undefined)
  const { activeSessionId, openSessionIds } = useAgent.getState()
  const ids = new Set([...openSessionIds, activeSessionId].filter((id): id is string => !!id && id !== DRAFT_TAB))
  for (const id of ids) void ensureSessionView(id, true)
}

type GlobalEvent = { directory?: string; payload?: ServerEvent } & Partial<ServerEvent>

export function startEventStream(): () => void {
  let active = true
  let streamController: AbortController | null = null
  let wakeRetry: (() => void) | null = null
  let polling = false
  const loop = async () => {
    while (active) {
      const controller = new AbortController()
      streamController = controller
      // OpenCode sends a heartbeat every 10 s. A silent, half-open stream
      // must not keep this window attached to a dead engine forever.
      let watchdog = setTimeout(() => controller.abort(), 35000)
      try {
        const sdk = await clientForDirectory(await currentDirectory())
        if (!active) break
        const events = await sdk.global.event({
          signal: controller.signal,
          sseMaxRetryAttempts: 1,
          onSseError: () => {
            if (active) useAgent.setState({ connected: false })
          },
        })
        for await (const event of events.stream) {
          if (!active) break
          clearTimeout(watchdog)
          watchdog = setTimeout(() => controller.abort(), 35000)
          const raw = event as unknown as GlobalEvent
          const e = (raw.payload ?? raw) as ServerEvent
          if (!e?.type) continue
          if (e.type === "server.connected" || !useAgent.getState().connected) {
            useAgent.setState({ connected: true })
            void refreshAfterConnect()
          }
          handleEvent(e, raw.directory)
        }
      } catch {
        if (!active) break
      } finally {
        clearTimeout(watchdog)
        controller.abort()
        if (streamController === controller) streamController = null
      }
      if (!active) break
      useAgent.setState({ connected: false })
      // The sidecar can restart on a new port with a new password. Retrying
      // inside the SDK reuses the old URL; resolve server_config again instead.
      resetConnection()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 1500)
        function done() {
          clearTimeout(timer)
          wakeRetry = null
          resolve()
        }
        wakeRetry = done
      })
    }
  }
  void loop()
  const poll = setInterval(() => {
    if (document.hidden || polling) return
    polling = true
    void statusesEverywhere()
      .then((statuses) => {
        if (!active) return
        syncStatuses(statuses)
        const id = useAgent.getState().activeSessionId
        if (!useAgent.getState().connected && id) void ensureSessionView(id, true)
      })
      .catch(() => undefined)
      .finally(() => { polling = false })
  }, 5000)
  return () => {
    active = false
    streamController?.abort()
    wakeRetry?.()
    clearInterval(poll)
  }
}

function parentOf(all: Session[], id: string): string | undefined {
  return all.find((x) => x.id === id)?.parentID
}

export function sessionWaiting(s: Pick<AgentState, "allSessions" | "permissions" | "questions">, id: string): boolean {
  return [...s.permissions, ...s.questions].some((r) => {
    let current: string | undefined = r.sessionID
    for (let i = 0; current && i < 12; i++) {
      if (current === id) return true
      current = parentOf(s.allSessions, current)
    }
    return false
  })
}

export function sessionStatus(id: string | null): "idle" | "busy" | "retry" {
  if (!id) return "idle"
  return useAgent.getState().statuses[id]?.type ?? "idle"
}

export function selectSession(id: string | null) {
  const foreign = id ? foreignDirectory(id) : null
  if (id && foreign && foreignSessionHandler) {
    foreignSessionHandler(foreign, id)
    return
  }
  useAgent.setState((s) => {
    if (!id) {
      return {
        activeSessionId: null,
        openSessionIds: s.openSessionIds.includes(DRAFT_TAB) ? s.openSessionIds : [...s.openSessionIds, DRAFT_TAB],
      }
    }
    let open: string[]
    if (s.activeSessionId === null && s.openSessionIds.includes(DRAFT_TAB)) {
      open = Array.from(new Set(s.openSessionIds.map((x) => (x === DRAFT_TAB ? id : x))))
    } else {
      open = s.openSessionIds.includes(id) ? s.openSessionIds : [...s.openSessionIds, id]
    }
    return { activeSessionId: id, openSessionIds: open }
  })
  if (id) void ensureSessionView(id)
}

export function memoryFor(sessionId: string | null): boolean {
  return useAgent.getState().memoryEnabled[sessionId ?? DRAFT_TAB] !== false
}

export function setMemory(sessionId: string, enabled: boolean): void {
  useAgent.setState((s) => ({ memoryEnabled: { ...s.memoryEnabled, [sessionId]: enabled } }))
  if (isTauri && sessionId && sessionId !== DRAFT_TAB) void call("memory_set_session", { session: sessionId, enabled }).catch(() => undefined)
}

export function newSession() {
  useAgent.setState((s) => ({
    activeSessionId: null,
    openSessionIds: s.openSessionIds.includes(DRAFT_TAB) ? s.openSessionIds : [...s.openSessionIds, DRAFT_TAB],
    composerFocus: s.composerFocus + 1,
  }))
}

export function closeSessionTab(id: string) {
  const s = useAgent.getState()
  const wasActive = id === DRAFT_TAB ? s.activeSessionId === null : s.activeSessionId === id
  let open = s.openSessionIds.filter((x) => x !== id)
  if (open.length === 0) open = [DRAFT_TAB]
  const index = Math.max(0, s.openSessionIds.indexOf(id))
  const next = wasActive ? (open[Math.min(index, open.length - 1)] ?? DRAFT_TAB) : null
  const activeSessionId = wasActive ? (next === DRAFT_TAB ? null : next) : s.activeSessionId
  useAgent.setState({ openSessionIds: open, activeSessionId, ...pruneSessionCaches(new Set([...open, DRAFT_TAB])) })
  if (wasActive && activeSessionId) void ensureSessionView(activeSessionId)
}

export function closeOtherSessionTabs(id: string) {
  const next = id === DRAFT_TAB || useAgent.getState().openSessionIds.includes(id) ? [id] : [DRAFT_TAB]
  const activeSessionId = next[0] === DRAFT_TAB ? null : next[0]
  useAgent.setState({ openSessionIds: next, activeSessionId, ...pruneSessionCaches(new Set([...next, DRAFT_TAB])) })
  if (activeSessionId) void ensureSessionView(activeSessionId)
}

export function cycleSessionTab(delta: 1 | -1) {
  const s = useAgent.getState()
  if (s.openSessionIds.length < 2) return
  const activeTab = s.activeSessionId ?? DRAFT_TAB
  const index = s.openSessionIds.indexOf(activeTab)
  const next = s.openSessionIds[(index + delta + s.openSessionIds.length) % s.openSessionIds.length]
  if (next === DRAFT_TAB) newSession()
  else selectSession(next)
}

export function focusComposer(draft?: string) {
  useAgent.setState((s) => ({
    composerFocus: s.composerFocus + 1,
    draft: draft !== undefined ? { text: draft, nonce: Date.now() } : s.draft,
  }))
}

export function addContext(item: ContextItem) {
  useAgent.setState((s) => {
    const exists = s.context.some((c) => {
      if (c.kind !== item.kind) return false
      if (c.kind === "file" && item.kind === "file") return c.path === item.path
      if (c.kind === "selection" && item.kind === "selection")
        return c.path === item.path && c.startLine === item.startLine && c.endLine === item.endLine
      if (c.kind === "image" && item.kind === "image") return c.url === item.url
      return false
    })
    return { context: exists ? s.context : [...s.context, item] }
  })
}

export function removeContext(index: number) {
  useAgent.setState((s) => ({ context: s.context.filter((_, i) => i !== index) }))
}

export function clearContext() {
  useAgent.setState({ context: [] })
}

type PromptPart =
  | { type: "text"; text: string }
  | {
      type: "file"
      mime: string
      url: string
      filename: string
      source?: { type: "file"; path: string; text: { value: string; start: number; end: number } }
    }

export function contextToParts(root: string | null, items: ContextItem[], activeFile: string | null): PromptPart[] {
  const parts: PromptPart[] = []
  const seen = new Set<string>()
  const addFile = (path: string) => {
    const k = path.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    const rel = root ? relativePath(root, path) : path
    parts.push({ type: "file", mime: "text/plain", url: toFileUrl(path), filename: rel })
  }
  for (const item of items) {
    if (item.kind === "file") addFile(item.path)
    else if (item.kind === "image") parts.push({ type: "file", mime: item.mime, url: item.url, filename: item.filename })
    else {
      const rel = root ? relativePath(root, item.path) : item.path
      const lang = rel.split(".").pop() ?? ""
      parts.push({
        type: "text",
        text: `Selección de \`${rel}\` (líneas ${item.startLine}-${item.endLine}):\n\n\`\`\`${lang}\n${item.text}\n\`\`\``,
      })
    }
  }
  if (activeFile && !items.some((i) => i.kind === "selection" && i.path === activeFile)) addFile(activeFile)
  return parts
}

export async function sendPrompt(
  text: string,
  root: string | null,
  activeFile: string | null,
  sessionId: string | null,
): Promise<string | null> {
  const s = useAgent.getState()
  let id = sessionId
  if (!s.modelsLoaded || s.modelsError) throw new Error("No se pudieron verificar las cuentas de IA. Recargá los modelos desde Cuentas de IA.")
  if (!modelAvailable(s.models, s.model)) throw new Error("Conectá ChatGPT u OpenCode desde Cuentas de IA y elegí un modelo disponible.")
  if (!id) {
    const res = await client.session.create({ body: {} })
    const created = res.data as Session | undefined
    if (!created) throw new Error("no se pudo crear la sesión")
    id = created.id
    rememberSessionDirectory(created.id, created.directory)
    if (s.memoryEnabled[DRAFT_TAB] === false) {
      await call("memory_set_session", { session: created.id, enabled: false }).catch(() => undefined)
      useAgent.setState((st) => ({ memoryEnabled: { ...st.memoryEnabled, [created.id]: false } }))
    }
    useAgent.setState((st) => {
      const open = st.openSessionIds.map((x) => (x === DRAFT_TAB ? created.id : x))
      if (!open.includes(created.id)) open.push(created.id)
      return {
        sessions: sortSessions([created, ...st.sessions.filter((x) => x.id !== created.id)]),
        allSessions: sortSessions([created, ...st.allSessions.filter((x) => x.id !== created.id)]),
        activeSessionId: created.id,
        openSessionIds: open,
        views: { ...st.views, [created.id]: { messages: [], loading: false, hasMore: false, error: null } },
      }
    })
  }
  if (id) cancelAutoRetry(id)
  const contextParts = contextToParts(root, s.context, s.includeActiveFile ? activeFile : null)
  const trimmed = text.trim()
  const command = findCommand(trimmed, s.commands)
  const variant = selectedVariant(s)
  if (command) {
    await api("POST", `/session/${id}/command`, {
      command: command.name,
      arguments: command.args,
      agent: s.agentName,
      model: modelKey(s.model),
      ...(variant ? { variant } : {}),
      parts: contextParts.filter((p) => p.type === "file"),
    })
  } else {
    const parts: PromptPart[] = []
    if (trimmed) parts.push({ type: "text", text: trimmed })
    parts.push(...contextParts)
    await api("POST", `/session/${id}/prompt_async`, {
      model: s.model,
      agent: s.agentName,
      ...(variant ? { variant } : {}),
      parts,
    })
  }
  useAgent.setState({ context: [] })
  return id
}

export async function abortSession(id: string | null) {
  if (!id) return
  cancelAutoRetry(id)
  await client.session.abort({ path: { id } }).catch(() => undefined)
}

export async function retryMessage(sessionID: string, failed: ChatMessage, automatic?: AutoRetryEntry): Promise<void> {
  if (failed.info.role !== "assistant" || !failed.info.error) throw new Error("Esta respuesta no necesita un reintento.")
  if (retryInFlight.has(sessionID)) throw new Error("Ya se está enviando un reintento para esta conversación.")
  if (!automatic) cancelAutoRetry(sessionID)
  retryInFlight.add(sessionID)
  try {
    const [messages, statuses] = await Promise.all([
      messagesForRetry(sessionID), api<Record<string, SessionStatus>>("GET", "/session/status", undefined, undefined, directoryOf(sessionID)),
    ])
    if (automatic && autoRetry.get(sessionID) !== automatic) return
    if (!messages) throw new Error("No se pudo verificar el historial de la conversación. Probá de nuevo.")
    if (latestFailedAssistant(messages)?.info.id !== failed.info.id) {
      if (automatic) cancelAutoRetry(sessionID)
      else throw new Error("La conversación ya avanzó. Reintentá solo la última respuesta interrumpida.")
      return
    }
    if (statuses[sessionID]?.type === "busy" || statuses[sessionID]?.type === "retry") {
      if (automatic) return
      throw new Error("El agente todavía está trabajando o reintentando. Esperá a que termine.")
    }
    if (automatic && !shouldAutoRetry(messages, failed.info.parentID)) {
      cancelAutoRetry(sessionID)
      return
    }
    const s = useAgent.getState()
    if (!s.modelsLoaded || s.modelsError || !modelAvailable(s.models, s.model))
      throw new Error("Elegí un modelo disponible desde Cuentas de IA antes de reintentar.")
    const messageID = retryMessageID()
    const variant = selectedVariant(s)
    if (automatic) {
      automatic.parentIDs.add(messageID)
      automatic.handledFailures.add(failed.info.id)
      automatic.count += 1
      showProviderRetry(sessionID, { messageID: failed.info.id, attempt: automatic.count, phase: "sending" })
    }
    await api("POST", `/session/${sessionID}/prompt_async`, {
      messageID, model: s.model, agent: s.agentName,
      ...(variant ? { variant } : {}),
      parts: retryPromptParts(messages, failed.info.parentID),
    })
    // A 204 confirms admission, not recovery of OpenAI. Reflect the new history
    // even if message.updated/session.status never arrive on the event stream.
    await ensureSessionView(sessionID, true)
  } finally {
    retryInFlight.delete(sessionID)
  }
}

export async function replyPermission(req: PermissionRequest, reply: "once" | "always" | "reject", message?: string) {
  useAgent.setState((s) => ({ permissions: s.permissions.filter((p) => p.id !== req.id) }))
  try {
    await api("POST", `/permission/${req.id}/reply`, message ? { reply, message } : { reply }, undefined, directoryOf(req.sessionID))
  } catch (e) {
    notify.error("No se pudo responder el permiso", e instanceof Error ? e.message : String(e))
    useAgent.setState((s) => ({ permissions: [...s.permissions, req] }))
  }
}

export async function replyQuestion(req: QuestionRequest, answers: string[][]) {
  useAgent.setState((s) => ({ questions: s.questions.filter((q) => q.id !== req.id) }))
  try {
    await api("POST", `/question/${req.id}/reply`, { answers }, undefined, directoryOf(req.sessionID))
  } catch (e) {
    notify.error("No se pudo responder", e instanceof Error ? e.message : String(e))
    useAgent.setState((s) => ({ questions: [...s.questions, req] }))
  }
}

export async function rejectQuestion(req: QuestionRequest) {
  useAgent.setState((s) => ({ questions: s.questions.filter((q) => q.id !== req.id) }))
  await api("POST", `/question/${req.id}/reject`, undefined, undefined, directoryOf(req.sessionID)).catch(() => undefined)
}

function directoryOf(sessionID: string): { directory?: string } {
  const directory = sessionDirectory(sessionID)
  return directory ? { directory } : {}
}

export async function renameSession(id: string, title: string) {
  await client.session.update({ path: { id }, body: { title } })
}

export async function setSessionArchived(id: string, archived: boolean): Promise<boolean> {
  try {
    const info = await api<Session>("PATCH", `/session/${id}`, { time: { archived: archived ? Date.now() : 0 } })
    if (!info?.id || isArchivedSession(info) !== archived) throw new Error("El motor no guardó el estado de la conversación.")
    rememberSessionDirectory(info.id, info.directory)
    flush()
    useAgent.setState((s) => sessionUpdate(s, info))
    notify.info(archived ? "Conversación archivada" : "Conversación restaurada", archived ? "Podés recuperarla desde Archivadas en el historial." : undefined)
    return true
  } catch (e) {
    notify.error(archived ? "No se pudo archivar" : "No se pudo restaurar", e instanceof Error ? e.message : String(e))
    return false
  }
}

export async function deleteSession(id: string) {
  await client.session.delete({ path: { id } })
  useAgent.setState((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }))
  if (useAgent.getState().openSessionIds.includes(id)) closeSessionTab(id)
}

export async function revertToMessage(sessionID: string, messageID: string) {
  await api("POST", `/session/${sessionID}/revert`, { messageID })
  await ensureSessionView(sessionID, true)
}

export async function unrevertSession(sessionID: string) {
  await api("POST", `/session/${sessionID}/unrevert`)
  await ensureSessionView(sessionID, true)
}

export async function compactSession(sessionID: string) {
  const { model } = useAgent.getState()
  await api("POST", `/session/${sessionID}/summarize`, { providerID: model.providerID, modelID: model.modelID })
}

export async function forkSession(sessionID: string, messageID?: string) {
  const forked = await api<Session>("POST", `/session/${sessionID}/fork`, messageID ? { messageID } : {})
  if (forked?.id) selectSession(forked.id)
}

export function toggleFavoriteModel(key: string): void {
  const favorites = useAgent.getState().favoriteModels
  const favoriteModels = favorites.includes(key) ? favorites.filter((k) => k !== key) : [...favorites, key]
  useAgent.setState({ favoriteModels })
  notify.info(favoriteModels.includes(key) ? "Agregado a favoritos" : "Quitado de favoritos")
}

export function setModel(model: ModelRef) {
  useAgent.setState({ model })
}

export function setZenFreeOnly(zenFreeOnly: boolean): void {
  useAgent.setState({ zenFreeOnly })
  void loadAgentMeta()
}

export function setAgentName(agentName: string) {
  useAgent.setState({ agentName })
}

export function findCommand(text: string, commands: CommandInfo[]): { name: string; args: string } | null {
  const slash = text.trim().match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/)
  if (!slash) return null
  const command = commands.find((c) => c.name === slash[1])
  return command ? { name: command.name, args: slash[2] ?? "" } : null
}

const VARIANT_LABELS: Record<string, string> = {
  none: "sin razonar",
  minimal: "mínimo",
  low: "bajo",
  medium: "medio",
  high: "alto",
  xhigh: "muy alto",
  max: "máximo",
}

export function variantLabel(variant: string | undefined): string {
  if (!variant) return "auto"
  return VARIANT_LABELS[variant] ?? variant
}

export function currentModelInfo(s: Pick<AgentState, "model" | "models">): ProviderModel | undefined {
  const key = modelKey(s.model)
  return s.models.find((m) => modelKey(m) === key)
}

export function selectedVariant(s: Pick<AgentState, "model" | "models" | "variants">): string | undefined {
  const variant = s.variants[modelKey(s.model)]
  if (!variant) return undefined
  const info = currentModelInfo(s)
  if (!info) return variant
  return info.variants.includes(variant) ? variant : undefined
}

export function setVariant(model: ModelRef, variant: string | null): void {
  const key = modelKey(model)
  const variants = { ...useAgent.getState().variants }
  if (variant) variants[key] = variant
  else delete variants[key]
  useAgent.setState({ variants })
}

export type ContextUsage = { used: number; limit: number; ratio: number }

export function contextUsage(messages: ChatMessage[], models: ProviderModel[]): ContextUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role !== "assistant") continue
    const t = info.tokens
    const cache = (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    const used = (info as { summary?: boolean }).summary ? t.output : t.input + t.output + (t.reasoning ?? 0) + cache
    if (used === 0) continue
    const limit = models.find((m) => m.providerID === info.providerID && m.modelID === info.modelID)?.contextLimit ?? 0
    if (!limit) return null
    return { used, limit, ratio: used / limit }
  }
  return null
}

export function runningAssistantId(messages: ChatMessage[], busy: boolean): string | null {
  if (!busy) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role === "assistant" && !info.time.completed) return info.id
  }
  return null
}

export function queuedUserIds(messages: ChatMessage[], busy: boolean): Set<string> {
  const queued = new Set<string>()
  const runningId = runningAssistantId(messages, busy)
  if (!runningId) return queued
  const answered = new Set<string>()
  let runningParent: string | null = null
  for (const m of messages) {
    if (m.info.role !== "assistant") continue
    answered.add(m.info.parentID)
    if (m.info.id === runningId) runningParent = m.info.parentID
  }
  const parentIndex = messages.findIndex((m) => m.info.id === runningParent)
  messages.forEach((m, i) => {
    if (i > parentIndex && m.info.role === "user" && !answered.has(m.info.id)) queued.add(m.info.id)
  })
  return queued
}
