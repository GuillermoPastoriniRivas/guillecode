import { create } from "zustand"
import { loadJson, saveJson } from "../lib/persist"

export type ViewId = "explorer" | "search" | "scm" | "agents" | "prs" | "routines" | "memory"
export type PanelTab = "terminal" | "output"

type LayoutData = {
  sidebarVisible: boolean
  sidebarWidth: number
  activeView: ViewId
  panelVisible: boolean
  panelHeight: number
  panelTab: PanelTab
  agentVisible: boolean
  agentWidth: number
  panelMaximized: boolean
  focusChat: boolean
}

type LayoutState = LayoutData & {
  toggleSidebar: () => void
  showView: (view: ViewId, toggle?: boolean) => void
  togglePanel: () => void
  showPanel: (tab: PanelTab) => void
  toggleAgent: (visible?: boolean) => void
  setSidebarWidth: (w: number) => void
  setPanelHeight: (h: number) => void
  setAgentWidth: (w: number) => void
  togglePanelMaximized: () => void
  toggleFocusChat: (on?: boolean) => void
  applyPreset: (preset: "balanced" | "agent" | "code" | "review") => void
  fitToViewport: () => void
}

const STORAGE_KEY = "layout.v2"

const DEFAULTS: LayoutData = {
  sidebarVisible: true,
  sidebarWidth: 270,
  activeView: "explorer",
  panelVisible: false,
  panelHeight: 260,
  panelTab: "terminal",
  agentVisible: true,
  agentWidth: 460,
  panelMaximized: false,
  focusChat: false,
}

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 640
export const AGENT_MIN = 320
export const AGENT_MAX_RATIO = 0.72
export const PANEL_MIN = 120

const ACTIVITY_W = 48
const SASH_W = 4
export const CENTER_MIN = 300
const PANEL_VERTICAL_MARGIN = 200

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback)
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))

type Widths = Pick<LayoutData, "sidebarWidth" | "agentWidth" | "panelHeight">

// Nunca dejamos que los anchos persistidos (o el preset "Foco en el agente")
// achiquen la columna del editor por debajo de CENTER_MIN: con el chat y la
// terminal abiertos esa columna es la que colapsaba y rompía la UI.
function clampToViewport(s: LayoutData): Widths {
  const winW = window.innerWidth || 1280
  const winH = window.innerHeight || 800
  let sidebar = num(s.sidebarWidth, DEFAULTS.sidebarWidth)
  let agent = num(s.agentWidth, DEFAULTS.agentWidth)
  if (s.sidebarVisible) sidebar = clamp(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  if (s.agentVisible) agent = clamp(agent, AGENT_MIN, winW * AGENT_MAX_RATIO)
  const chrome = ACTIVITY_W + (s.sidebarVisible ? SASH_W : 0) + (s.agentVisible ? SASH_W : 0)
  const avail = winW - chrome - CENTER_MIN
  if (s.sidebarVisible && s.agentVisible && sidebar + agent > avail) {
    const over = sidebar + agent - avail
    const agentCut = Math.min(over, agent - AGENT_MIN)
    agent -= agentCut
    const rest = over - agentCut
    if (rest > 0) sidebar = Math.max(SIDEBAR_MIN, sidebar - rest)
  } else if (s.sidebarVisible && !s.agentVisible) {
    sidebar = Math.min(sidebar, Math.max(SIDEBAR_MIN, avail))
  } else if (s.agentVisible && !s.sidebarVisible) {
    agent = Math.min(agent, Math.max(AGENT_MIN, avail))
  }
  const panelHeight = clamp(num(s.panelHeight, DEFAULTS.panelHeight), PANEL_MIN, winH - PANEL_VERTICAL_MARGIN)
  return { sidebarWidth: Math.round(sidebar), agentWidth: Math.round(agent), panelHeight: Math.round(panelHeight) }
}

const persisted = loadJson<Partial<LayoutData>>(STORAGE_KEY, {})
const INITIAL: LayoutData = { ...DEFAULTS, ...persisted, focusChat: false }

export const useLayout = create<LayoutState>((set, get) => ({
  ...INITIAL,
  ...clampToViewport(INITIAL),
  toggleSidebar: () => {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }))
    get().fitToViewport()
  },
  showView: (view, toggle = true) => {
    const s = get()
    if (toggle && s.sidebarVisible && s.activeView === view) set({ sidebarVisible: false })
    else set({ activeView: view, sidebarVisible: true })
    get().fitToViewport()
  },
  togglePanel: () => {
    set((s) => ({
      panelVisible: !s.panelVisible,
      panelMaximized: s.panelVisible ? false : s.panelMaximized,
      focusChat: s.panelVisible ? s.focusChat : false,
    }))
    get().fitToViewport()
  },
  showPanel: (tab) => set({ panelVisible: true, panelTab: tab, focusChat: false }),
  toggleAgent: (visible) => {
    set((s) => {
      const next = visible ?? !s.agentVisible
      return { agentVisible: next, focusChat: next ? s.focusChat : false }
    })
    get().fitToViewport()
  },
  setSidebarWidth: (w) => {
    const s = get()
    const chrome = ACTIVITY_W + (s.agentVisible ? SASH_W : 0) + SASH_W
    const avail = window.innerWidth - chrome - (s.agentVisible ? s.agentWidth : 0) - CENTER_MIN
    set({ sidebarWidth: Math.round(clamp(w, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, avail))) })
  },
  setPanelHeight: (h) => set({ panelHeight: Math.round(clamp(h, PANEL_MIN, window.innerHeight - PANEL_VERTICAL_MARGIN)) }),
  setAgentWidth: (w) => {
    const s = get()
    const chrome = ACTIVITY_W + (s.sidebarVisible ? SASH_W : 0) + SASH_W
    const byCenter = window.innerWidth - chrome - (s.sidebarVisible ? s.sidebarWidth : 0) - CENTER_MIN
    const max = Math.max(AGENT_MIN, Math.min(window.innerWidth * AGENT_MAX_RATIO, byCenter))
    set({ agentWidth: Math.round(clamp(w, AGENT_MIN, max)) })
  },
  togglePanelMaximized: () => set((s) => ({ panelMaximized: !s.panelMaximized, panelVisible: true })),
  toggleFocusChat: (on) => {
    set((s) => {
      const next = on ?? !s.focusChat
      if (next === s.focusChat) return {}
      return { focusChat: next, agentVisible: next ? true : s.agentVisible }
    })
    get().fitToViewport()
  },
  applyPreset: (preset) => {
    const width = window.innerWidth
    if (preset === "agent") set({ agentVisible: true, sidebarVisible: false, agentWidth: Math.round(width * 0.62), focusChat: false })
    else if (preset === "code") set({ agentVisible: false, sidebarVisible: true, focusChat: false })
    else if (preset === "review") set({ agentVisible: true, sidebarVisible: true, activeView: "scm", agentWidth: 400, focusChat: false })
    else set({ agentVisible: true, sidebarVisible: true, agentWidth: DEFAULTS.agentWidth, sidebarWidth: DEFAULTS.sidebarWidth, focusChat: false })
    get().fitToViewport()
  },
  fitToViewport: () => set(clampToViewport(get())),
}))

useLayout.subscribe((s) => {
  const data: Omit<LayoutData, "focusChat"> = {
    sidebarVisible: s.sidebarVisible,
    sidebarWidth: s.sidebarWidth,
    activeView: s.activeView,
    panelVisible: s.panelVisible,
    panelHeight: s.panelHeight,
    panelTab: s.panelTab,
    agentVisible: s.agentVisible,
    agentWidth: s.agentWidth,
    panelMaximized: s.panelMaximized,
  }
  saveJson(STORAGE_KEY, data)
})
