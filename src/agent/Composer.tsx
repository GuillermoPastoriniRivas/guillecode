import { useEffect, useMemo, useRef, useState } from "react"
import {
  abortSession,
  addContext,
  currentModelInfo,
  DRAFT_TAB,
  findCommand,
  removeContext,
  selectedVariant,
  sendPrompt,
  setAgentName,
  setMemory,
  setModel,
  setVariant,
  toggleFavoriteModel,
  useAgent,
  variantLabel,
  type ContextItem,
  type ContextUsage,
} from "../state/agent"
import { openEditor, useEditors } from "../state/editors"
import { CHATGPT } from "../state/accounts"
import { useProject } from "../state/project"
import { getFileIndex, useFileIndex } from "../state/fileIndex"
import { pickOne } from "../state/quickinput"
import { notify } from "../state/toasts"
import { rankFuzzy } from "../lib/fuzzy"
import { basename, joinPath, relativePath } from "../lib/paths"
import { modelKey } from "../lib/opencode"
import { formatTokens, percent } from "../lib/format"
import { FileIcon, Highlighted, Icon, Kbd } from "../components/ui"
import { openImage } from "../state/lightbox"

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const CONNECT_CHATGPT = "__connect_chatgpt__"
export const PATH_DRAG_TYPE = "application/x-guillecode-path"

const drafts = new Map<string, string>()

function fileToImage(file: File): Promise<ContextItem | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) return resolve(null)
    const reader = new FileReader()
    reader.onload = () => resolve({ kind: "image", mime: file.type, filename: file.name || "imagen", url: String(reader.result) })
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

type Popover =
  | { kind: "mention"; query: string; start: number }
  | { kind: "command"; query: string }
  | null

function detectPopover(text: string, caret: number): Popover {
  const before = text.slice(0, caret)
  const mention = before.match(/(?:^|\s)@([^\s@]*)$/)
  if (mention) return { kind: "mention", query: mention[1], start: caret - mention[1].length - 1 }
  const command = before.match(/^\/([\w:.-]*)$/)
  if (command) return { kind: "command", query: command[1] }
  return null
}

function contextLabel(item: ContextItem, root: string | null): string {
  if (item.kind === "image") return item.filename
  const rel = root ? relativePath(root, item.path) : item.path
  if (item.kind === "selection") return `${basename(rel)}:${item.startLine}-${item.endLine}`
  return basename(rel)
}

const RING_RADIUS = 6.5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

const CONTEXT_TOKENS_WARN = 250_000

function contextTone(usage: ContextUsage): string {
  if (usage.ratio >= 0.95) return "danger"
  if (usage.ratio >= 0.8 || usage.used >= CONTEXT_TOKENS_WARN) return "warn"
  return ""
}

function ContextRing({ usage }: { usage: ContextUsage }) {
  const filled = Math.min(1, usage.ratio)
  return (
    <span
      className={`context-ring ${contextTone(usage)}`}
      title={`Contexto usado: ${formatTokens(usage.used)} de ${formatTokens(usage.limit)} tokens (${percent(usage.ratio)})${usage.used >= CONTEXT_TOKENS_WARN ? " · pasaste los 250.000 tokens" : ""}`}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <circle className="context-ring-track" cx="8" cy="8" r={RING_RADIUS} />
        <circle
          className="context-ring-fill"
          cx="8"
          cy="8"
          r={RING_RADIUS}
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - filled)}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span>{percent(usage.ratio)}</span>
    </span>
  )
}

export function Composer({
  sessionId,
  busy,
  compact,
  usage,
}: {
  sessionId: string | null
  busy: boolean
  compact?: boolean
  usage?: ContextUsage | null
}) {
  const root = useProject((s) => s.root)
  const context = useAgent((s) => s.context)
  const includeActiveFile = useAgent((s) => s.includeActiveFile)
  const model = useAgent((s) => s.model)
  const models = useAgent((s) => s.models)
  const modelsError = useAgent((s) => s.modelsError)
  const favoriteModels = useAgent((s) => s.favoriteModels)
  const variant = useAgent((s) => selectedVariant(s))
  const modelVariants = useAgent((s) => currentModelInfo(s)?.variants)
  const agentName = useAgent((s) => s.agentName)
  const agents = useAgent((s) => s.agents)
  const commands = useAgent((s) => s.commands)
  const composerFocus = useAgent((s) => s.composerFocus)
  const draft = useAgent((s) => s.draft)
  const memoryOn = useAgent((s) => s.memoryEnabled[sessionId ?? DRAFT_TAB] !== false)
  const files = useFileIndex((s) => s.files)
  const activeFile = useEditors((s) => {
    const g = s.groups.find((x) => x.id === s.activeGroupId)
    const t = g?.tabs.find((x) => x.id === g.activeId)
    return t?.input.kind === "file" ? t.input.path : null
  })
  const [text, setText] = useState(() => drafts.get(sessionId ?? "") ?? "")
  const [popover, setPopover] = useState<Popover>(null)
  const [selected, setSelected] = useState(0)
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const draftKey = sessionId ?? ""

  const [prevSession, setPrevSession] = useState(sessionId)
  if (prevSession !== sessionId) {
    setPrevSession(sessionId)
    setText(drafts.get(sessionId ?? "") ?? "")
    setPopover(null)
  }

  useEffect(() => {
    drafts.set(draftKey, text)
  }, [draftKey, text])

  useEffect(() => {
    if (composerFocus === 0) return
    ref.current?.focus()
  }, [composerFocus])

  useEffect(() => {
    if (!draft) return
    setText(draft.text)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(draft.text.length, draft.text.length)
    })
  }, [draft])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, compact ? 180 : 260)}px`
  }, [text, compact])

  useEffect(() => {
    if (popover?.kind === "mention" && root) void getFileIndex(root)
  }, [popover?.kind, root])

  const suggestions = useMemo(() => {
    if (!popover) return []
    if (popover.kind === "mention") {
      return rankFuzzy(files, popover.query, (f) => f, 8).map(({ item, match }) => ({
        id: item,
        label: basename(item),
        description: item,
        positions: match.positions.filter((p) => p >= item.length - basename(item).length).map((p) => p - (item.length - basename(item).length)),
        file: item,
      }))
    }
    return rankFuzzy(commands, popover.query, (c) => c.name, 10).map(({ item, match }) => ({
      id: item.name,
      label: `/${item.name}`,
      description: item.description ?? "",
      positions: match.positions.map((p) => p + 1),
      file: null as string | null,
    }))
  }, [popover, files, commands])

  const updateText = (value: string, caret: number) => {
    setText(value)
    setPopover(detectPopover(value, caret))
    setSelected(0)
  }

  const applySuggestion = (index: number) => {
    const s = suggestions[index]
    if (!s || !popover) return
    if (popover.kind === "mention" && s.file && root) {
      const caret = ref.current?.selectionStart ?? text.length
      const next = `${text.slice(0, popover.start)}@${s.file} ${text.slice(caret)}`
      setText(next)
      addContext({ kind: "file", path: joinPath(root, s.file) })
      const pos = popover.start + s.file.length + 2
      requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos))
    } else if (popover.kind === "command") {
      setText(`/${s.id} `)
    }
    setPopover(null)
  }

  const submit = async (now = false) => {
    const value = text.trim()
    if (!value && context.length === 0) return
    if (busy && findCommand(value, commands)) {
      notify.info("El agente está trabajando", "Los comandos se mandan cuando termina. Detenelo con Esc si no querés esperar.")
      return
    }
    setSending(true)
    try {
      if (busy && now) await abortSession(sessionId)
      await sendPrompt(value, root, activeFile, sessionId)
      setText("")
      drafts.delete(draftKey)
      setPopover(null)
    } catch (e) {
      notify.error("No se pudo enviar", e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const addImages = async (list: FileList | File[]) => {
    const items = await Promise.all(Array.from(list).map(fileToImage))
    for (const item of items) if (item) addContext(item)
  }

  const chooseModel = async () => {
    const items = models
      .map((m) => {
        const key = modelKey(m)
        return {
          id: key,
          label: m.name,
          description: `${m.providerName}${m.reasoning ? " · razona" : ""}${m.image ? " · imágenes" : ""}`,
          icon: modelKey(model) === key ? "check" : "circle-small",
          group: m.providerName,
          favorite: favoriteModels.includes(key),
          onToggleFavorite: () => toggleFavoriteModel(key),
        }
      })
      .sort((a, b) => Number(b.favorite) - Number(a.favorite))
    const connectItem = models.some((m) => m.providerID === CHATGPT)
      ? []
      : [{ id: CONNECT_CHATGPT, label: "Conectar ChatGPT…", description: "Usá los modelos de tu suscripción Plus o Pro", icon: "account", group: "Cuentas" }]
    const item = await pickOne([...items, ...connectItem], { title: "Modelo del agente", placeholder: "Buscar modelo", favorites: true })
    if (!item) return
    if (item.id === CONNECT_CHATGPT) {
      openEditor({ kind: "accounts" })
      return
    }
    const [providerID, ...rest] = item.id.split("/")
    setModel({ providerID, modelID: rest.join("/") })
  }

  const chooseAgent = async () => {
    if (agents.length === 0) return
    if (agents.length === 2) {
      const other = agents.find((a) => a.name !== agentName)
      if (other) setAgentName(other.name)
      return
    }
    const item = await pickOne(
      agents.map((a) => ({ id: a.name, label: a.name, description: a.description, icon: a.name === agentName ? "check" : "hubot" })),
      { title: "Agente", placeholder: "Elegí el modo del agente" },
    )
    if (item) setAgentName(item.id)
  }

  const chooseVariant = async () => {
    if (!modelVariants?.length) return
    const item = await pickOne(
      [
        { id: "", label: "Automático", description: "Lo que el modelo usa por defecto", icon: variant ? "circle-small" : "check" },
        ...modelVariants.map((v) => ({ id: v, label: variantLabel(v), description: v, icon: v === variant ? "check" : "circle-small" })),
      ],
      { title: "Esfuerzo de razonamiento", placeholder: "Más esfuerzo: respuestas más pensadas, más lentas y más caras" },
    )
    if (item) setVariant(model, item.id || null)
  }

  const modelName = models.find((m) => m.providerID === model.providerID && m.modelID === model.modelID)?.name ?? "Conectá un proveedor"
  const showActive = includeActiveFile && activeFile && !context.some((c) => c.kind !== "image" && c.path === activeFile)

  return (
    <div
      className={`composer${dragging ? " dragging" : ""}${compact ? " compact" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PATH_DRAG_TYPE) || e.dataTransfer.types.includes("Files")) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        setDragging(false)
        const path = e.dataTransfer.getData(PATH_DRAG_TYPE)
        if (path) {
          e.preventDefault()
          addContext({ kind: "file", path })
          return
        }
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          void addImages(e.dataTransfer.files)
        }
      }}
    >
      {popover && suggestions.length > 0 && (
        <div className="composer-popover">
          <div className="composer-popover-title">{popover.kind === "mention" ? "Archivos" : "Comandos"}</div>
          {suggestions.map((s, i) => (
            <div
              key={s.id}
              className={`composer-suggestion${i === selected ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault()
                applySuggestion(i)
              }}
              onMouseEnter={() => setSelected(i)}
            >
              {s.file ? <FileIcon path={s.file} /> : <Icon name="symbol-event" />}
              <span className="composer-suggestion-label">
                <Highlighted text={s.label} positions={s.positions} />
              </span>
              <span className="composer-suggestion-desc">{s.description}</span>
            </div>
          ))}
        </div>
      )}
      {(context.length > 0 || showActive) && (
        <div className="composer-context">
          {showActive && activeFile && (
            <span className="context-chip active-file" title="El archivo abierto en el editor se manda como contexto">
              <FileIcon path={activeFile} />
              <span>{basename(activeFile)}</span>
              <span className="context-chip-tag">activo</span>
              <button type="button" title="No incluir el archivo activo" onClick={() => useAgent.setState({ includeActiveFile: false })}>
                <Icon name="eye-closed" />
              </button>
            </span>
          )}
          {context.map((item, i) => (
            <span key={i} className={`context-chip ${item.kind}`} title={item.kind === "image" ? item.filename : item.path}>
              {item.kind === "image" ? (
                <img src={item.url} alt="" title="Ver imagen" onClick={() => openImage(item.url, item.filename)} />
              ) : item.kind === "selection" ? (
                <Icon name="selection" />
              ) : (
                <FileIcon path={item.path} />
              )}
              <span>{contextLabel(item, root)}</span>
              <button type="button" title="Quitar" onClick={() => removeContext(i)}>
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        rows={1}
        spellCheck={false}
        placeholder={
          busy
            ? "El agente está trabajando… Enter lo deja en cola, Ctrl+Enter lo manda ya"
            : "Pedile algo al agente  ·  @ para archivos  ·  / para comandos"
        }
        onChange={(e) => updateText(e.target.value, e.target.selectionStart)}
        onClick={(e) => setPopover(detectPopover(text, e.currentTarget.selectionStart))}
        onPaste={(e) => {
          const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"))
          if (images.length) {
            e.preventDefault()
            void addImages(images)
          }
        }}
        onKeyDown={(e) => {
          if (popover && suggestions.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setSelected((s) => (s + 1) % suggestions.length)
              return
            }
            if (e.key === "ArrowUp") {
              e.preventDefault()
              setSelected((s) => (s - 1 + suggestions.length) % suggestions.length)
              return
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault()
              applySuggestion(selected)
              return
            }
            if (e.key === "Escape") {
              e.preventDefault()
              setPopover(null)
              return
            }
          }
          if (e.key === "Escape" && busy) {
            e.preventDefault()
            void abortSession(sessionId)
            return
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit(e.ctrlKey || e.metaKey)
          }
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addImages(e.target.files)
          e.target.value = ""
        }}
      />
      <div className="composer-footer">
        <div className="composer-options">
          <button type="button" className="composer-pill agent-pill" onClick={() => void chooseAgent()} title="Modo del agente">
            <Icon name={agentName === "plan" ? "checklist" : "hubot"} />
            <span>{agentName}</span>
          </button>
          <button type="button" className="composer-pill" onClick={() => void chooseModel()} title="Elegir modelo">
            <Icon name="sparkle" />
            <span className="composer-pill-text">{modelName}</span>
            <Icon name="chevron-down" />
          </button>
          {modelVariants && modelVariants.length > 0 && (
            <button
              type="button"
              className={`composer-pill${variant ? " set" : ""}`}
              onClick={() => void chooseVariant()}
              title="Esfuerzo de razonamiento"
            >
              <Icon name="lightbulb" />
              <span>{variantLabel(variant)}</span>
            </button>
          )}
          {!includeActiveFile && (
            <button
              type="button"
              className="composer-icon"
              title="Volver a incluir el archivo activo"
              onClick={() => useAgent.setState({ includeActiveFile: true })}
            >
              <Icon name="eye" />
            </button>
          )}
          <button type="button" className="composer-icon" title="Mencionar archivo (@)" onClick={() => {
            const el = ref.current
            const caret = el?.selectionStart ?? text.length
            const next = `${text.slice(0, caret)}${caret > 0 && !/\s$/.test(text.slice(0, caret)) ? " " : ""}@${text.slice(caret)}`
            updateText(next, next.length - text.slice(caret).length)
            el?.focus()
          }}>
            <Icon name="mention" />
          </button>
          <button type="button" className="composer-icon" title="Adjuntar imagen" onClick={() => fileInput.current?.click()}>
            <Icon name="attach" />
          </button>
          <button
            type="button"
            className={`composer-pill memory-pill${memoryOn ? " on" : ""}`}
            title={memoryOn ? "Memoria activada: el agente recuerda el proyecto y esta conversación. Clic para apagarla." : "Memoria apagada: en esta conversación no se inyecta ni se guarda memoria."}
            onClick={() => setMemory(sessionId ?? DRAFT_TAB, !memoryOn)}
          >
            <Icon name="library" />
            <span>{memoryOn ? "Memoria" : "Sin memoria"}</span>
          </button>
        </div>
        <div className="composer-actions">
          {usage && <ContextRing usage={usage} />}
          {!compact && (
            <span className="composer-hint">
              {busy ? (
                <>
                  <Kbd>Enter</Kbd> en cola · <Kbd>Ctrl+Enter</Kbd> enviar ya · <Kbd>Esc</Kbd> detener
                </>
              ) : (
                <>
                  <Kbd>Enter</Kbd> enviar · <Kbd>Shift+Enter</Kbd> línea
                </>
              )}
            </span>
          )}
          {busy && (
            <button type="button" className="composer-send stop" title="Detener (Esc)" onClick={() => void abortSession(sessionId)}>
              <Icon name="debug-stop" />
            </button>
          )}
          {(!busy || text.trim() || context.length > 0) && (
            <button
              type="button"
              className={`composer-send${busy ? " queue" : ""}`}
              title={busy ? "Dejar en cola (Enter) · Ctrl+Enter para enviarlo ya" : "Enviar (Enter)"}
              disabled={sending || !!modelsError || !models.some((m) => m.providerID === model.providerID && m.modelID === model.modelID) || (!text.trim() && context.length === 0)}
              onClick={(e) => void submit(e.ctrlKey || e.metaKey)}
            >
              <Icon name={sending ? "loading" : busy ? "list-ordered" : "send"} spin={sending} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
