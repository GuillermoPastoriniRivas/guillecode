import { create } from "zustand"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { isTauri } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 3
export const ZOOM_STEP = 0.1

const STORAGE_KEY = "view.zoom"

const clamp = (v: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))
const round = (v: number) => Math.round(v * 100) / 100

// En escritorio el zoom lo maneja la webview (afecta toda la UI, como el zoom
// del navegador). En el navegador (dev/PWA) caemos a CSS zoom sobre <html>.
function apply(scale: number): void {
  if (isTauri) void getCurrentWebview().setZoom(scale).catch(() => undefined)
  else document.documentElement.style.zoom = String(scale)
}

const stored = loadJson<number>(STORAGE_KEY, 1)
const INITIAL = Number.isFinite(stored) ? round(clamp(stored)) : 1

type ZoomState = {
  level: number
  set: (v: number) => void
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  apply: () => void
}

export const useZoom = create<ZoomState>((set, get) => ({
  level: INITIAL,
  set: (v) => set({ level: round(clamp(v)) }),
  zoomIn: () => set({ level: round(clamp(get().level + ZOOM_STEP)) }),
  zoomOut: () => set({ level: round(clamp(get().level - ZOOM_STEP)) }),
  reset: () => set({ level: 1 }),
  apply: () => apply(get().level),
}))

useZoom.subscribe((s) => {
  saveJson(STORAGE_KEY, s.level)
  apply(s.level)
})
