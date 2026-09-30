import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Part, Session } from "@opencode-ai/sdk"
import { Markdown } from "./Markdown"
import { ToolCard } from "./ToolCard"
import { summarize, type ToolState } from "./toolSummary"
import { Icon, Spinner } from "../components/ui"
import { openImage } from "../state/lightbox"
import { openContextMenu } from "../components/ContextMenu"
import {
  focusComposer,
  forkSession,
  loadOlderMessages,
  queuedUserIds,
  retryMessage,
  revertToMessage,
  runningAssistantId,
  unrevertSession,
  useAgent,
  type ChatMessage,
} from "../state/agent"
import { openFile } from "../state/editors"
import { useProject } from "../state/project"
import { notify } from "../state/toasts"
import { clockTime } from "../lib/time"
import { normalizePath, relativePath, resolvePath } from "../lib/paths"

function isContextMessage(m: ChatMessage): boolean {
  if (m.info.role !== "user") return false
  const texts = m.parts.filter((p) => p.type === "text")
  if (texts.length === 0) return false
  return texts.every((p) => p.synthetic === true || /^#{1,2} Memoria fluws/.test(p.text))
}

function visibleUserText(m: ChatMessage): string {
  return m.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n\n")
}

function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim() && !active) return null
  return (
    <div className={`reasoning${active ? " active" : ""}`}>
      <button type="button" className="reasoning-toggle" onClick={() => setOpen(!open)}>
        <Icon name="lightbulb" />
        <span>{active ? "Pensando…" : "Razonamiento"}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} />
      </button>
      {open && (
        <div className="reasoning-body">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

type ToolPart = Extract<Part, { type: "tool" }>
type ReasoningPart = Extract<Part, { type: "reasoning" }>
type StepPart = ToolPart | ReasoningPart

const isStep = (p: Part): p is StepPart => p.type === "tool" || p.type === "reasoning"

function StepBody({ part, live }: { part: StepPart; live: boolean }) {
  return part.type === "tool" ? (
    <ToolCard part={part} />
  ) : (
    <Reasoning text={part.text} active={live && !part.time?.end} />
  )
}

function Steps({ parts, live }: { parts: StepPart[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const running = parts.some((p) => p.type === "tool" && (p.state.status === "running" || p.state.status === "pending"))
  const thinking = live && parts.some((p) => p.type === "reasoning" && !p.time?.end)
  const active = running || thinking
  const lastTool = [...parts].reverse().find((p): p is ToolPart => p.type === "tool")
  const peek = !open && active && lastTool ? summarize(lastTool.tool, lastTool.state as unknown as ToolState) : null
  return (
    <div className={`steps${open ? " open" : ""}${active ? " active" : ""}`}>
      <button type="button" className="steps-head" onClick={() => setOpen((o) => !o)}>
        {active ? <Spinner size={12} /> : <Icon name="check-all" />}
        <span className="steps-count">{thinking && !running ? "Pensando…" : `${parts.length} paso${parts.length === 1 ? "" : "s"}`}</span>
        {peek && <span className="steps-peek">{peek.verb}</span>}
        <span className="tool-spacer" />
        <Icon name={open ? "chevron-down" : "chevron-right"} className="tool-chevron" />
      </button>
      {open && (
        <div className="steps-body">
          {parts.map((p) => (
            <StepBody key={p.id} part={p} live={live} />
          ))}
        </div>
      )}
    </div>
  )
}

function renderParts(parts: Part[], live: boolean): ReactNode[] {
  const nodes: ReactNode[] = []
  let group: StepPart[] = []
  const flush = () => {
    if (group.length === 0) return
    if (group.length === 1) nodes.push(<StepBody key={group[0].id} part={group[0]} live={live} />)
    else nodes.push(<Steps key={group[0].id} parts={group} live={live} />)
    group = []
  }
  for (const p of parts) {
    if (p.type === "step-start" || p.type === "patch") continue
    if (p.type === "text" && (p.synthetic || !p.text.trim())) continue
    if (isStep(p)) group.push(p)
    else {
      flush()
      nodes.push(<PartView key={p.id} part={p} live={live} />)
    }
  }
  flush()
  return nodes
}

function FileChip({ part }: { part: Extract<Part, { type: "file" }> }) {
  const root = useProject((s) => s.root)
  if (part.mime.startsWith("image/") && part.url.startsWith("data:")) {
    return (
      <img
        className="msg-image"
        src={part.url}
        alt={part.filename ?? "imagen"}
        title="Ver imagen"
        onClick={() => openImage(part.url, part.filename ?? "imagen")}
      />
    )
  }
  const path = part.url.startsWith("file://") ? normalizePath(part.url) : null
  const label = part.filename || (path && root ? relativePath(root, path) : part.url)
  return (
    <button
      type="button"
      className="context-chip in-message"
      title={path ?? part.url}
      onClick={() => path && root && openFile(resolvePath(root, path))}
    >
      <Icon name="file" /> {label}
    </button>
  )
}

const PartView = memo(function PartView({ part, live }: { part: Part; live: boolean }) {
  switch (part.type) {
    case "text":
      if (part.synthetic || !part.text.trim()) return null
      return (
        <div className="msg-text">
          <Markdown text={part.text} />
          {live && part.time && !part.time.end && <span className="stream-cursor" />}
        </div>
      )
    case "reasoning":
      return <Reasoning text={part.text} active={live && !part.time?.end} />
    case "tool":
      return <ToolCard part={part} />
    case "file":
      return <FileChip part={part} />
    case "patch":
      return null
    default:
      return null
  }
})

function AssistantFooter({ message, onRetry, retrying }: { message: ChatMessage; onRetry?: () => void; retrying?: boolean }) {
  const info = message.info
  if (info.role !== "assistant") return null
  const tokens = info.tokens
  const total = tokens ? tokens.input + tokens.output + (tokens.reasoning ?? 0) : 0
  const secs = info.time.completed ? ((info.time.completed - info.time.created) / 1000).toFixed(1) : null
  const error = info.error as { name?: string; data?: { message?: string } } | undefined
  return (
    <>
      {error && error.name !== "MessageAbortedError" && (
        <div className="msg-error">
          <Icon name="error" /> {error.data?.message ?? error.name}
        </div>
      )}
      {error?.name === "MessageAbortedError" && (
        <div className="msg-aborted">
          <Icon name="debug-stop" />
          <span>Detenido</span>
          {onRetry && (
            <button type="button" className="msg-retry" onClick={onRetry} disabled={retrying}>
              <Icon name={retrying ? "loading" : "refresh"} spin={retrying} /> Reintentar
            </button>
          )}
        </div>
      )}
      {info.time.completed && (
        <div className="msg-footer">
          <span>{info.modelID}</span>
          {secs && <span>{secs} s</span>}
          {total > 0 && <span>{total.toLocaleString("es-AR")} tokens</span>}
          {info.cost > 0 && <span>US$ {info.cost.toFixed(4)}</span>}
        </div>
      )}
    </>
  )
}

function ContextBlock({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const text = message.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
  const title = text.match(/^#{1,2} ([^\n]+)/m)?.[1]?.trim() ?? "Contexto inyectado"
  return (
    <div className="msg-context">
      <button type="button" className="msg-context-chip" onClick={() => setOpen(!open)}>
        <Icon name="library" /> {title} <Icon name={open ? "chevron-down" : "chevron-right"} />
      </button>
      {open && (
        <div className="msg-context-body">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

function copyUserMessage(message: ChatMessage) {
  const text = visibleUserText(message)
  if (!text) return
  void navigator.clipboard.writeText(text).then(() => notify.success("Mensaje copiado"))
}

function userMenu(session: Session, message: ChatMessage, e: React.MouseEvent) {
  const text = visibleUserText(message)
  openContextMenu(e, [
    { label: "Copiar mensaje", icon: "copy", run: () => void navigator.clipboard.writeText(text) },
    { label: "Editar y reenviar", icon: "edit", run: () => focusComposer(text) },
    { separator: true },
    {
      label: "Deshacer desde acá (revertir cambios)",
      icon: "discard",
      run: () =>
        void revertToMessage(session.id, message.info.id)
          .then(() => notify.success("Sesión revertida a este mensaje", "Los archivos volvieron al estado anterior"))
          .catch((err) => notify.error("No se pudo revertir", String(err))),
    },
    {
      label: "Bifurcar sesión desde acá",
      icon: "git-branch",
      run: () => void forkSession(session.id, message.info.id).catch((err) => notify.error("No se pudo bifurcar", String(err))),
    },
  ])
}

export function Chat({ session, busy }: { session: Session; busy: boolean }) {
  const view = useAgent((s) => s.views[session.id])
  const messages = useMemo(() => view?.messages ?? [], [view])
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const restore = useRef<number | null>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const pinSentinel = useRef<HTMLDivElement | null>(null)
  const [stuck, setStuck] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const revert = (session as Session & { revert?: { messageID: string } }).revert

  const userById = useMemo(() => {
    const map = new Map<string, ChatMessage>()
    for (const m of messages) if (m.info.role === "user") map.set(m.info.id, m)
    return map
  }, [messages])

  const retry = (message: ChatMessage) => {
    if (message.info.role !== "assistant" || retrying) return
    const parent = userById.get(message.info.parentID)
    if (!parent) return
    setRetrying(message.info.id)
    retryMessage(session.id, parent)
      .catch((err) => notify.error("No se pudo reintentar", err instanceof Error ? err.message : String(err)))
      .finally(() => setRetrying(null))
  }

  const revertIndex = revert ? messages.findIndex((m) => m.info.id === revert.messageID) : -1
  const runningId = useMemo(() => runningAssistantId(messages, busy), [messages, busy])
  const queued = useMemo(() => queuedUserIds(messages, busy), [messages, busy])

  const lastUser = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.info.role === "user" && !isContextMessage(m)) return m
    }
    return null
  }, [messages])
  const lastUserId = lastUser?.info.id ?? null

  useEffect(() => {
    const sentinel = pinSentinel.current
    const root = scrollRef.current
    if (!sentinel || !root) {
      setStuck(false)
      return
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.rootBounds) return
        setStuck(entry.boundingClientRect.top <= entry.rootBounds.top)
      },
      { root, threshold: 0 },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [lastUserId, view?.loading])

  useEffect(() => {
    stick.current = true
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [session.id])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restore.current !== null) {
      el.scrollTop = el.scrollHeight - restore.current
      restore.current = null
      return
    }
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener("scroll", onScroll)
    }
  }, [])

  useEffect(() => {
    const sentinel = topRef.current
    const root = scrollRef.current
    if (!sentinel || !root || !view?.hasMore) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        restore.current = root.scrollHeight - root.scrollTop
        void loadOlderMessages(session.id)
      },
      { root, threshold: 0 },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [session.id, view?.hasMore])

  if (!view || (view.loading && messages.length === 0)) {
    return (
      <div className="chat-scroll">
        <div className="chat-loading">
          <Spinner size={18} />
        </div>
      </div>
    )
  }

  const lastIndex = messages.length - 1
  return (
    <div className="chat-scroll" ref={scrollRef}>
      {lastUser && stuck && (
        <div className="pin-overlay" aria-hidden>
          <div className="msg msg-user" onContextMenu={(e) => userMenu(session, lastUser, e)}>
            <div className="msg-user-bubble">
              <div className="msg-parts">
                {lastUser.parts.map((p) => (
                  <PartView key={p.id} part={p} live={false} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="chat-messages" ref={contentRef}>
        <div ref={topRef} className="chat-top-sentinel">
          {view.hasMore && <span>cargando historia…</span>}
        </div>
        {messages.length === 0 && !busy && (
          <div className="chat-empty">
            <Icon name="sparkle" />
            <span>Escribí abajo para arrancar. Podés adjuntar archivos con @ y selecciones con Ctrl+L.</span>
          </div>
        )}
        {messages.map((m, i) => {
          if (isContextMessage(m)) return <ContextBlock key={m.info.id} message={m} />
          const reverted = revertIndex !== -1 && i >= revertIndex
          const isUser = m.info.role === "user"
          const isQueued = queued.has(m.info.id)
          const live = runningId ? m.info.id === runningId : i === lastIndex && busy
          return (
            <Fragment key={m.info.id}>
              {isUser && m.info.id === lastUserId && <div ref={pinSentinel} className="pin-sentinel" />}
              {revertIndex === i && (
                <div className="revert-banner">
                  <Icon name="discard" />
                  <span>Desde acá la sesión está revertida: los cambios se deshicieron.</span>
                  <button type="button" className="btn btn-xs" onClick={() => void unrevertSession(session.id)}>
                    Rehacer
                  </button>
                </div>
              )}
              <div
                className={`msg msg-${m.info.role}${reverted ? " reverted" : ""}${isQueued ? " queued" : ""}${isUser && m.info.id === lastUserId && stuck ? " pin-hidden" : ""}`}
                onContextMenu={isUser ? (e) => userMenu(session, m, e) : undefined}
              >
                {isUser ? (
                  <div className="msg-user-bubble">
                    <div className="msg-parts">
                      {m.parts.map((p) => (
                        <PartView key={p.id} part={p} live={false} />
                      ))}
                    </div>
                    <div className="msg-user-meta">
                      {isQueued && (
                        <span className="msg-queued" title="Se manda cuando el agente termine lo que está haciendo">
                          <Icon name="list-ordered" /> en cola
                        </span>
                      )}
                      <span>{clockTime(m.info.time.created)}</span>
                      <button
                        type="button"
                        className="msg-action msg-copy"
                        title="Copiar mensaje"
                        onClick={() => void copyUserMessage(m)}
                      >
                        <Icon name="copy" />
                      </button>
                      <button type="button" className="msg-action" title="Acciones" onClick={(e) => userMenu(session, m, e)}>
                        <Icon name="kebab-vertical" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="msg-assistant-body">
                    <div className="msg-parts">
                      {renderParts(m.parts, live)}
                      {live && m.parts.every((p) => p.type === "step-start") && (
                        <div className="thinking">
                          <span />
                          <span />
                          <span />
                        </div>
                      )}
                    </div>
                    <AssistantFooter
                      message={m}
                      onRetry={!busy && m.info.role === "assistant" && userById.has(m.info.parentID) ? () => retry(m) : undefined}
                      retrying={retrying === m.info.id}
                    />
                  </div>
                )}
              </div>
            </Fragment>
          )
        })}
        {busy && !runningId && messages[lastIndex]?.info.role === "user" && (
          <div className="msg msg-assistant">
            <div className="thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
