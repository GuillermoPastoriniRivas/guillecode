import type { HubInfo, Permission, Question, SessionInfo } from "./api"

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}

type Seen = { baseline: number | null; ids: Record<string, number> }

const SEEN_KEY = "guillecode.seen"
const MAX_SEEN = 400

function readSeen(): Seen {
  return load<Seen>(SEEN_KEY, { baseline: null, ids: {} })
}

export function ensureSeenBaseline(sessions: SessionInfo[]): void {
  const seen = readSeen()
  if (seen.baseline !== null) return
  seen.baseline = sessions.reduce((max, s) => Math.max(max, s.time.updated), 0)
  save(SEEN_KEY, seen)
}

export function isUnread(s: SessionInfo): boolean {
  const seen = readSeen()
  const at = seen.ids[s.id] ?? seen.baseline
  return at !== null && s.time.updated > at
}

export function markSeen(sessions: Array<Pick<SessionInfo, "id" | "time">>): void {
  if (sessions.length === 0) return
  const seen = readSeen()
  for (const s of sessions) seen.ids[s.id] = Math.max(seen.ids[s.id] ?? 0, s.time.updated)
  const entries = Object.entries(seen.ids)
  if (entries.length > MAX_SEEN) seen.ids = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN))
  save(SEEN_KEY, seen)
}

export type ProjectData = {
  project: string
  sessions: SessionInfo[]
  parents: Record<string, string>
  busy: Record<string, boolean>
  permissions: Permission[]
  questions: Question[]
}

export type HomeCache = { info: HubInfo; data: ProjectData[]; at: number }

const HOME_KEY = "guillecode.home"
const CACHED_SESSIONS = 30

export function cacheHome(info: HubInfo, data: ProjectData[]): void {
  save(HOME_KEY, { info, data: data.map((d) => ({ ...d, sessions: d.sessions.slice(0, CACHED_SESSIONS) })), at: Date.now() })
}

export function readHomeCache(): HomeCache | null {
  return load<HomeCache | null>(HOME_KEY, null)
}

const RECENT_MODELS_KEY = "guillecode.recentModels"

export function recentModels(): string[] {
  return load<string[]>(RECENT_MODELS_KEY, [])
}

export function rememberModel(key: string): void {
  save(RECENT_MODELS_KEY, [key, ...recentModels().filter((k) => k !== key)].slice(0, 6))
}

const PUSH_NUDGE_KEY = "guillecode.pushNudgeDismissed"

export function pushNudgeDismissed(): boolean {
  return load(PUSH_NUDGE_KEY, false)
}

export function dismissPushNudge(): void {
  save(PUSH_NUDGE_KEY, true)
}
