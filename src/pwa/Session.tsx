import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  OfflineError,
  errorText,
  hub,
  oc,
  projectName,
  type HubInfo,
  type LiveEvent,
  type Message,
  type MessageInfo,
  type OfflineReason,
  type Part,
  type Permission,
  type Question,
  type SessionInfo,
} from "./api"
import { loadMemory, setMemory as setMemoryRemote, type MemoryState } from "./api"
import { Composer, promptBody, type Draft } from "./Composer"
import { pipOpen, ScreenPip, setPipOpen } from "./ScreenPip"
import { QuotaBar, type QuotaBarHandle } from "./Quota"
import type { Route } from "./Home"
import { Icon, Md, OfflineBanner, useLive, usePoll } from "./ui"

const PAGE = 60
const STICK_PX = 160

function promptID(prefix: "msg" | "prt"): string {
  const time = (BigInt(Date.now()) << 12n).toString(16).padStart(12, "0")
  const random = Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => b.toString(16).padStart(2, "0")).join("")
  return `${prefix}_${time}${random}`
}

function byTime(a: Message, b: Message): number {
  return a.info.time.created - b.info.time.created || (a.info.id < b.info.id ? -1 : 1)
}

function upsertMessage(list: Message[], info: MessageInfo): Message[] {
  const index = list.findIndex((m) => m.info.id === info.id)
  if (index < 0) return [...list, { info, parts: [] }].sort(byTime)
  const copy = list.slice()
  copy[index] = { ...copy[index], info }
  return copy
}

function upsertPart(list: Message[], part: Part): Message[] {
  const index = list.findIndex((m) => m.info.id === part.messageID)
  if (index < 0) {
    const info: MessageInfo = { id: part.messageID ?? part.id, sessionID: part.sessionID, role: "assistant", time: { created: Date.now() } }
    return [...list, { info, parts: [part] }].sort(byTime)
  }
  const message = list[index]
  const at = message.parts.findIndex((p) => p.id === part.id)
  const parts = at < 0 ? [...message.parts, part] : message.parts.map((p, i) => (i === at ? part : p))
  const copy = list.slice()
  copy[index] = { ...message, parts }
  return copy
}

function appendDelta(list: Message[], messageID: string, partID: string, field: string, delta: string): Message[] {
  const index = list.findIndex((m) => m.info.id === messageID)
  if (index < 0) return list
  const message = list[index]
  const at = message.parts.findIndex((p) => p.id === partID)
  if (at < 0) return list
  const part = message.parts[at] as Part & Record<string, unknown>
  const next = { ...part, [field]: `${(part[field] as string | undefined) ?? ""}${delta}` }
  const copy = list.slice()
  copy[index] = { ...message, parts: message.parts.map((p, i) => (i === at ? next : p)) }
  return copy
}

const PC_VERBS: Record<string, string> = {
  desktop_status: "Revisó la PC",
  desktop_windows: "Miró las ventanas",
  desktop_snapshot: "Leyó la ventana",
  desktop_click: "Clic",
  desktop_type: "Escribió",
  desktop_select: "Eligió",
  desktop_press_key: "Teclas",
  desktop_read: "Leyó el texto",
  desktop_scroll: "Desplazó",
  desktop_screenshot: "Capturó la pantalla",
  desktop_click_xy: "Clic por coordenadas",
  desktop_focus_window: "Trajo al frente",
  desktop_close_window: "Cerró la ventana",
  desktop_launch: "Abrió",
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function toolLine(part: Part): string {
  const tool = part.tool ?? "herramienta"
  if (tool.startsWith("desktop_") || tool.startsWith("browser_")) {
    const input = part.state?.input ?? {}
    const verb = PC_VERBS[tool] ?? `Chrome · ${tool.slice("browser_".length).replace(/_/g, " ")}`
    const detail = text(input.element) || text(input.app) || text(input.keys) || text(input.url) || text(input.option) || text(input.window)
    return detail ? `${verb} · ${detail.length > 60 ? `${detail.slice(0, 60)}…` : detail}` : verb
  }
  const title = part.state?.title || ""
  return `${tool}${title ? ` · ${title}` : ""}`
}

function toolIcon(part: Part): string {
  const status = part.state?.status
  if (status === "error") return "error"
  if (status !== "completed") return "loading"
  if (part.tool?.startsWith("desktop_")) return "vm"
  if (part.tool?.startsWith("browser_")) return "globe"
  return "check"
}

function Captures({ tools }: { tools: Part[] }) {
  const shots = tools.flatMap((t) => (t.state?.attachments ?? []).filter((a) => a.mime?.startsWith("image/") && a.url?.startsWith("data:"))).slice(-2)
  if (shots.length === 0) return null
  return (
    <div className="files">
      {shots.map((s, i) => (
        <a key={i} href={s.url} target="_blank" rel="noreferrer" className="file-thumb">
          <img src={s.url} alt="Captura que tomó el agente" />
        </a>
      ))}
    </div>
  )
}

function Files({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return null
  return (
    <div className="files">
      {parts.map((p) =>
        p.mime?.startsWith("image/") && p.url?.startsWith("data:") ? (
          <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="file-thumb">
            <img src={p.url} alt={p.filename ?? "imagen"} />
          </a>
        ) : (
          <span key={p.id} className="file-chip">
            <Icon name="file" /> {p.filename ?? "archivo"}
          </span>
        ),
      )}
    </div>
  )
}

function StepRow({ part }: { part: Part }) {
  const running = part.state?.status === "running" || part.state?.status === "pending"
  return (
    <div className={`tool ${part.state?.status ?? ""}`}>
      <Icon name={toolIcon(part)} spin={running} />
      <span>{toolLine(part)}</span>
    </div>
  )
}

function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim() && !active) return null
  return (
    <div className={`reasoning${active ? " active" : ""}`}>
      <button type="button" className="reasoning-toggle" onClick={() => setOpen((o) => !o)}>
        <Icon name="lightbulb" />
        <span>{active ? "Pensando…" : "Razonamiento"}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} />
      </button>
      {open && text.trim() && (
        <div className="reasoning-body">
          <Md text={text} />
        </div>
      )}
    </div>
  )
}

function isStep(p: Part): boolean {
  return p.type === "tool" || p.type === "reasoning"
}

function Steps({ parts, live }: { parts: Part[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const running = parts.some((p) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending"))
  const thinking = live && parts.some((p) => p.type === "reasoning")
  const active = running || thinking
  const lastTool = [...parts].reverse().find((p) => p.type === "tool")
  return (
    <div className={`steps${open ? " open" : ""}${active ? " active" : ""}`}>
      <button type="button" className="steps-head" onClick={() => setOpen((o) => !o)}>
        <Icon name={active ? "loading" : "check-all"} spin={active} />
        <span className="steps-count">{thinking && !running ? "Pensando…" : `${parts.length} paso${parts.length === 1 ? "" : "s"}`}</span>
        {!open && active && lastTool && <span className="steps-peek">{toolLine(lastTool)}</span>}
        <span className="tool-spacer" />
        <span className="tool-chevron">
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </span>
      </button>
      {open && (
        <div className="steps-body">
          {parts.map((p) =>
            p.type === "reasoning" ? (
              <Reasoning key={p.id} text={p.text ?? ""} active={live} />
            ) : (
              <StepRow key={p.id} part={p} />
            ),
          )}
        </div>
      )}
    </div>
  )
}

function renderParts(parts: Part[], live: boolean): ReactNode[] {
  const nodes: ReactNode[] = []
  let group: Part[] = []
  const flush = () => {
    if (group.length === 0) return
    if (group.length === 1 && group[0].type === "tool") nodes.push(<StepRow key={group[0].id} part={group[0]} />)
    else if (group.length === 1) nodes.push(<Reasoning key={group[0].id} text={group[0].text ?? ""} active={live} />)
    else nodes.push(<Steps key={group[0].id} parts={group} live={live} />)
    group = []
  }
  for (const p of parts) {
    if (p.type === "step-start" || p.type === "patch") continue
    if (p.type === "text" && (p.synthetic || !p.text?.trim())) continue
    if (isStep(p)) group.push(p)
    else {
      flush()
      if (p.type === "text" && p.text?.trim()) nodes.push(<div key={p.id} className="msg-text"><Md text={p.text} /></div>)
    }
  }
  flush()
  return nodes
}

function MessageView({ message, live }: { message: Message; live: boolean }) {
  const parts = message.parts
  const text = parts
    .filter((p) => p.type === "text" && !p.synthetic && p.text?.trim())
    .map((p) => p.text!)
    .join("\n\n")
  const files = parts.filter((p) => p.type === "file" && !p.url?.startsWith("file:"))
  if (message.info.role === "user") {
    if ((!text && files.length === 0) || /^#{1,2} Memoria fluws/.test(text)) return null
    return (
      <div className="bubble user">
        <Files parts={files} />
        {text}
      </div>
    )
  }
  const tools = parts.filter((p) => p.type === "tool")
  const error = message.info.error
  return (
    <div className="bubble assistant">
      <div className="msg-parts">{renderParts(parts, live)}</div>
      <Captures tools={tools} />
      <Files parts={files} />
      {error && error.name !== "MessageAbortedError" && <div className="alert">{error.data?.message ?? error.name}</div>}
      {error?.name === "MessageAbortedError" && <small className="muted">Detenido</small>}
    </div>
  )
}

function PermissionCard({ project, request, done }: { project: string; request: Permission; done: () => void }) {
  const [sending, setSending] = useState(false)
  const reply = (r: "once" | "always" | "reject") => {
    setSending(true)
    void oc("POST", `/permission/${request.id}/reply`, project, { reply: r })
      .then(done)
      .finally(() => setSending(false))
  }
  return (
    <div className="card attention column">
      <strong>Pide permiso: {request.permission}</strong>
      {request.patterns.length > 0 && <code className="patterns">{request.patterns.join("\n")}</code>}
      <div className="row">
        <button type="button" className="btn primary" disabled={sending} onClick={() => reply("once")}>
          Permitir
        </button>
        <button type="button" className="btn" disabled={sending} onClick={() => reply("always")}>
          Siempre
        </button>
        <button type="button" className="btn danger" disabled={sending} onClick={() => reply("reject")}>
          Rechazar
        </button>
      </div>
    </div>
  )
}

function QuestionCard({ project, request, done }: { project: string; request: Question; done: () => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []))
  const toggle = (qi: number, label: string, multiple?: boolean) =>
    setAnswers((prev) => prev.map((a, i) => (i !== qi ? a : multiple ? (a.includes(label) ? a.filter((x) => x !== label) : [...a, label]) : [label])))
  const ready = answers.every((a) => a.length > 0)
  return (
    <div className="card attention column">
      {request.questions.map((q, qi) => (
        <div key={qi} className="question">
          <strong>{q.question}</strong>
          <div className="options">
            {q.options.map((o) => (
              <button key={o.label} type="button" className={`option${answers[qi].includes(o.label) ? " on" : ""}`} onClick={() => toggle(qi, o.label, q.multiple)}>
                <span>{o.label}</span>
                {o.description && <small>{o.description}</small>}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="row">
        <button type="button" className="btn primary" disabled={!ready} onClick={() => void oc("POST", `/question/${request.id}/reply`, project, { answers }).then(done)}>
          Responder
        </button>
        <button type="button" className="btn" onClick={() => void oc("POST", `/question/${request.id}/reject`, project).then(done)}>
          Omitir
        </button>
      </div>
    </div>
  )
}

function nearBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - STICK_PX
}

export function SessionScreen({ route, back }: { route: Extract<Route, { kind: "session" }>; back: () => void }) {
  const [title, setTitle] = useState(route.title)
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [children, setChildren] = useState<Set<string>>(() => new Set())
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [info, setInfo] = useState<HubInfo | null>(null)
  const [screen, setScreen] = useState(pipOpen)
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState<OfflineReason | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [unseen, setUnseen] = useState(false)
  const [memory, setMemory] = useState<MemoryState | null>(null)
  const stick = useRef(true)
  const first = useRef(true)
  const quotaBar = useRef<QuotaBarHandle>(null)
  const pending = useRef(new Map<string, Message>())
  const revision = useRef(0)
  const messageRevisions = useRef(new Map<string, number>())
  const statusRevision = useRef(0)
  const loading = useRef(false)
  const reload = useRef(false)

  const mine = useCallback((sessionID: string | undefined) => !!sessionID && (sessionID === route.id || children.has(sessionID)), [children, route.id])

  const load = useCallback(async (): Promise<void> => {
    if (loading.current) {
      reload.current = true
      return
    }
    loading.current = true
    const started = revision.current
    const statusStarted = statusRevision.current
    try {
      const [msgs, status, perms, qs, kids, session] = await Promise.all([
        oc<Message[]>("GET", `/session/${route.id}/message?limit=${PAGE}`, route.project),
        oc<Record<string, { type: string }>>("GET", "/session/status", route.project),
        oc<Permission[]>("GET", "/permission", route.project),
        oc<Question[]>("GET", "/question", route.project),
        oc<SessionInfo[]>("GET", `/session/${route.id}/children`, route.project).catch(() => []),
        oc<SessionInfo>("GET", `/session/${route.id}`, route.project).catch(() => null),
      ])
      const ids = new Set((kids ?? []).map((k) => k.id))
      setChildren(ids)
      const snapshot = msgs ?? []
      const fetched = new Set(snapshot.map((m) => m.info.id))
      for (const id of fetched) pending.current.delete(id)
      // A slow refresh must not erase a newer SSE update or an accepted prompt
      // that prompt_async has not persisted yet.
      setMessages((current) => {
        const latest = new Map(current.map((m) => [m.info.id, m]))
        const changed = (id: string) => (messageRevisions.current.get(id) ?? 0) > started
        return [
          ...snapshot.flatMap((m) => changed(m.info.id) ? (latest.has(m.info.id) ? [latest.get(m.info.id)!] : []) : [m]),
          ...current.filter((m) => !fetched.has(m.info.id) && (changed(m.info.id) || pending.current.has(m.info.id))),
        ].sort(byTime)
      })
      if (statusRevision.current === statusStarted) setBusy(!!status?.[route.id] && status[route.id].type !== "idle")
      setPermissions((perms ?? []).filter((p) => p.sessionID === route.id || ids.has(p.sessionID)))
      setQuestions((qs ?? []).filter((q) => q.sessionID === route.id || ids.has(q.sessionID)))
      if (session?.title) setTitle(session.title)
      setError(null)
      setOffline(null)
      setLoaded(true)
    } catch (e) {
      if (e instanceof OfflineError) setOffline(e.reason)
      else setError(errorText(e))
    } finally {
      loading.current = false
      if (reload.current) {
        reload.current = false
        void load()
      }
    }
  }, [route.id, route.project])

  useEffect(() => {
    hub<HubInfo>("GET", "/info")
      .then(setInfo)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    loadMemory(route.project, route.id)
      .then(setMemory)
      .catch(() => undefined)
  }, [route.project, route.id])

  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (e.type === "resync") return void load()
      const p = (e.properties ?? {}) as Record<string, unknown>
      if (e.type.startsWith("message.")) {
        const msg = p.info as MessageInfo | undefined
        const part = p.part as Part | undefined
        const sessionID = p.sessionID ?? msg?.sessionID ?? part?.sessionID
        const messageID = (p.messageID ?? msg?.id ?? part?.messageID) as string | undefined
        if (sessionID === route.id && messageID) messageRevisions.current.set(messageID, ++revision.current)
      }
      switch (e.type) {
        case "message.updated": {
          const msg = p.info as MessageInfo
          if (msg.sessionID === route.id) setMessages((prev) => upsertMessage(prev, msg))
          break
        }
        case "message.removed":
          if (p.sessionID === route.id) setMessages((prev) => prev.filter((m) => m.info.id !== p.messageID))
          break
        case "message.part.updated": {
          const part = p.part as Part
          if (part.sessionID === route.id) setMessages((prev) => upsertPart(prev, part))
          break
        }
        case "message.part.delta": {
          const d = p as Record<string, string>
          if (d.sessionID === route.id) setMessages((prev) => appendDelta(prev, d.messageID, d.partID, d.field, d.delta))
          break
        }
        case "message.part.removed":
          if (p.sessionID === route.id)
            setMessages((prev) => prev.map((m) => (m.info.id === p.messageID ? { ...m, parts: m.parts.filter((x) => x.id !== p.partID) } : m)))
          break
        case "session.status":
          if (p.sessionID === route.id) {
            statusRevision.current += 1
            setBusy((p.status as { type?: string } | undefined)?.type !== "idle")
          }
          break
        case "session.idle":
          if (p.sessionID === route.id) {
            statusRevision.current += 1
            setBusy(false)
            quotaBar.current?.refreshSoon()
          }
          break
        case "session.created":
        case "session.updated": {
          const s = p.info as SessionInfo
          if (s.parentID === route.id) setChildren((prev) => (prev.has(s.id) ? prev : new Set(prev).add(s.id)))
          if (s.id === route.id && s.title) setTitle(s.title)
          break
        }
        case "permission.asked": {
          const req = p as unknown as Permission
          if (mine(req.sessionID)) setPermissions((prev) => [...prev.filter((x) => x.id !== req.id), req])
          break
        }
        case "permission.replied": {
          const id = (p.requestID ?? p.permissionID) as string
          setPermissions((prev) => prev.filter((x) => x.id !== id))
          break
        }
        case "question.asked": {
          const req = p as unknown as Question
          if (mine(req.sessionID)) setQuestions((prev) => [...prev.filter((x) => x.id !== req.id), req])
          break
        }
        case "question.replied":
        case "question.rejected": {
          const id = p.requestID as string
          setQuestions((prev) => prev.filter((x) => x.id !== id))
          break
        }
      }
    },
    [load, mine, route.id],
  )

  const live = useLive(route.id, onEvent, () => void load())
  // An open hub stream can keep sending heartbeats while its upstream is stuck.
  // Reconcile even then, so the conversation never depends solely on SSE.
  usePoll(load, offline ? 10000 : live === "open" && !busy ? 5000 : 3000)

  useEffect(() => {
    const onScroll = () => {
      stick.current = nearBottom()
      if (stick.current) setUnseen(false)
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  const tail = useMemo(() => {
    const last = messages[messages.length - 1]
    const size = last ? last.parts.reduce((n, p) => n + (p.text?.length ?? 0) + (p.state?.status?.length ?? 0), 0) : 0
    return `${messages.length}:${last?.parts.length ?? 0}:${size}:${permissions.length}:${questions.length}:${busy}`
  }, [messages, permissions.length, questions.length, busy])

  useLayoutEffect(() => {
    if (!loaded) return
    if (first.current) {
      first.current = false
      window.scrollTo({ top: document.documentElement.scrollHeight })
      return
    }
    if (stick.current) window.scrollTo({ top: document.documentElement.scrollHeight })
    else setUnseen(true)
  }, [tail, loaded])

  const toBottom = () => {
    stick.current = true
    setUnseen(false)
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
  }

  const lastUser = [...messages].reverse().find((m) => m.info.role === "user")
  const lastModel = lastUser?.info.model ?? (lastUser?.info.providerID && lastUser.info.modelID ? { providerID: lastUser.info.providerID, modelID: lastUser.info.modelID } : null)
  const initialModel = lastModel ?? info?.prefs?.model ?? null

  const send = async (draft: Draft) => {
    const body = promptBody(draft, info?.prefs, lastUser?.info.agent ?? info?.prefs?.agent)
    const id = promptID("msg")
    const parts = body.parts.map((p) => ({ ...p, id: promptID("prt"), messageID: id, sessionID: route.id })) as Part[]
    const message: Message = { info: { id, sessionID: route.id, role: "user", time: { created: Date.now() }, agent: body.agent, model: draft.model ?? undefined }, parts }
    stick.current = true
    setUnseen(false)
    pending.current.set(id, message)
    messageRevisions.current.set(id, ++revision.current)
    setMessages((prev) => [...prev, message].sort(byTime))
    const statusStarted = statusRevision.current
    try {
      await oc("POST", `/session/${route.id}/prompt_async`, route.project, { ...body, messageID: id, parts })
      if (statusRevision.current === statusStarted) {
        statusRevision.current += 1
        setBusy(true)
      }
      void load()
    } catch (e) {
      pending.current.delete(id)
      messageRevisions.current.set(id, ++revision.current)
      setMessages((prev) => prev.filter((m) => m.info.id !== id))
      throw e
    }
  }

  return (
    <main className="screen session">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={back} aria-label="Volver">
          <Icon name="arrow-left" />
        </button>
        <div className="topbar-title">
          <strong>{title || "Sesión"}</strong>
          <small>
            {projectName(route.project)} · {busy ? "trabajando…" : "en espera"}
          </small>
        </div>
        <QuotaBar ref={quotaBar} provider={initialModel?.providerID ?? ""} />
        <button
          type="button"
          className={`icon-btn${screen ? " active" : ""}`}
          onClick={() => {
            setScreen((on) => {
              setPipOpen(!on)
              return !on
            })
          }}
          aria-label="Ver la pantalla de la PC"
        >
          <Icon name="device-camera" />
        </button>
        {busy && (
          <button type="button" className="icon-btn danger" onClick={() => void oc("POST", `/session/${route.id}/abort`, route.project, {}).then(load)} aria-label="Detener">
            <Icon name="debug-stop" />
          </button>
        )}
      </header>
      {offline && <OfflineBanner reason={offline} cachedAt={null} onRetry={() => void load()} />}
      {error && <div className="alert">{error}</div>}
      {!loaded && !offline && !error && (
        <div className="loading">
          <Icon name="loading" spin /> Cargando…
        </div>
      )}
      <div className="messages">
        {messages.map((m, i) => (
          <MessageView key={m.info.id} message={m} live={busy && i === messages.length - 1} />
        ))}
        {busy && (
          <div className="thinking">
            <Icon name="loading" spin /> trabajando…
          </div>
        )}
        {questions.map((q) => (
          <QuestionCard key={q.id} project={route.project} request={q} done={() => void load()} />
        ))}
        {permissions.map((p) => (
          <PermissionCard key={p.id} project={route.project} request={p} done={() => void load()} />
        ))}
      </div>
      {unseen && (
        <button type="button" className="jump" onClick={toBottom}>
          <Icon name="arrow-down" /> Hay novedades
        </button>
      )}
      <footer className="composer-fixed">
        <Composer
          directory={route.project}
          placeholder={busy ? "Queda en cola hasta que termine" : "Respondele al agente"}
          initialModel={initialModel}
          favorites={info?.prefs?.favorites ?? []}
          zenFreeOnly={info?.prefs?.zenFreeOnly ?? false}
          voice={info?.voice}
          memoryOn={memory?.enabled ?? true}
          onToggleMemory={() => {
            const next = !(memory?.enabled ?? true)
            setMemory((m) => (m ? { ...m, enabled: next } : { enabled: next, scope: "", slug: "", tasks: [] }))
            void setMemoryRemote(route.id, next).catch(() => undefined)
          }}
          onSend={send}
        />
      </footer>
      <ScreenPip
        open={screen}
        onClose={() => {
          setScreen(false)
          setPipOpen(false)
        }}
      />
    </main>
  )
}
