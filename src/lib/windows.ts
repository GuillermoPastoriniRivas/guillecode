import { getCurrentWindow } from "@tauri-apps/api/window"
import { call, isTauri } from "./tauri"
import { normalizePath } from "./paths"

export type WindowInfo = { label: string; project: string; focused: boolean; main: boolean; bubble: boolean; session?: string }
export type BubbleInfo = { session: string; origin: string }

export const MAIN_WINDOW = "main"
export const BUBBLE_PREFIX = "bubble-"

export function windowLabel(): string {
  return isTauri ? getCurrentWindow().label : MAIN_WINDOW
}

export function isMainWindow(): boolean {
  return windowLabel() === MAIN_WINDOW
}

export function isBubbleWindow(): boolean {
  return windowLabel().startsWith(BUBBLE_PREFIX)
}

export const windowNew = (path?: string | null) => call<string>("window_new", { path: path ?? null })

export const windowBubble = (session: string, title?: string | null) => call<string>("window_bubble", { session, title: title ?? null })

export const windowBubbleInfo = () => call<BubbleInfo | null>("window_bubble_info")

export async function windowsList(): Promise<WindowInfo[]> {
  const list = await call<WindowInfo[]>("windows_list")
  return list.map((w) => ({ ...w, project: w.project ? normalizePath(w.project) : "" }))
}

export const windowFocus = (label: string) => call<void>("window_focus", { label })
