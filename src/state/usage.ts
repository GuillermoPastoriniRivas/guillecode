import { create } from "zustand"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { subscribeSessionFinished, useAgent } from "./agent"
import { CHATGPT } from "./accounts"

export const GO_PROVIDER = "opencode-go"

export type ChatgptWindow = { usedPercent: number; windowSeconds: number; resetsAt: number | null }
export type ChatgptUsage = { plan: string; windows: ChatgptWindow[]; limitReached: boolean; measuredAt: number }

export type GoUsage = { windows: ChatgptWindow[]; measuredAt: number }

export type UsageWindow = "fiveHours" | "week" | "month"

export type ProviderUsage = Record<UsageWindow, number> & {
  oldestFiveHours: number | null
  messages: number
  measuredAt: number
}

export type UsageLimits = Record<UsageWindow, number>

export const USAGE_WINDOWS: Array<{ id: UsageWindow; label: string; hours: number }> = [
  { id: "fiveHours", label: "Últimas 5 h", hours: 5 },
  { id: "week", label: "Últimos 7 días", hours: 24 * 7 },
  { id: "month", label: "Últimos 30 días", hours: 24 * 30 },
]

const DEFAULT_LIMITS: UsageLimits = { fiveHours: 12, week: 30, month: 60 }
const REFRESH_MS = 60_000

const WINDOW_SECONDS: Record<UsageWindow, number> = { fiveHours: 5 * 3600, week: 7 * 24 * 3600, month: 30 * 24 * 3600 }

type UsageState = {
  usage: ProviderUsage | null
  error: string | null
  go: GoUsage | null
  goError: string | null
  limits: UsageLimits
  chatgpt: ChatgptUsage | null
  chatgptError: string | null
}

export const useUsage = create<UsageState>(() => ({
  usage: null,
  error: null,
  go: null,
  goError: null,
  limits: { ...DEFAULT_LIMITS, ...loadJson<Partial<UsageLimits>>("usage.goLimits", {}) },
  chatgpt: null,
  chatgptError: null,
}))

function shareLimits(limits: UsageLimits): void {
  if (!isTauri) return
  void call("remote_set_prefs", { prefs: { usageLimits: limits } }).catch(() => undefined)
}

shareLimits(useUsage.getState().limits)

useUsage.subscribe((s, prev) => {
  if (s.limits === prev.limits) return
  saveJson("usage.goLimits", s.limits)
  shareLimits(s.limits)
})

let inflight: Promise<void> | null = null

export function refreshUsage(): Promise<void> {
  if (!isTauri) return Promise.resolve()
  inflight ??= call<ProviderUsage>("provider_usage", { provider: GO_PROVIDER })
    .then((usage) => useUsage.setState({ usage, error: null }))
    .catch((e) => useUsage.setState({ error: errorMessage(e) }))
    .finally(() => {
      inflight = null
    })
  return inflight
}

let goInflight: Promise<void> | null = null

export function refreshGoUsage(): Promise<void> {
  if (!isTauri) return Promise.resolve()
  goInflight ??= call<GoUsage>("go_usage")
    .then((go) => useUsage.setState({ go, goError: null }))
    .catch((e) => useUsage.setState({ goError: errorMessage(e) }))
    .finally(() => {
      goInflight = null
    })
  return goInflight
}

let chatgptInflight: Promise<void> | null = null

export function refreshChatgptUsage(): Promise<void> {
  if (!isTauri) return Promise.resolve()
  chatgptInflight ??= call<ChatgptUsage>("chatgpt_usage")
    .then((chatgpt) => useUsage.setState({ chatgpt, chatgptError: null }))
    .catch((e) => useUsage.setState({ chatgptError: errorMessage(e) }))
    .finally(() => {
      chatgptInflight = null
    })
  return chatgptInflight
}

function onChatgpt(): boolean {
  return useAgent.getState().model.providerID === CHATGPT
}

function refreshAll(): void {
  void refreshUsage()
  void refreshGoUsage()
  if (onChatgpt()) void refreshChatgptUsage()
}

let polling = false

export function startUsagePolling(): void {
  if (polling || !isTauri) return
  polling = true
  refreshAll()
  setInterval(() => {
    if (!document.hidden) refreshAll()
  }, REFRESH_MS)
  subscribeSessionFinished(refreshAll)
  useAgent.subscribe((s, prev) => {
    if (s.model.providerID !== prev.model.providerID && s.model.providerID === CHATGPT) void refreshChatgptUsage()
  })
}

export function chatgptWorst(usage: ChatgptUsage): number {
  return usage.windows.reduce((max, w) => Math.max(max, w.usedPercent), 0)
}

export function quotaWindowLabel(seconds: number): string {
  const hours = Math.round(seconds / 3600)
  if (hours === 24 * 7) return "Semana"
  if (hours < 48) return `Ventana de ${hours} h`
  return `Ventana de ${Math.round(hours / 24)} días`
}

export function renewalLabel(epochMs: number): string {
  const d = new Date(epochMs)
  const hm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  if (d.toDateString() === new Date().toDateString()) return `a las ${hm}`
  const weekday = d.toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "")
  return `el ${weekday} ${d.getDate()}/${d.getMonth() + 1}, ${hm}`
}

export function setUsageLimits(limits: UsageLimits): void {
  useUsage.setState({ limits })
}

export function usageRatio(usage: ProviderUsage, limits: UsageLimits, window: UsageWindow): number {
  const limit = limits[window]
  return limit > 0 ? usage[window] / limit : 0
}

export function fiveHourRelease(usage: ProviderUsage): number | null {
  return usage.oldestFiveHours ? usage.oldestFiveHours + 5 * 3_600_000 : null
}

export type GoRow = { id: UsageWindow; label: string; ratio: number; resetsAt: number | null }

export function goRows(go: GoUsage): GoRow[] {
  return USAGE_WINDOWS.map((w) => {
    const win = go.windows.find((x) => x.windowSeconds === WINDOW_SECONDS[w.id])
    return { id: w.id, label: w.label, ratio: win ? win.usedPercent / 100 : 0, resetsAt: win?.resetsAt ?? null }
  })
}
