import { create } from "zustand"
import { basename, normalizePath, samePath } from "../lib/paths"
import { loadJson, projectKey, saveJson } from "../lib/persist"
import { useLayout } from "./layout"

export type EditorInput =
  | { kind: "file"; path: string }
  | { kind: "diff"; repo: string; path: string; staged: boolean }
  | { kind: "commit"; repo: string; hash: string }
  | { kind: "commitFile"; repo: string; hash: string; parent: string; path: string; orig: string | null; label?: string }
  | { kind: "review"; sessionId: string }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "prCreate"; repo: string }
  | { kind: "graph"; repo: string }
  | { kind: "chat"; sessionId: string }
  | { kind: "aiReview"; repo: string; scope: "changes" | "pr"; number?: number; title?: string }
  | { kind: "routine"; id: string }
  | { kind: "remote" }
  | { kind: "desktop" }
  | { kind: "accounts" }
  | { kind: "featureCreate"; repo?: string }
  | { kind: "featureIntegrate"; path: string }
  | { kind: "welcome" }

export type Tab = { id: string; input: EditorInput; preview: boolean }
export type Group = { id: string; tabs: Tab[]; activeId: string | null }

export type RevealRequest = {
  tabId: string
  line: number
  column?: number
  endLine?: number
  endColumn?: number
  nonce: number
}

type EditorsState = {
  groups: Group[]
  activeGroupId: string
  reveal: RevealRequest | null
  focusNonce: number
}

export function tabId(input: EditorInput): string {
  switch (input.kind) {
    case "file":
      return `file:${normalizePath(input.path).toLowerCase()}`
    case "diff":
      return `diff:${input.staged ? "s" : "w"}:${normalizePath(input.repo).toLowerCase()}:${input.path}`
    case "commit":
      return `commit:${input.hash}`
    case "commitFile":
      return `commitFile:${input.parent}:${input.hash}:${input.path}`
    case "review":
      return `review:${input.sessionId}`
    case "pr":
      return `pr:${input.number}`
    case "prCreate":
      return "prCreate"
    case "graph":
      return `graph:${normalizePath(input.repo).toLowerCase()}`
    case "chat":
      return `chat:${input.sessionId}`
    case "routine":
      return `routine:${input.id}`
    case "remote":
      return "remote"
    case "desktop":
      return "desktop"
    case "accounts":
      return "accounts"
    case "aiReview":
      return `aiReview:${input.scope}:${normalizePath(input.repo).toLowerCase()}:${input.number ?? ""}`
    case "featureCreate":
      return input.repo ? `featureCreate:${normalizePath(input.repo).toLowerCase()}` : "featureCreate"
    case "featureIntegrate":
      return `featureIntegrate:${normalizePath(input.path).toLowerCase()}`
    case "welcome":
      return "welcome"
  }
}

export function inputTitle(input: EditorInput): string {
  switch (input.kind) {
    case "file":
      return basename(input.path)
    case "diff":
      return `${basename(input.path)} (${input.staged ? "staged" : "cambios"})`
    case "commit":
      return `Commit ${input.hash.slice(0, 7)}`
    case "commitFile":
      return input.label ? `${basename(input.path)} · ${input.label}` : `${basename(input.path)} @ ${input.hash.slice(0, 7)}`
    case "review":
      return "Revisión de cambios"
    case "pr":
      return `PR #${input.number}`
    case "prCreate":
      return "Nuevo pull request"
    case "graph":
      return "Historial"
    case "chat":
      return "Chat"
    case "routine":
      return input.id === "new" ? "Nueva rutina" : "Rutina"
    case "remote":
      return "Conectar el celular"
    case "desktop":
      return "Control de la PC"
    case "accounts":
      return "Cuentas de IA"
    case "aiReview":
      return input.scope === "pr" ? `Revisión IA · PR #${input.number}` : "Revisión IA · cambios"
    case "featureCreate":
      return input.repo ? `Nueva feature · ${basename(input.repo)}` : "Nueva feature"
    case "featureIntegrate":
      return `Integrar ${basename(input.path)}`
    case "welcome":
      return "Bienvenida"
  }
}

let groupCounter = 1
const newGroupId = () => `g${groupCounter++}`
let revealNonce = 1

function firstGroup(): Group {
  return { id: newGroupId(), tabs: [], activeId: null }
}

const initialGroup = firstGroup()

export const useEditors = create<EditorsState>(() => ({
  groups: [initialGroup],
  activeGroupId: initialGroup.id,
  reveal: null,
  focusNonce: 0,
}))

function mapGroup(groups: Group[], id: string, fn: (g: Group) => Group): Group[] {
  return groups.map((g) => (g.id === id ? fn(g) : g))
}

export function findTab(id: string): { group: Group; tab: Tab } | null {
  for (const group of useEditors.getState().groups) {
    const tab = group.tabs.find((t) => t.id === id)
    if (tab) return { group, tab }
  }
  return null
}

export type OpenOptions = {
  preview?: boolean
  groupId?: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  focus?: boolean
}

export function openEditor(input: EditorInput, opts: OpenOptions = {}): string {
  const id = tabId(input)
  const state = useEditors.getState()
  const existing = findTab(id)
  const preview = opts.preview ?? false
  let groups = state.groups
  let groupId = opts.groupId ?? state.activeGroupId
  if (existing) {
    groupId = existing.group.id
    groups = mapGroup(groups, groupId, (g) => ({
      ...g,
      activeId: id,
      tabs: g.tabs.map((t) => (t.id === id && !preview ? { ...t, preview: false } : t)),
    }))
  } else {
    if (!groups.some((g) => g.id === groupId)) groupId = groups[0].id
    groups = mapGroup(groups, groupId, (g) => {
      const tab: Tab = { id, input, preview }
      const previewIndex = preview ? g.tabs.findIndex((t) => t.preview) : -1
      if (previewIndex !== -1) {
        const tabs = [...g.tabs]
        tabs[previewIndex] = tab
        return { ...g, tabs, activeId: id }
      }
      const activeIndex = g.tabs.findIndex((t) => t.id === g.activeId)
      const tabs = [...g.tabs]
      tabs.splice(activeIndex === -1 ? tabs.length : activeIndex + 1, 0, tab)
      return { ...g, tabs, activeId: id }
    })
  }
  const reveal =
    opts.line !== undefined
      ? { tabId: id, line: opts.line, column: opts.column, endLine: opts.endLine, endColumn: opts.endColumn, nonce: revealNonce++ }
      : state.reveal
  useEditors.setState({
    groups,
    activeGroupId: groupId,
    reveal,
    focusNonce: opts.focus === false ? state.focusNonce : state.focusNonce + 1,
  })
  if (useLayout.getState().focusChat) useLayout.getState().toggleFocusChat(false)
  return id
}

export function openFile(path: string, opts: OpenOptions = {}): string {
  return openEditor({ kind: "file", path: normalizePath(path) }, opts)
}

export function pinTab(id: string): void {
  useEditors.setState((s) => ({
    groups: s.groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) })),
  }))
}

export function setActiveTab(groupId: string, id: string): void {
  useEditors.setState((s) => ({
    groups: mapGroup(s.groups, groupId, (g) => ({ ...g, activeId: id })),
    activeGroupId: groupId,
  }))
}

export function setActiveGroup(groupId: string): void {
  if (useEditors.getState().activeGroupId !== groupId) useEditors.setState({ activeGroupId: groupId })
}

export function removeTabs(predicate: (tab: Tab, group: Group) => boolean): void {
  useEditors.setState((s) => {
    let groups = s.groups.map((g) => {
      const remaining = g.tabs.filter((t) => !predicate(t, g))
      if (remaining.length === g.tabs.length) return g
      let activeId = g.activeId
      if (activeId && !remaining.some((t) => t.id === activeId)) {
        const oldIndex = g.tabs.findIndex((t) => t.id === activeId)
        activeId = remaining[Math.min(oldIndex, remaining.length - 1)]?.id ?? null
      }
      return { ...g, tabs: remaining, activeId }
    })
    if (groups.length > 1) groups = groups.filter((g) => g.tabs.length > 0)
    if (groups.length === 0) groups = [firstGroup()]
    const activeGroupId = groups.some((g) => g.id === s.activeGroupId) ? s.activeGroupId : groups[groups.length - 1].id
    return { groups, activeGroupId }
  })
}

function withoutTab(g: Group, id: string): Group {
  const index = g.tabs.findIndex((t) => t.id === id)
  if (index === -1) return g
  const tabs = g.tabs.filter((t) => t.id !== id)
  const activeId = g.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : g.activeId
  return { ...g, tabs, activeId }
}

export function moveTabToNextGroup(id: string): void {
  const found = findTab(id)
  if (!found) return
  const s = useEditors.getState()
  const sourceIndex = s.groups.findIndex((g) => g.id === found.group.id)
  const target = s.groups[sourceIndex + 1]
  if (!target && found.group.tabs.length === 1) return
  const tab: Tab = { ...found.tab, preview: false }
  let groups = s.groups.map((g) => (g.id === found.group.id ? withoutTab(g, id) : g))
  let activeGroupId: string
  if (target) {
    groups = groups.map((g) => (g.id === target.id ? { ...g, tabs: [...g.tabs, tab], activeId: id } : g))
    activeGroupId = target.id
  } else {
    const group: Group = { id: newGroupId(), tabs: [tab], activeId: id }
    groups.splice(sourceIndex + 1, 0, group)
    activeGroupId = group.id
  }
  groups = groups.filter((g) => g.tabs.length > 0)
  useEditors.setState({ groups, activeGroupId, focusNonce: s.focusNonce + 1 })
}

export function moveTabToPreviousGroup(id: string): void {
  const found = findTab(id)
  if (!found) return
  const s = useEditors.getState()
  const sourceIndex = s.groups.findIndex((g) => g.id === found.group.id)
  const target = s.groups[sourceIndex - 1]
  if (!target) return
  const tab: Tab = { ...found.tab, preview: false }
  const groups = s.groups
    .map((g) => (g.id === found.group.id ? withoutTab(g, id) : g))
    .map((g) => (g.id === target.id ? { ...g, tabs: [...g.tabs, tab], activeId: id } : g))
    .filter((g) => g.tabs.length > 0)
  useEditors.setState({ groups, activeGroupId: target.id, focusNonce: s.focusNonce + 1 })
}

export function cycleTab(delta: 1 | -1): void {
  const s = useEditors.getState()
  const group = s.groups.find((g) => g.id === s.activeGroupId)
  if (!group || group.tabs.length < 2) return
  const index = group.tabs.findIndex((t) => t.id === group.activeId)
  const next = group.tabs[(index + delta + group.tabs.length) % group.tabs.length]
  setActiveTab(group.id, next.id)
}

export function activeTab(): Tab | null {
  const s = useEditors.getState()
  const group = s.groups.find((g) => g.id === s.activeGroupId)
  return group?.tabs.find((t) => t.id === group.activeId) ?? null
}

export function activeFilePath(): string | null {
  const tab = activeTab()
  if (!tab) return null
  if (tab.input.kind === "file") return tab.input.path
  return null
}

export function openTabsForPath(path: string): Tab[] {
  const out: Tab[] = []
  for (const g of useEditors.getState().groups)
    for (const t of g.tabs) if (t.input.kind === "file" && samePath(t.input.path, path)) out.push(t)
  return out
}

export function consumeReveal(tabIdToMatch: string): RevealRequest | null {
  const r = useEditors.getState().reveal
  if (!r || r.tabId !== tabIdToMatch) return null
  useEditors.setState({ reveal: null })
  return r
}

const PERSISTED_KINDS = new Set<EditorInput["kind"]>(["file", "diff", "review", "chat", "graph"])

export function restoreEditors(project: string): void {
  const saved = loadJson<{ groups: Array<{ tabs: EditorInput[]; active: number }>; activeGroup: number } | null>(
    projectKey(project, "editors.v2"),
    null,
  )
  if (!saved || saved.groups.length === 0) return
  const groups: Group[] = saved.groups
    .map((g) => {
      const tabs = g.tabs.map((input) => ({ id: tabId(input), input, preview: false }))
      return { id: newGroupId(), tabs, activeId: tabs[Math.min(g.active, tabs.length - 1)]?.id ?? null }
    })
    .filter((g) => g.tabs.length > 0)
  if (groups.length === 0) return
  useEditors.setState({ groups, activeGroupId: groups[Math.min(saved.activeGroup, groups.length - 1)].id })
}

export function persistEditors(project: string): () => void {
  return useEditors.subscribe((s) => {
    const groups = s.groups.map((g) => {
      const tabs = g.tabs.filter((t) => PERSISTED_KINDS.has(t.input.kind) && !t.preview)
      return { tabs: tabs.map((t) => t.input), active: Math.max(0, tabs.findIndex((t) => t.id === g.activeId)) }
    })
    saveJson(projectKey(project, "editors.v2"), {
      groups,
      activeGroup: Math.max(0, s.groups.findIndex((g) => g.id === s.activeGroupId)),
    })
  })
}

export function resetEditors(): void {
  const group = firstGroup()
  useEditors.setState({ groups: [group], activeGroupId: group.id, reveal: null })
}
