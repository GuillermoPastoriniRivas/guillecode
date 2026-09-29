import { useEffect, useMemo, useRef, useState } from "react"
import { errorText, oc, type DesktopPrefs, type ModelRef } from "./api"
import { recentModels, rememberModel } from "./local"
import { useRecorder } from "./recorder"
import { Icon, Sheet } from "./ui"
import { hasAccount, chooseAvailableModel } from "../lib/providers"

export type ModelInfo = { key: string; providerID: string; modelID: string; name: string; provider: string; image: boolean }

export type Attachment = { url: string; mime: string; filename: string }

export type Draft = { text: string; attachments: Attachment[]; model: ModelRef | null }

const MAX_SIDE = 1600
const KEEP_BYTES = 1_500_000
const PICKER_LIMIT = 80

export function loadModels(directory: string): Promise<ModelInfo[]> {
  return oc<{ providers?: Array<{ id: string; name: string; source?: string; options?: { apiKey?: unknown }; models?: Record<string, { id: string; name?: string; capabilities?: { input?: { image?: boolean } } }> }> }>(
    "GET",
    "/config/providers",
    directory,
  )
    .then((res) =>
      (res.providers ?? []).filter(hasAccount).flatMap((p) =>
        Object.values(p.models ?? {}).map((m) => ({
          key: `${p.id}/${m.id}`,
          providerID: p.id,
          modelID: m.id,
          name: m.name ?? m.id,
          provider: p.name,
          image: m.capabilities?.input?.image ?? true,
        })),
      ),
    )
}

export function modelKey(m: ModelRef): string {
  return `${m.providerID}/${m.modelID}`
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("no se pudo leer la imagen"))
    reader.readAsDataURL(file)
  })
}

async function shrink(file: File): Promise<Attachment> {
  const base = file.name.replace(/\.[^.]+$/, "") || "imagen"
  const bitmap = await createImageBitmap(file)
  const side = Math.max(bitmap.width, bitmap.height)
  const keep = side <= MAX_SIDE && file.size <= KEEP_BYTES && /^image\/(png|jpeg|webp|gif)$/.test(file.type)
  if (keep) {
    bitmap.close()
    return { url: await readAsDataUrl(file), mime: file.type, filename: file.name || `${base}.png` }
  }
  const scale = Math.min(1, MAX_SIDE / side)
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no se pudo procesar la imagen")
  ctx.fillStyle = "#fff"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return { url: canvas.toDataURL("image/jpeg", 0.85), mime: "image/jpeg", filename: `${base}.jpg` }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function promptParts(draft: Draft): Array<Record<string, string>> {
  const parts: Array<Record<string, string>> = []
  if (draft.text.trim()) parts.push({ type: "text", text: draft.text.trim() })
  for (const a of draft.attachments) parts.push({ type: "file", mime: a.mime, url: a.url, filename: a.filename })
  return parts
}

export function promptBody(draft: Draft, prefs: DesktopPrefs | null | undefined, agent: string | undefined) {
  const variant = draft.model ? prefs?.variants?.[modelKey(draft.model)] : undefined
  return {
    parts: promptParts(draft),
    ...(draft.model ? { model: draft.model } : {}),
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
  }
}

function ModelPicker({
  models,
  favorites,
  current,
  onPick,
  onClose,
}: {
  models: ModelInfo[] | null
  favorites: string[]
  current: string | null
  onPick: (m: ModelInfo) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const recents = useMemo(() => recentModels(), [])
  const byKey = useMemo(() => new Map((models ?? []).map((m) => [m.key, m])), [models])
  const q = query.trim().toLowerCase()
  const matches = (m: ModelInfo) => !q || `${m.name} ${m.modelID} ${m.provider}`.toLowerCase().includes(q)
  const pick = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((m): m is ModelInfo => !!m && matches(m))
  const favs = pick(favorites)
  const recent = pick(recents.filter((k) => !favorites.includes(k)))
  const shown = new Set([...favs, ...recent].map((m) => m.key))
  const rest = (models ?? []).filter((m) => !shown.has(m.key) && matches(m))

  const row = (m: ModelInfo) => (
    <button key={m.key} type="button" className={`pick${m.key === current ? " on" : ""}`} onClick={() => onPick(m)}>
      <span className="card-text">
        <strong>{m.name}</strong>
        <small>{m.provider}</small>
      </span>
      {m.key === current && <Icon name="check" />}
    </button>
  )

  return (
    <Sheet title="Modelo" onClose={onClose}>
      <input className="search" autoFocus placeholder="Buscar modelo" value={query} onChange={(e) => setQuery(e.target.value)} />
      {!models && (
        <div className="loading">
          <Icon name="loading" spin /> Cargando modelos…
        </div>
      )}
      {favs.length > 0 && (
        <>
          <h3 className="pick-title">
            <Icon name="star-full" /> Favoritos
          </h3>
          {favs.map(row)}
        </>
      )}
      {recent.length > 0 && (
        <>
          <h3 className="pick-title">
            <Icon name="history" /> Recientes
          </h3>
          {recent.map(row)}
        </>
      )}
      {rest.length > 0 && (
        <>
          <h3 className="pick-title">Todos</h3>
          {rest.slice(0, PICKER_LIMIT).map(row)}
          {rest.length > PICKER_LIMIT && <small className="muted pad">Hay {rest.length - PICKER_LIMIT} más: buscá por nombre.</small>}
        </>
      )}
      {models && favs.length + recent.length + rest.length === 0 && <small className="muted pad">No hay modelos con ese nombre.</small>}
    </Sheet>
  )
}

export function Composer({
  directory,
  placeholder,
  initialModel,
  favorites,
  autoFocus,
  rows = 2,
  voice,
  onSend,
}: {
  directory: string
  placeholder: string
  initialModel: ModelRef | null
  favorites: string[]
  autoFocus?: boolean
  rows?: number
  voice?: boolean
  onSend: (draft: Draft) => Promise<void>
}) {
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [picked, setPicked] = useState<ModelRef | null | undefined>(undefined)
  const requestedModel = picked === undefined ? initialModel : picked
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const model = models ? chooseAvailableModel(models, requestedModel ?? { providerID: "", modelID: "" }, favorites) : requestedModel
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const [reading, setReading] = useState<"camera" | "gallery" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const recorder = useRecorder(
    (heard) => {
      setText((prev) => (prev.trim() ? `${prev.trim()} ${heard}` : heard))
      requestAnimationFrame(() => {
        const el = textarea.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    },
    setError,
  )
  const recording = recorder.state.status === "recording" ? recorder.state : null
  const transcribing = recorder.state.status === "transcribing"

  useEffect(() => {
    if (!recording) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [recording])

  const startRecording = () => {
    setError(null)
    if (voice === false) {
      setError("Falta configurar la transcripción en la PC: GuilleCode → «Conectar el celular» → Audios.")
      return
    }
    setNow(Date.now())
    void recorder.start()
  }

  useEffect(() => {
    let alive = true
    const refresh = () => {
      if (document.hidden) return
      void loadModels(directory)
        .then((m) => { if (alive) { setModels(m); setError(null) } })
        .catch((e) => { if (alive) { setModels(null); setError(errorText(e)) } })
    }
    refresh()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    const timer = window.setInterval(refresh, 15000)
    return () => {
      alive = false
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
      window.clearInterval(timer)
    }
  }, [directory])

  const info = model ? models?.find((m) => m.key === modelKey(model)) : undefined
  const label = info?.name || model?.modelID || "Conectá un proveedor"
  const noVision = attachments.length > 0 && info && !info.image
  const ready = !!models?.length && (text.trim().length > 0 || attachments.length > 0) && !sending && !reading && recorder.state.status === "idle"

  const addFiles = async (input: HTMLInputElement, source: "camera" | "gallery") => {
    const files = input.files
    if (!files || files.length === 0) return
    setReading(source)
    setError(null)
    try {
      const next = await Promise.all(Array.from(files).filter((f) => f.type.startsWith("image/")).map(shrink))
      setAttachments((prev) => [...prev, ...next])
    } catch (e) {
      setError(errorText(e))
    } finally {
      setReading(null)
      input.value = ""
    }
  }

  const send = async () => {
    if (!ready) return
    setSending(true)
    setError(null)
    try {
      const fresh = await loadModels(directory)
      setModels(fresh)
      if (fresh.length === 0) throw new Error("Conectá ChatGPT u OpenCode en Cuentas de IA de GuilleCode en la PC.")
      const available = chooseAvailableModel(fresh, model ?? { providerID: "", modelID: "" }, favorites)
      setPicked(available)
      await onSend({ text, attachments, model: available })
      rememberModel(modelKey(available))
      setText("")
      setAttachments([])
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="composer-box">
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a, i) => (
            <div key={`${a.filename}-${i}`} className="attachment">
              <img src={a.url} alt={a.filename} />
              <button type="button" aria-label="Quitar imagen" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
      {noVision && <small className="warn-text">{info?.name} no ve imágenes: elegí otro modelo o la va a ignorar.</small>}
      {error && <div className="alert">{error}</div>}
      {models?.length === 0 && <div className="alert">Conectá ChatGPT u OpenCode en Cuentas de IA de GuilleCode en la PC. Con uno alcanza.</div>}
      <textarea
        ref={textarea}
        value={text}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send()
        }}
      />
      {recording || transcribing ? (
        <div className="composer-bar recording-bar">
          <button type="button" className="chip" onClick={recorder.cancel} disabled={transcribing} aria-label="Descartar audio">
            <Icon name="trash" />
          </button>
          <span className="recording-state">
            {transcribing ? (
              <>
                <Icon name="loading" spin /> Transcribiendo…
              </>
            ) : (
              <>
                <span className="rec-dot" /> Grabando {clock(now - (recording?.started ?? now))}
              </>
            )}
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={() => void recorder.stop()} disabled={transcribing} aria-label="Terminar y transcribir">
            <Icon name={transcribing ? "loading" : "check"} spin={transcribing} />
          </button>
        </div>
      ) : (
        <div className="composer-bar">
          <button type="button" className="chip" onClick={() => cameraInput.current?.click()} disabled={!!reading} aria-label="Sacar una foto">
            <Icon name={reading === "camera" ? "loading" : "device-camera"} spin={reading === "camera"} />
          </button>
          <button type="button" className="chip" onClick={() => galleryInput.current?.click()} disabled={!!reading} aria-label="Elegir de la galería">
            <Icon name={reading === "gallery" ? "loading" : "file-media"} spin={reading === "gallery"} />
          </button>
          <button type="button" className="chip model" onClick={() => setPicking(true)}>
            <Icon name="sparkle" />
            <span>{label}</span>
            <Icon name="chevron-down" />
          </button>
          <span className="spacer" />
          <button type="button" className="chip" onClick={startRecording} disabled={sending} aria-label="Grabar audio">
            <Icon name="mic" />
          </button>
          <button type="button" className="btn primary" disabled={!ready} onClick={() => void send()} aria-label="Enviar">
            <Icon name={sending ? "loading" : "send"} spin={sending} />
          </button>
        </div>
      )}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void addFiles(e.currentTarget, "camera")} />
      <input ref={galleryInput} type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(e.currentTarget, "gallery")} />
      {picking && (
        <ModelPicker
          models={models}
          favorites={favorites}
          current={model ? modelKey(model) : null}
          onClose={() => setPicking(false)}
          onPick={(m) => {
            setPicked({ providerID: m.providerID, modelID: m.modelID })
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
