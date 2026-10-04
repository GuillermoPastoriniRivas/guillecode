const TOKEN_KEY = "guillecode.remote.token"
let connectionToken: string | null = null

export type SessionInfo = { id: string; title: string; parentID?: string; directory?: string; time: { created: number; updated: number } }

export type Part = {
  id: string
  sessionID?: string
  messageID?: string
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  mime?: string
  url?: string
  filename?: string
  state?: { status?: string; title?: string; input?: Record<string, unknown>; attachments?: Array<{ mime?: string; url?: string; filename?: string }> }
}

export type ModelRef = { providerID: string; modelID: string }

export type MessageInfo = {
  id: string
  sessionID?: string
  role: "user" | "assistant"
  parentID?: string
  agent?: string
  model?: ModelRef
  providerID?: string
  modelID?: string
  time: { created: number; completed?: number }
  error?: { name?: string; data?: { message?: string } }
}

export type Message = { info: MessageInfo; parts: Part[] }

export type Permission = { id: string; sessionID: string; permission: string; patterns: string[] }

export type QuestionItem = { question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean }

export type Question = { id: string; sessionID: string; questions: QuestionItem[] }

export type Schedule =
  | { kind: "interval"; hours: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }

export type RoutineRun = { id: string; startedAt: number; finishedAt: number | null; status: string; summary: string; error: string | null; sessionId: string | null }

export type Routine = { id: string; name: string; project: string; schedule: Schedule; enabled: boolean; nextRun: number | null; runs: RoutineRun[] }

export type DesktopPrefs = { model?: ModelRef; favorites?: string[]; variants?: Record<string, string>; agent?: string; zenFreeOnly?: boolean }

export type PcActivity = { at: number; channel: "desktop" | "browser"; tool: string; summary: string; ok: boolean }

export type PcMachine = { locked: boolean; interactive: boolean; onBattery: boolean; battery: number | null; hasBattery: boolean; keepAwake: boolean; lidSleeps: boolean }

export type PcStatus = {
  enabled: boolean
  paused: boolean
  browser: boolean
  browserActive: boolean
  browserConfigured: boolean
  bridge: { state: string; error: string | null; tools: number }
  activity: PcActivity[]
  machine: PcMachine
  available: boolean
}

export type PcWindow = { id: string; title: string; process: string; foreground: boolean; minimized: boolean; blocked: boolean }

export type HubInfo = {
  current: string
  projects: string[]
  labels?: Record<string, string>
  routines: Routine[]
  errors?: Record<string, string>
  prefs?: DesktopPrefs | null
  voice?: boolean
  desktop?: PcStatus
}

export class AuthError extends Error {}

export type OfflineReason = "no-internet" | "unreachable" | "closed"

export class OfflineError extends Error {
  reason: OfflineReason
  constructor(reason: OfflineReason) {
    super(reason)
    this.reason = reason
  }
}

export function readToken(): string | null {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get("t") ?? new URLSearchParams(url.hash.slice(1)).get("t")
  if (fromUrl) {
    connectionToken = fromUrl
    // Safari/private contexts can deny third-party storage in the fleet iframe.
    if (window.parent === window) {
      try { localStorage.setItem(TOKEN_KEY, fromUrl) } catch { /* keep the in-memory credential */ }
    }
    url.searchParams.delete("t")
    if (new URLSearchParams(url.hash.slice(1)).has("t")) url.hash = ""
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }
  if (connectionToken) return connectionToken
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function authHeader(): string {
  if (connectionToken) return `Bearer ${connectionToken}`
  try { return `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ""}` } catch { return "Bearer " }
}

function isLocal(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
}

function unreachable(): OfflineError {
  if (!navigator.onLine) return new OfflineError("no-internet")
  return new OfflineError(isLocal() ? "closed" : "unreachable")
}

type ErrorBody = { error?: string; data?: { message?: string }; message?: string }

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const json = body !== undefined && !(body instanceof Blob)
  const contentType = body instanceof Blob ? body.type || "application/octet-stream" : json ? "application/json" : null
  let res: Response
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        Authorization: authHeader(),
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      body: body instanceof Blob ? body : json ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw unreachable()
  }
  if (res.status === 401) throw new AuthError("El link venció o es de otra PC. Volvé a escanear el QR desde GuilleCode.")
  const text = await res.text()
  if (!res.ok) {
    let parsed: ErrorBody | null = null
    try {
      parsed = JSON.parse(text) as ErrorBody
    } catch {
      parsed = null
    }
    if (!parsed && res.status >= 502 && res.status <= 504) throw new OfflineError("closed")
    throw new Error(parsed?.error ?? parsed?.data?.message ?? parsed?.message ?? (text || res.statusText))
  }
  return (text ? JSON.parse(text) : undefined) as T
}

export function oc<T>(method: string, path: string, directory: string, body?: unknown): Promise<T> {
  const sep = path.includes("?") ? "&" : "?"
  return request<T>(method, `/oc${path}${sep}directory=${encodeURIComponent(directory)}`, body)
}

export function hub<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, `/hub${path}`, body)
}

export async function screenshot(window: string | null, max: number): Promise<string> {
  const qs = new URLSearchParams({ max: String(max) })
  if (window) qs.set("window", window)
  let res: Response
  try {
    res = await fetch(`/hub/desktop/screen?${qs}`, { headers: { Authorization: authHeader() }, cache: "no-store" })
  } catch {
    throw unreachable()
  }
  if (res.status === 401) throw new AuthError("El link venció o es de otra PC. Volvé a escanear el QR desde GuilleCode.")
  if (res.status === 404) throw new Error("Tu GuilleCode todavía no tiene esta función: reinicialo en la PC.")
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null
    throw new Error(body?.error ?? `No se pudo capturar la pantalla (${res.status})`)
  }
  return URL.createObjectURL(await res.blob())
}

export async function transcribe(audio: Blob): Promise<string> {
  const res = await request<{ text?: string }>("POST", "/hub/transcribe", audio)
  return (res.text ?? "").trim()
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export type LiveEvent = { type: string; directory?: string; properties?: Record<string, unknown> }

export type LiveStatus = "connecting" | "open" | "down" | "unsupported"

const STALL_MS = 40000

export function connectLive(session: string | null, onEvent: (e: LiveEvent) => void, onStatus: (s: LiveStatus) => void): () => void {
  let stopped = false
  let failures = 0
  let ctrl: AbortController | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let lastData = Date.now()
  const watchdog = setInterval(() => {
    if (ctrl && Date.now() - lastData > STALL_MS) ctrl.abort()
  }, 10000)

  const run = async () => {
    if (stopped) return
    ctrl = new AbortController()
    lastData = Date.now()
    onStatus("connecting")
    try {
      const qs = session ? `?session=${encodeURIComponent(session)}` : ""
      const res = await fetch(`/hub/events${qs}`, { headers: { Authorization: authHeader() }, cache: "no-store", signal: ctrl.signal })
      if (res.status === 404) {
        onStatus("unsupported")
        return
      }
      if (!res.ok || !res.body) throw new Error(String(res.status))
      failures = 0
      onStatus("open")
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        lastData = Date.now()
        buffer += value
        let cut = buffer.indexOf("\n\n")
        while (cut >= 0) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n")
          if (data) {
            try {
              onEvent(JSON.parse(data) as LiveEvent)
            } catch {
              onEvent({ type: "resync" })
            }
          }
          cut = buffer.indexOf("\n\n")
        }
      }
    } catch {
      if (stopped) return
    }
    if (stopped) return
    onStatus("down")
    failures += 1
    retry = setTimeout(() => void run(), Math.min(10000, 1000 * failures))
  }

  void run()
  return () => {
    stopped = true
    clearInterval(watchdog)
    if (retry) clearTimeout(retry)
    ctrl?.abort()
  }
}

const projectLabels = new Map<string, string>()

function labelKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

export function setProjectLabels(labels: Record<string, string> | undefined): void {
  projectLabels.clear()
  for (const [path, label] of Object.entries(labels ?? {})) projectLabels.set(labelKey(path), label)
}

export function projectName(path: string): string {
  return projectLabels.get(labelKey(path)) ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return norm(a) === norm(b)
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return "recién"
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return `hace ${Math.round(s / 86400)} d`
}

const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]

export function scheduleLabel(s: Schedule): string {
  if (s.kind === "interval") return s.hours === 1 ? "Cada hora" : `Cada ${s.hours} h`
  if (s.kind === "daily") return `Diaria ${s.time}`
  return `${[...s.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(" ")} ${s.time}`
}

export const HELPER_PREFIX = "guillecode·"

export function isHelper(s: SessionInfo): boolean {
  return (s.title ?? "").startsWith(HELPER_PREFIX)
}
