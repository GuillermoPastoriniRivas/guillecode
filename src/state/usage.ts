import { create } from "zustand"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { subscribeSessionFinished, useAgent } from "./agent"
import { CHATGPT } from "./accounts"
import { notify, useToasts } from "./toasts"
import { confirmAction } from "../components/Dialog"
import { percent } from "../lib/format"

export const GO_PROVIDER = "opencode-go"

export type ChatgptWindow = { usedPercent: number; windowSeconds: number; resetsAt: number | null }
export type ChatgptUsage = { plan: string; windows: ChatgptWindow[]; limitReached: boolean; resetsAvailable?: number | null; measuredAt: number }

export type ChatgptResetCredit = {
  id: string
  status: string
  title: string | null
  description: string | null
  grantedAt: number | null
  expiresAt: number | null
}
export type ChatgptResets = { credits: ChatgptResetCredit[]; available: number; measuredAt: number }
type ResetOutcome = { outcome: string; windowsReset: number }

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
  resets: ChatgptResets | null
  resetsError: string | null
  redeeming: boolean
}

export const useUsage = create<UsageState>(() => ({
  usage: null,
  error: null,
  go: null,
  goError: null,
  limits: { ...DEFAULT_LIMITS, ...loadJson<Partial<UsageLimits>>("usage.goLimits", {}) },
  chatgpt: null,
  chatgptError: null,
  resets: null,
  resetsError: null,
  redeeming: false,
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

let resetsInflight: Promise<void> | null = null

export function refreshChatgptResets(): Promise<void> {
  if (!isTauri) return Promise.resolve()
  resetsInflight ??= call<ChatgptResets>("chatgpt_resets")
    .then((resets) => useUsage.setState({ resets, resetsError: null }))
    .catch((e) => useUsage.setState({ resetsError: errorMessage(e) }))
    .finally(() => {
      resetsInflight = null
    })
  return resetsInflight
}

export function redeemableResets(resets: ChatgptResets): ChatgptResetCredit[] {
  return resets.credits
    .filter((c) => c.status === "available")
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
    .slice(0, Math.max(0, resets.available))
}

export function resetExpiryLabel(credit: ChatgptResetCredit): string {
  return credit.expiresAt ? `Vence ${renewalLabel(credit.expiresAt)}` : "No vence"
}

export function resetsCountLabel(n: number): string {
  return `${n} reset${n === 1 ? "" : "s"}`
}

function windowsSummary(usage: ChatgptUsage): string {
  return usage.windows.map((w) => `${quotaWindowLabel(w.windowSeconds).toLowerCase()} al ${percent(w.usedPercent / 100)}`).join(", ")
}

export async function redeemChatgptReset(creditId: string | null): Promise<void> {
  const { chatgpt, resets, redeeming } = useUsage.getState()
  if (redeeming) return
  const credit = creditId ? resets?.credits.find((c) => c.id === creditId) : undefined
  const exhausted = !!chatgpt && (chatgpt.limitReached || chatgptWorst(chatgpt) >= 100)
  const lines = ["Reinicia tu ventana de 5 h y la semanal de ChatGPT, la misma cuota que usa Codex. No se puede deshacer."]
  if (chatgpt?.windows.length) lines.push(`Ahora: ${windowsSummary(chatgpt)}.`)
  if (credit) lines.push(`Este reset ${resetExpiryLabel(credit).toLowerCase()}.`)
  if (chatgpt && !exhausted) lines.push("Todavía no llegaste al límite: quizás te convenga guardarlo para cuando lo necesites.")
  if (!(await confirmAction("¿Usar un reset de ChatGPT?", lines.join(" "), "Usar reset", !exhausted))) return
  await consumeReset(creditId, crypto.randomUUID())
}

async function consumeReset(creditId: string | null, requestId: string): Promise<void> {
  useUsage.setState({ redeeming: true })
  let result: ResetOutcome
  try {
    result = await call<ResetOutcome>("chatgpt_use_reset", { requestId, creditId })
  } catch (e) {
    useUsage.setState({ redeeming: false })
    void refreshChatgptResets()
    useToasts.getState().push({
      kind: "error",
      title: "No se pudo usar el reset",
      detail: `${errorMessage(e)}. Reintentar repite el mismo pedido, así que no gasta otro reset.`,
      actions: [{ label: "Reintentar", primary: true, run: () => void consumeReset(creditId, requestId) }],
    })
    return
  }
  await Promise.all([refreshChatgptUsage(), refreshChatgptResets()])
  useUsage.setState({ redeeming: false })
  const left = useUsage.getState().resets?.available
  if (result.outcome === "reset" || result.outcome === "already_redeemed") {
    notify.success("Se reinició tu cuota de ChatGPT", left === undefined ? undefined : `Te ${left === 1 ? "queda" : "quedan"} ${resetsCountLabel(left)}.`)
  } else if (result.outcome === "nothing_to_reset") {
    notify.info("Tu cuota no necesita un reset ahora")
  } else if (result.outcome === "no_credit") {
    notify.warning(creditId ? "Ese reset ya no está disponible" : "No tenés resets disponibles", creditId ? "Actualicé la lista de resets." : undefined)
  } else {
    notify.warning("ChatGPT respondió algo inesperado al usar el reset", result.outcome)
  }
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
