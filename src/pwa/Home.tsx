import { useCallback, useEffect, useRef, useState } from "react"
import {
  AuthError,
  OfflineError,
  ago,
  errorText,
  hub,
  isHelper,
  oc,
  projectName,
  samePath,
  scheduleLabel,
  type HubInfo,
  type LiveEvent,
  type OfflineReason,
  type Permission,
  type Question,
  type Routine,
  type SessionInfo,
} from "./api"
import { Composer, promptBody } from "./Composer"
import { cacheHome, dismissPushNudge, ensureSeenBaseline, isUnread, markSeen, pushNudgeDismissed, readHomeCache, type ProjectData } from "./local"
import { NotificationSettings, usePushStatus } from "./Notifications"
import { PcCard } from "./Pc"
import { ChatgptQuotaChip, ChatgptQuotaSheet, QuotaChip, QuotaSheet, useChatgptQuota, useQuota } from "./Quota"
import { Icon, Md, OfflineBanner, useLive, usePoll } from "./ui"

export type Route = { kind: "home" } | { kind: "session"; project: string; id: string; title: string }

const MAX_PROJECTS = 8
const FIRST_PAGE = 6
const PAGE = 10

type SessionState = "attention" | "busy" | "error" | "unread" | "idle"

function sortSessions(list: SessionInfo[]): SessionInfo[] {
  return [...list].sort((a, b) => b.time.updated - a.time.updated)
}

function rootOf(parents: Record<string, string>, id: string): string {
  let current = id
  for (let i = 0; i < 12 && parents[current]; i++) current = parents[current]
  return current
}

async function loadProject(project: string): Promise<ProjectData> {
  const [sessions, status, permissions, questions] = await Promise.all([
    oc<SessionInfo[]>("GET", "/session", project),
    oc<Record<string, { type: string }>>("GET", "/session/status", project).catch(() => ({})),
    oc<Permission[]>("GET", "/permission", project).catch(() => []),
    oc<Question[]>("GET", "/question", project).catch(() => []),
  ])
  const busy: Record<string, boolean> = {}
  for (const [id, st] of Object.entries(status ?? {})) busy[id] = st.type !== "idle"
  const parents: Record<string, string> = {}
  for (const s of sessions ?? []) if (s.parentID) parents[s.id] = s.parentID
  return {
    project,
    sessions: sortSessions((sessions ?? []).filter((s) => !s.parentID && !isHelper(s))),
    parents,
    busy,
    permissions: permissions ?? [],
    questions: questions ?? [],
  }
}

function applyEvent(d: ProjectData, e: LiveEvent): ProjectData {
  const p = (e.properties ?? {}) as Record<string, unknown>
  switch (e.type) {
    case "session.status": {
      const id = p.sessionID as string
      return { ...d, busy: { ...d.busy, [id]: (p.status as { type?: string } | undefined)?.type !== "idle" } }
    }
    case "session.idle":
      return { ...d, busy: { ...d.busy, [p.sessionID as string]: false } }
    case "session.created":
    case "session.updated": {
      const info = p.info as SessionInfo
      if (info.parentID) return { ...d, parents: { ...d.parents, [info.id]: info.parentID } }
      const rest = d.sessions.filter((s) => s.id !== info.id)
      return { ...d, sessions: isHelper(info) ? rest : sortSessions([info, ...rest]) }
    }
    case "session.deleted": {
      const id = (p.info as SessionInfo).id
      return { ...d, sessions: d.sessions.filter((s) => s.id !== id) }
    }
    case "permission.asked": {
      const req = p as unknown as Permission
      return { ...d, permissions: [...d.permissions.filter((x) => x.id !== req.id), req] }
    }
    case "permission.replied": {
      const id = (p.requestID ?? p.permissionID) as string
      return { ...d, permissions: d.permissions.filter((x) => x.id !== id) }
    }
    case "question.asked": {
      const req = p as unknown as Question
      return { ...d, questions: [...d.questions.filter((x) => x.id !== req.id), req] }
    }
    case "question.replied":
    case "question.rejected": {
      const id = p.requestID as string
      return { ...d, questions: d.questions.filter((x) => x.id !== id) }
    }
    default:
      return d
  }
}

function stateOf(d: ProjectData, s: SessionInfo, errors: Record<string, string>): SessionState {
  const waiting = [...d.permissions, ...d.questions].some((r) => rootOf(d.parents, r.sessionID) === s.id)
  if (waiting) return "attention"
  if (d.busy[s.id]) return "busy"
  if (errors[s.id]) return "error"
  if (isUnread(s)) return "unread"
  return "idle"
}

function subtitle(state: SessionState, s: SessionInfo): string {
  switch (state) {
    case "attention":
      return "espera tu respuesta"
    case "busy":
      return "trabajando…"
    case "error":
      return `falló · ${ago(s.time.updated)}`
    case "unread":
      return `terminó · ${ago(s.time.updated)}`
    default:
      return ago(s.time.updated)
  }
}

function RoutineCard({ routine, onRun }: { routine: Routine; onRun: () => void }) {
  const last = routine.runs[0]
  const running = !!last && !last.finishedAt
  const tone = !last ? "" : running ? "busy" : last.status === "ok" ? "ok" : last.status === "esperando" ? "warn" : "error"
  const [open, setOpen] = useState(false)
  return (
    <div className="card routine">
      <button type="button" className="card-main" onClick={() => setOpen(!open)}>
        <span className={`dot ${tone}`} />
        <span className="card-text">
          <strong>{routine.name}</strong>
          <small>
            {scheduleLabel(routine.schedule)} · {projectName(routine.project)}
            {routine.enabled ? (routine.nextRun ? ` · próxima ${new Date(routine.nextRun).toLocaleString("es-AR", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "") : " · pausada"}
          </small>
        </span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <div className="card-body">
          {last ? (
            <>
              <small className="muted">
                Última: {ago(last.startedAt)} · {running ? "corriendo" : last.status === "ok" ? "terminó bien" : last.status}
              </small>
              {last.error && <div className="alert">{last.error}</div>}
              {last.summary && <Md text={last.summary} />}
            </>
          ) : (
            <small className="muted">Todavía no corrió.</small>
          )}
          <button type="button" className="btn" disabled={running} onClick={onRun}>
            <Icon name="play" /> Correr ahora
          </button>
        </div>
      )}
    </div>
  )
}

export function Home({ open, viewed }: { open: (r: Route) => void; viewed: string | null }) {
  const cache = useRef(readHomeCache())
  const [info, setInfo] = useState<HubInfo | null>(null)
  const [data, setData] = useState<ProjectData[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState<OfflineReason | null>(null)
  const [staleAt, setStaleAt] = useState<number | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [settings, setSettings] = useState(false)
  const [nudgeHidden, setNudgeHidden] = useState(() => pushNudgeDismissed())
  const [, setTick] = useState(0)
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shown = useRef(false)
  const pendingViewed = useRef(viewed)
  const push = usePushStatus()
  const quota = useQuota()
  const onChatgpt = info?.prefs?.model?.providerID === "openai"
  const chatgptQuota = useChatgptQuota(onChatgpt)
  const refreshGoQuota = quota.refreshSoon
  const refreshChatgptQuota = chatgptQuota.refreshSoon
  const refreshQuota = useCallback(() => {
    refreshGoQuota()
    refreshChatgptQuota()
  }, [refreshGoQuota, refreshChatgptQuota])
  const [quotaOpen, setQuotaOpen] = useState(false)

  const showCache = useCallback(() => {
    const cached = cache.current
    if (shown.current || !cached) return
    shown.current = true
    setInfo(cached.info)
    setData(cached.data)
    setStaleAt(cached.at)
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await hub<HubInfo>("GET", "/info")
      const projects = await Promise.all(next.projects.slice(0, MAX_PROJECTS).map(loadProject))
      const all = projects.flatMap((d) => d.sessions)
      ensureSeenBaseline(all)
      if (pendingViewed.current) {
        const id = pendingViewed.current
        pendingViewed.current = null
        markSeen(all.filter((s) => s.id === id))
      }
      shown.current = true
      setInfo(next)
      setData(projects)
      setErrors(next.errors ?? {})
      setError(null)
      setOffline(null)
      setStaleAt(null)
      cacheHome(next, projects)
    } catch (e) {
      if (e instanceof OfflineError) {
        setOffline(e.reason)
        showCache()
        return
      }
      setError(errorText(e))
      if (e instanceof AuthError) setInfo(null)
    }
  }, [showCache])

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => void load(), 400)
  }, [load])

  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (e.type === "resync") return scheduleReload()
      if (e.type === "session.idle") refreshQuota()
      const p = (e.properties ?? {}) as Record<string, unknown>
      if (e.type === "session.error") {
        const err = p.error as { name?: string; data?: { message?: string } } | undefined
        const id = p.sessionID as string | undefined
        if (id && err && err.name !== "MessageAbortedError") setErrors((prev) => ({ ...prev, [id]: err.data?.message ?? err.name ?? "error" }))
        return
      }
      if (e.type === "session.status" && (p.status as { type?: string } | undefined)?.type !== "idle") {
        const id = p.sessionID as string
        setErrors((prev) => {
          if (!prev[id]) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
      setData((prev) => {
        const index = prev.findIndex((d) => samePath(d.project, e.directory))
        if (index < 0) {
          if (e.type === "session.created") scheduleReload()
          return prev
        }
        const next = applyEvent(prev[index], e)
        if (next === prev[index]) return prev
        const copy = prev.slice()
        copy[index] = next
        return copy
      })
    },
    [scheduleReload, refreshQuota],
  )

  const live = useLive(null, onEvent, () => void load())
  usePoll(load, live === "open" ? 60000 : offline ? 10000 : 5000)
  usePoll(async () => setTick((t) => t + 1), 30000)

  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
  }, [])

  useEffect(() => {
    const timer = setTimeout(showCache, 1500)
    return () => clearTimeout(timer)
  }, [showCache])

  const waiting = data.flatMap((d) =>
    d.sessions.filter((s) => [...d.permissions, ...d.questions].some((r) => rootOf(d.parents, r.sessionID) === s.id)).map((s) => ({ project: d.project, session: s })),
  )
  const unread = data.flatMap((d) => d.sessions.filter((s) => stateOf(d, s, errors) === "unread"))

  const openSession = (project: string, s: SessionInfo) => {
    markSeen([s])
    open({ kind: "session", project, id: s.id, title: s.title })
  }

  const createSession = (project: string) => async (draft: Parameters<typeof promptBody>[0]) => {
    const session = await oc<SessionInfo>("POST", "/session", project, {})
    await oc("POST", `/session/${session.id}/prompt_async`, project, promptBody(draft, info?.prefs, info?.prefs?.agent))
    setCreating(null)
    open({ kind: "session", project, id: session.id, title: draft.text.trim().slice(0, 60) || "Sesión nueva" })
  }

  const showNudge = !nudgeHidden && push.status?.kind === "off" && !offline

  return (
    <main className="screen">
      <header className="topbar">
        <img src="/icon-256.png" alt="" className="logo" />
        <h1>GuilleCode</h1>
        <span className="spacer" />
        {live === "down" && !offline && (
          <span className="live-state">
            <Icon name="loading" spin /> reconectando
          </span>
        )}
        {info &&
          (onChatgpt ? (
            <ChatgptQuotaChip quota={chatgptQuota.quota} onOpen={() => setQuotaOpen(true)} />
          ) : (
            <QuotaChip quota={quota.quota} onGo={info.prefs?.model?.providerID === "opencode-go"} onOpen={() => setQuotaOpen(true)} />
          ))}
        <button type="button" className="icon-btn" onClick={() => setSettings(true)} aria-label="Notificaciones">
          <Icon name={push.status?.kind === "on" ? "bell" : "bell-slash"} />
        </button>
      </header>
      {offline && <OfflineBanner reason={offline} cachedAt={staleAt} onRetry={() => void load()} />}
      {error && <div className="alert">{error}</div>}
      {!info && !error && !offline && <div className="loading">Conectando con tu PC…</div>}
      {showNudge && (
        <div className="nudge">
          <Icon name="bell" />
          <div className="offline-text">
            <strong>Enterate sin tener la app abierta</strong>
            <small>Te aviso cuando el agente termina, falla o te necesita.</small>
          </div>
          <div className="row">
            <button type="button" className="btn btn-sm primary" onClick={() => void push.enable()}>
              Activar
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="No mostrar más"
              onClick={() => {
                dismissPushNudge()
                setNudgeHidden(true)
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
      )}
      {waiting.length > 0 && (
        <section>
          <h2 className="section-title warn">
            <Icon name="bell-dot" /> Te necesitan
          </h2>
          {waiting.map(({ project, session }) => (
            <button key={session.id} type="button" className="card attention" onClick={() => openSession(project, session)}>
              <span className="dot attention" />
              <span className="card-text">
                <strong>{session.title || "Sin título"}</strong>
                <small>{projectName(project)} · espera tu respuesta</small>
              </span>
              <Icon name="chevron-right" />
            </button>
          ))}
        </section>
      )}
      {info?.desktop && !offline && <PcCard status={info.desktop} onChange={() => void load()} />}
      {unread.length > 1 && (
        <button type="button" className="link self-end" onClick={() => {
            markSeen(unread)
            setTick((t) => t + 1)
          }}>
          <Icon name="check-all" /> Marcar {unread.length} como vistas
        </button>
      )}
      {data.map((d) => {
        const limit = limits[d.project] ?? FIRST_PAGE
        const hidden = d.sessions.length - limit
        return (
          <section key={d.project}>
            <div className="section-head">
              <h2 className="section-title">{projectName(d.project)}</h2>
              <button type="button" className="link" onClick={() => setCreating(creating === d.project ? null : d.project)}>
                <Icon name={creating === d.project ? "close" : "add"} /> {creating === d.project ? "Cancelar" : "Nueva"}
              </button>
            </div>
            {creating === d.project && (
              <Composer
                directory={d.project}
                placeholder="¿Qué le pedís al agente?"
                initialModel={info?.prefs?.model ?? null}
                favorites={info?.prefs?.favorites ?? []}
                rows={3}
                autoFocus
                voice={info?.voice}
                onSend={createSession(d.project)}
              />
            )}
            {d.sessions.length === 0 && <small className="muted pad">Sin sesiones.</small>}
            {d.sessions.slice(0, limit).map((s) => {
              const state = stateOf(d, s, errors)
              return (
                <button key={s.id} type="button" className={`card state-${state}`} onClick={() => openSession(d.project, s)}>
                  <span className={`dot ${state}`} />
                  <span className="card-text">
                    <strong>{s.title || "Sin título"}</strong>
                    <small>{subtitle(state, s)}</small>
                  </span>
                  <Icon name="chevron-right" />
                </button>
              )
            })}
            {hidden > 0 && (
              <button type="button" className="link more" onClick={() => setLimits((prev) => ({ ...prev, [d.project]: limit + PAGE }))}>
                <Icon name="chevron-down" /> Ver más ({hidden})
              </button>
            )}
          </section>
        )
      })}
      {info && info.routines.length > 0 && (
        <section>
          <h2 className="section-title">
            <Icon name="calendar" /> Rutinas
          </h2>
          {info.routines.map((r) => (
            <RoutineCard
              key={r.id}
              routine={r}
              onRun={() =>
                void hub("POST", `/routines/${r.id}/run`)
                  .then(load)
                  .catch((e) => setError(errorText(e)))
              }
            />
          ))}
        </section>
      )}
      {settings && <NotificationSettings push={push} onClose={() => setSettings(false)} />}
      {quotaOpen && onChatgpt && chatgptQuota.quota && (
        <ChatgptQuotaSheet quota={chatgptQuota.quota} onReload={chatgptQuota.reload} onClose={() => setQuotaOpen(false)} />
      )}
      {quotaOpen && !onChatgpt && quota.quota && <QuotaSheet quota={quota.quota} onReload={quota.reload} onClose={() => setQuotaOpen(false)} />}
    </main>
  )
}
