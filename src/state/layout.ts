import { create } from "zustand"
import { loadJson, saveJson } from "../lib/persist"

export type ViewId = "explorer" | "search" | "scm" | "agents" | "prs" | "routines" | "memory" | "plane" | "teams"
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
  /** Ancho del agente antes de entrar en foco-chat, para restaurarlo al salir. */
  agentWidthBeforeFocus: number | null
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
  agentWidthBeforeFocus: null,
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

// Rango permitido del ancho del agente. En foco-chat el centro no se renderiza,
// así que el chat puede ocupar todo lo que sobra a la derecha del sidebar; su
// mínimo baja si la ventana es angosta, dejando siempre margen para moverlo.
function agentRange(s: Pick<LayoutData, "focusChat" | "sidebarVisible" | "sidebarWidth">, winW: number): [number, number] {
  const chrome = ACTIVITY_W + (s.sidebarVisible ? SASH_W : 0) + SASH_W
  const avail = winW - chrome - (s.sidebarVisible ? s.sidebarWidth : 0)
  if (s.focusChat) {
    const max = Math.max(160, avail)
    const min = Math.min(AGENT_MIN, Math.max(160, avail - 40))
    return [Math.min(min, max), max]
  }
  return [AGENT_MIN, Math.max(AGENT_MIN, Math.min(winW * AGENT_MAX_RATIO, avail - CENTER_MIN))]
}

// Nunca dejamos que los anchos persistidos (o el preset "Foco en el agente")
// achiquen la columna del editor por debajo de CENTER_MIN: con el chat y la
// terminal abiertos esa columna es la que colapsaba y rompía la UI.
function clampToViewport(s: LayoutData): Widths {
  const winW = window.innerWidth || 1280
  const winH = window.innerHeight || 800
  let sidebar = num(s.sidebarWidth, DEFAULTS.sidebarWidth)
  let agent = num(s.agentWidth, DEFAULTS.agentWidth)
  if (s.sidebarVisible) sidebar = clamp(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  if (s.focusChat && s.sidebarVisible) {
    // En foco el sidebar cede espacio para que el chat quepa sin desbordar.
    const total = winW - (ACTIVITY_W + SASH_W + SASH_W)
    sidebar = Math.min(sidebar, Math.max(SIDEBAR_MIN, total - AGENT_MIN))
  }
  if (s.agentVisible) {
    const [lo, hi] = agentRange({ ...s, sidebarWidth: sidebar }, winW)
    agent = clamp(agent, lo, hi)
  }
  const panelHeight = clamp(num(s.panelHeight, DEFAULTS.panelHeight), PANEL_MIN, winH - PANEL_VERTICAL_MARGIN)
  if (s.focusChat) return { sidebarWidth: Math.round(sidebar), agentWidth: Math.round(agent), panelHeight }
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
  return { sidebarWidth: Math.round(sidebar), agentWidth: Math.round(agent), panelHeight }
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
      ...(s.panelVisible ? {} : { focusChat: false, agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null }),
    }))
    get().fitToViewport()
  },
  showPanel: (tab) => {
    set((s) => ({ panelVisible: true, panelTab: tab, focusChat: false, agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null }))
    get().fitToViewport()
  },
  toggleAgent: (visible) => {
    set((s) => {
      const next = visible ?? !s.agentVisible
      const focusChat = next ? s.focusChat : false
      const restore = s.focusChat && !focusChat ? { agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null } : {}
      return { agentVisible: next, focusChat, ...restore }
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
    const [lo, hi] = agentRange(s, window.innerWidth)
    set({ agentWidth: Math.round(clamp(w, lo, hi)) })
  },
  togglePanelMaximized: () => set((s) => ({ panelMaximized: !s.panelMaximized, panelVisible: true })),
  toggleFocusChat: (on) => {
    set((s) => {
      const next = on ?? !s.focusChat
      if (next === s.focusChat) return {}
      if (next) {
        return {
          focusChat: true,
          agentVisible: true,
          agentWidthBeforeFocus: s.agentWidth,
          agentWidth: Math.round(agentRange({ ...s, focusChat: true }, window.innerWidth)[1]),
        }
      }
      return { focusChat: false, agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null }
    })
    get().fitToViewport()
  },
  applyPreset: (preset) => {
    const width = window.innerWidth
    if (preset === "agent") set({ agentVisible: true, sidebarVisible: false, agentWidth: Math.round(width * 0.62), focusChat: false, agentWidthBeforeFocus: null })
    else if (preset === "code") set({ agentVisible: false, sidebarVisible: true, focusChat: false, agentWidthBeforeFocus: null })
    else if (preset === "review") set({ agentVisible: true, sidebarVisible: true, activeView: "scm", agentWidth: 400, focusChat: false, agentWidthBeforeFocus: null })
    else set({ agentVisible: true, sidebarVisible: true, agentWidth: DEFAULTS.agentWidth, sidebarWidth: DEFAULTS.sidebarWidth, focusChat: false, agentWidthBeforeFocus: null })
    get().fitToViewport()
  },
  fitToViewport: () => set(clampToViewport(get())),
}))

useLayout.subscribe((s) => {
  const data: Omit<LayoutData, "focusChat" | "agentWidthBeforeFocus"> = {
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
