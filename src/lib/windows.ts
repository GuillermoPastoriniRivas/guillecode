import { getCurrentWindow } from "@tauri-apps/api/window"
import { call, isTauri } from "./tauri"
import { normalizePath } from "./paths"

export type WindowInfo = { label: string; project: string; focused: boolean; main: boolean }

export const MAIN_WINDOW = "main"

export function windowLabel(): string {
  return isTauri ? getCurrentWindow().label : MAIN_WINDOW
}

export function isMainWindow(): boolean {
  return windowLabel() === MAIN_WINDOW
}

export const windowNew = (path?: string | null) => call<string>("window_new", { path: path ?? null })

export async function windowsList(): Promise<WindowInfo[]> {
  const list = await call<WindowInfo[]>("windows_list")
  return list.map((w) => ({ ...w, project: w.project ? normalizePath(w.project) : "" }))
}

export const windowFocus = (label: string) => call<void>("window_focus", { label })
