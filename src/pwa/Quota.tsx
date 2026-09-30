import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { hub } from "./api"
import { Icon, Sheet, usePoll } from "./ui"
import "./quota.css"

type QuotaWindow = "fiveHours" | "week" | "month"

type Limits = Record<QuotaWindow, number>

type WindowStat = { usedPercent: number; windowSeconds: number; resetsAt: number | null }

type GoUsage = { windows: WindowStat[]; measuredAt: number }

export type Quota = { provider: string; go: GoUsage | null; limits: Partial<Limits> | null; error?: string }

const DEFAULT_LIMITS: Limits = { fiveHours: 12, week: 30, month: 60 }

const WINDOWS: Array<{ id: QuotaWindow; label: string }> = [
  { id: "fiveHours", label: "Últimas 5 h" },
  { id: "week", label: "Últimos 7 días" },
  { id: "month", label: "Últimos 30 días" },
]

const WINDOW_SECONDS: Record<QuotaWindow, number> = { fiveHours: 5 * 3600, week: 7 * 24 * 3600, month: 30 * 24 * 3600 }

const REFRESH_AFTER_RUN_MS = 2500

function usd(n: number): string {
  return `US$ ${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`
}

function clock(epochMs: number): string {
  const d = new Date(epochMs)
  const hm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  if (d.toDateString() === new Date().toDateString()) return hm
  return `${d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })} ${hm}`
}

function limitsOf(quota: Quota): Limits {
  const out = { ...DEFAULT_LIMITS }
  for (const w of WINDOWS) {
    const v = quota.limits?.[w.id]
    if (typeof v === "number" && v > 0) out[w.id] = v
  }
  return out
}

function toneOf(ratio: number): string {
  return ratio >= 1 ? "error" : ratio >= 0.8 ? "warn" : ""
}

function measure(quota: Quota) {
  const go = quota.go
  if (!go) return null
  const limits = limitsOf(quota)
  const rows = WINDOWS.map((w) => {
    const win = go.windows.find((x) => x.windowSeconds === WINDOW_SECONDS[w.id])
    const ratio = win ? win.usedPercent / 100 : 0
    const limit = limits[w.id]
    const used = ratio * limit
    return { ...w, used, limit, ratio, left: Math.max(0, limit - used), resetsAt: win?.resetsAt ?? null }
  })
  const worst = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a), rows[0])
  const release = rows.find((r) => r.id === "fiveHours")?.resetsAt ?? null
  return { usage: go, rows, worst, release }
}

export function useQuota() {
  const [quota, setQuota] = useState<Quota | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reload = useCallback(
    () =>
      hub<Quota>("GET", "/usage").then(
        (q) => setQuota(q),
        () => undefined,
      ),
    [],
  )

  useEffect(() => {
    void reload()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [reload])

  usePoll(reload, 60000)

  const refreshSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void reload(), REFRESH_AFTER_RUN_MS)
  }, [reload])

  return { quota, reload, refreshSoon }
}

type ChatgptUsage = { plan: string; windows: WindowStat[]; limitReached: boolean; measuredAt: number }

export type ChatgptQuota = { usage: ChatgptUsage | null; error?: string }

function windowLabel(seconds: number): string {
  const hours = Math.round(seconds / 3600)
  if (hours === 24 * 7) return "Semana"
  if (hours < 48) return `Ventana de ${hours} h`
  return `Ventana de ${Math.round(hours / 24)} días`
}

function renewal(epochMs: number): string {
  const d = new Date(epochMs)
  const hm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  if (d.toDateString() === new Date().toDateString()) return `a las ${hm}`
  const weekday = d.toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "")
  return `el ${weekday} ${d.getDate()}/${d.getMonth() + 1}, ${hm}`
}

function chatgptWorst(usage: ChatgptUsage): number {
  return usage.windows.reduce((max, w) => Math.max(max, w.usedPercent), 0) / 100
}

export function useChatgptQuota(enabled: boolean) {
  const [quota, setQuota] = useState<ChatgptQuota | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = useRef(enabled)

  const reload = useCallback(
    () =>
      hub<ChatgptQuota>("GET", "/usage/chatgpt").then(
        (q) => setQuota(q),
        () => undefined,
      ),
    [],
  )

  useEffect(() => {
    active.current = enabled
    if (enabled) void reload()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [enabled, reload])

  usePoll(reload, enabled ? 60000 : null)

  const refreshSoon = useCallback(() => {
    if (!active.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void reload(), REFRESH_AFTER_RUN_MS)
  }, [reload])

  return { quota, reload, refreshSoon }
}

export function ChatgptQuotaChip({ quota, onOpen }: { quota: ChatgptQuota | null; onOpen: () => void }) {
  if (!quota) return null
  const usage = quota.usage
  const worst = usage ? chatgptWorst(usage) : 0
  return (
    <button type="button" className={`quota-chip ${usage ? toneOf(usage.limitReached ? 1 : worst) : "warn"}`} onClick={onOpen} aria-label="Cuota de ChatGPT">
      <Icon name="credit-card" /> ChatGPT {usage ? percent(worst) : "?"}
    </button>
  )
}

function ChatgptSection({ quota }: { quota: ChatgptQuota }) {
  const usage = quota.usage
  return (
    <>
      {!usage && <div className="alert">{quota.error ?? "No pude leer la cuota de ChatGPT."}</div>}
      {usage?.windows.map((w) => {
        const ratio = w.usedPercent / 100
        return (
          <div key={w.windowSeconds} className="quota-row">
            <div className="quota-head">
              <strong>{windowLabel(w.windowSeconds)}</strong>
              <span className={toneOf(ratio)}>{percent(ratio)}</span>
            </div>
            <div className="quota-bar">
              <span className={toneOf(ratio)} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
            </div>
            {w.resetsAt && <small className="muted">Se renueva {renewal(w.resetsAt)}</small>}
          </div>
        )
      })}
      {usage && (
        <small className="muted">
          Es la cuota real de tu plan de ChatGPT, compartida con Codex, medida a las {clock(usage.measuredAt)}.
          {usage.limitReached ? " Llegaste al límite: los modelos de ChatGPT no responden hasta que se renueve." : ""}
        </small>
      )}
    </>
  )
}

function GoSection({ quota }: { quota: Quota }) {
  const m = measure(quota)
  return (
    <>
      {!m && <div className="alert">{quota.error ?? "No pude leer la cuota de OpenCode Go."}</div>}
      {m?.rows.map((r) => (
        <div key={r.id} className="quota-row">
          <div className="quota-head">
            <strong>{r.label}</strong>
            <span className={toneOf(r.ratio)}>{percent(r.ratio)}</span>
          </div>
          <div className="quota-bar">
            <span className={toneOf(r.ratio)} style={{ width: `${Math.min(100, r.ratio * 100)}%` }} />
          </div>
          <small className="muted">
            {r.left > 0 ? `Te quedan ${usd(r.left)}` : "Llegaste al tope"} · usaste {usd(r.used)} de {usd(r.limit)}
            {r.resetsAt ? ` · se renueva ${renewal(r.resetsAt)}` : ""}
          </small>
        </div>
      ))}
      {m && (
        <small className="muted">
          Es la cuota real de OpenCode Go, medida a las {clock(m.usage.measuredAt)}. Los montos salen de tus topes: cambialos en GuilleCode → «Go» → Editar topes.
        </small>
      )}
    </>
  )
}

function ReloadButton({ onReload }: { onReload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void onReload().finally(() => setBusy(false))
      }}
    >
      <Icon name={busy ? "loading" : "refresh"} spin={busy} /> Actualizar
    </button>
  )
}

export function ChatgptQuotaSheet({ quota, onReload, onClose }: { quota: ChatgptQuota; onReload: () => Promise<void>; onClose: () => void }) {
  const usage = quota.usage
  const plan = usage?.plan ? ` ${usage.plan[0].toUpperCase()}${usage.plan.slice(1)}` : ""
  return (
    <Sheet title={`Cuota de ChatGPT${plan}`} onClose={onClose}>
      <ChatgptSection quota={quota} />
      <ReloadButton onReload={onReload} />
    </Sheet>
  )
}

export function QuotaChip({ quota, onGo, onOpen }: { quota: Quota | null; onGo: boolean; onOpen: () => void }) {
  const m = quota ? measure(quota) : null
  if (!m || (!onGo && m.worst.ratio === 0)) return null
  return (
    <button type="button" className={`quota-chip ${toneOf(m.worst.ratio)}`} onClick={onOpen} aria-label="Cuota de OpenCode Go">
      <Icon name="credit-card" /> Go {percent(m.worst.ratio)}
    </button>
  )
}

export function QuotaSheet({ quota, onReload, onClose }: { quota: Quota; onReload: () => Promise<void>; onClose: () => void }) {
  return (
    <Sheet title="Cuota de OpenCode Go" onClose={onClose}>
      <GoSection quota={quota} />
      <ReloadButton onReload={onReload} />
    </Sheet>
  )
}

export type QuotaBarHandle = { refreshSoon: () => void }

export const QuotaBar = forwardRef<QuotaBarHandle, { provider: string }>(function QuotaBar({ provider }, ref) {
  const go = useQuota()
  const chatgpt = useChatgptQuota(provider === "openai")
  const [open, setOpen] = useState(false)
  const goSoon = go.refreshSoon
  const chatgptSoon = chatgpt.refreshSoon

  const refreshSoon = useCallback(() => {
    goSoon()
    chatgptSoon()
  }, [goSoon, chatgptSoon])

  useImperativeHandle(ref, () => ({ refreshSoon }), [refreshSoon])

  if (provider === "openai") {
    return (
      <>
        <ChatgptQuotaChip quota={chatgpt.quota} onOpen={() => setOpen(true)} />
        {open && chatgpt.quota && <ChatgptQuotaSheet quota={chatgpt.quota} onReload={chatgpt.reload} onClose={() => setOpen(false)} />}
      </>
    )
  }
  return (
    <>
      <QuotaChip quota={go.quota} onGo={provider === "opencode-go"} onOpen={() => setOpen(true)} />
      {open && go.quota && <QuotaSheet quota={go.quota} onReload={go.reload} onClose={() => setOpen(false)} />}
    </>
  )
})

export const QuotaHub = forwardRef<QuotaBarHandle>(function QuotaHub(_props, ref) {
  const go = useQuota()
  const chatgpt = useChatgptQuota(true)
  const [open, setOpen] = useState(false)
  const goSoon = go.refreshSoon
  const chatgptSoon = chatgpt.refreshSoon
  const goReload = go.reload
  const chatgptReload = chatgpt.reload

  const refreshSoon = useCallback(() => {
    goSoon()
    chatgptSoon()
  }, [goSoon, chatgptSoon])

  useImperativeHandle(ref, () => ({ refreshSoon }), [refreshSoon])

  const reload = useCallback(() => Promise.all([goReload(), chatgptReload()]).then(() => undefined), [goReload, chatgptReload])

  const goM = go.quota ? measure(go.quota) : null
  const chatgptUsage = chatgpt.quota?.usage ?? null
  const ratios: number[] = []
  if (goM) ratios.push(goM.worst.ratio)
  if (chatgptUsage) ratios.push(chatgptWorst(chatgptUsage))
  const worst = ratios.length > 0 ? Math.max(...ratios) : null

  return (
    <>
      <button
        type="button"
        className={`quota-chip ${worst === null ? "warn" : toneOf(worst)}`}
        onClick={() => setOpen(true)}
        aria-label="Cuotas de tus proveedores"
      >
        <Icon name="credit-card" /> Cuotas{worst === null ? "" : ` ${percent(worst)}`}
      </button>
      {open && (
        <Sheet title="Cuotas" onClose={() => setOpen(false)}>
          <section className="quota-block">
            <h3 className="quota-section">ChatGPT</h3>
            {chatgpt.quota ? <ChatgptSection quota={chatgpt.quota} /> : <div className="alert">No pude leer la cuota de ChatGPT.</div>}
          </section>
          <section className="quota-block">
            <h3 className="quota-section">OpenCode Go</h3>
            {go.quota ? <GoSection quota={go.quota} /> : <div className="alert">No pude leer la cuota de OpenCode Go.</div>}
          </section>
          <ReloadButton onReload={reload} />
        </Sheet>
      )}
    </>
  )
})
