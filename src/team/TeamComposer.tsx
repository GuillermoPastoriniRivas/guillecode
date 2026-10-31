import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react"
import { Icon } from "../components/ui"
import { teamCall } from "../state/teams"
import { openImage } from "../state/lightbox"
import { CHATGPT } from "../state/accounts"
import { openEditor } from "../state/editors"
import { notify } from "../state/toasts"
import { pickOne } from "../state/quickinput"
import { toggleFavoriteModel, useAgent } from "../state/agent"
import { modelKey } from "../lib/opencode"
import { call, errorMessage } from "../lib/tauri"
import { clock } from "../lib/format"
import { useVoiceRecorder } from "../lib/recorder"
import { desktopTranscribe } from "../lib/transcribe"
import { VoiceSetup } from "../agent/VoiceSetup"
import { IMAGE_TYPES, readTeamImages } from "./ChatImages"
import type { TeamChatRecord, TeamImageInput } from "./types"

export type TeamComposerHandle = { write: (text: string) => void }

const CONNECT_CHATGPT = "__connect_chatgpt__"

export function TeamComposer({ ref, chat, label, pending, onSent, onBrowser }: { ref?: Ref<TeamComposerHandle>; chat: TeamChatRecord; label: string; pending: boolean; onSent: () => void; onBrowser: () => void }) {
  const chatId = chat.id
  const [text, setText] = useState("")
  const [images, setImages] = useState<TeamImageInput[]>([])
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [voiceSetup, setVoiceSetup] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const adding = useRef(false)
  const submitting = useRef(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const textRef = useRef(text)
  const imagesRef = useRef(images)
  const pendingRef = useRef(pending)
  const mounted = useRef(true)
  useEffect(() => { textRef.current = text }, [text])
  useEffect(() => { imagesRef.current = images }, [images])
  useEffect(() => { pendingRef.current = pending }, [pending])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const models = useAgent((s) => s.models)
  const favoriteModels = useAgent((s) => s.favoriteModels)
  const lead = chat.team.members.find((member) => member.id === chat.team.leadAgentId)
  const leadModel = lead ? models.find((model) => modelKey(model) === modelKey(lead.model)) : undefined
  const leadModelName = leadModel?.name ?? lead?.model.modelID ?? "Conectá un proveedor"
  const memoryOn = chat.memory !== false
  const approveOn = chat.autoApprove === true
  useImperativeHandle(ref, () => ({ write(value) { setText(value); textarea.current?.focus() } }))
  const locked = sending || loading
  const addImages = async (files: File[]) => {
    if (locked || adding.current || !files.length) return
    adding.current = true; setLoading(true); setError("")
    try {
      const added = await readTeamImages(files)
      if (images.length + added.length > 5) throw new Error("Podés adjuntar hasta 5 imágenes por mensaje.")
      if ([...images, ...added].reduce((sum, image) => sum + image.url.length, 0) > Math.ceil(20 * 1024 * 1024 * 4 / 3) + 320) throw new Error("Las imágenes pueden sumar hasta 20 MB.")
      setImages(previous => [...previous, ...added])
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo adjuntar la imagen.") }
    finally { adding.current = false; setLoading(false) }
  }
  const submit = async (override?: string) => {
    const message = (override ?? textRef.current).trim()
    const attached = imagesRef.current
    if (submitting.current || adding.current || (!message && !attached.length)) return
    submitting.current = true
    setSending(true)
    try {
      const id = await teamCall<string>("team_chat_send", { chatId, text: message, images: attached })
      if (id) { setText(previous => previous.trim() === message ? "" : previous); setImages(previous => previous.filter(image => !attached.includes(image))); setError(""); onSent() }
    } finally { submitting.current = false; setSending(false) }
  }
  const recorder = useVoiceRecorder({
    key: chatId,
    transcribe: desktopTranscribe,
    onText: async (heard) => {
      const message = [textRef.current.trim(), heard].filter(Boolean).join(" ")
      setText(message)
      if (mounted.current && !pendingRef.current) await submit(message)
    },
    onError: (message) => notify.error("No se pudo transcribir el audio", message),
    unsupportedHint: "Para grabar voz abrí la app de escritorio de Flufy.",
  })
  const toggleVoice = async () => {
    if (recorder.state.status === "recording") { void recorder.stop(); return }
    if (recorder.state.status === "transcribing") return
    try {
      const view = await call<{ ready: boolean }>("voice_get")
      if (!view.ready) { setVoiceSetup(true); return }
    } catch (e) {
      notify.error("No se pudo revisar la configuración de voz", errorMessage(e))
      return
    }
    void recorder.start()
  }
  const recording = recorder.state.status === "recording" ? recorder.state : null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!recording) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [recording])
  const chooseModel = async () => {
    if (!lead || pending) return
    const items = models
      .map((model) => {
        const key = modelKey(model)
        return {
          id: key,
          label: model.name,
          description: `${model.providerName}${model.reasoning ? " · razona" : ""}${model.image ? " · imágenes" : ""}`,
          icon: modelKey(lead.model) === key ? "check" : "circle-small",
          group: model.providerName,
          favorite: favoriteModels.includes(key),
          onToggleFavorite: () => toggleFavoriteModel(key),
        }
      })
      .sort((a, b) => Number(b.favorite) - Number(a.favorite))
    const connectItem = models.some((model) => model.providerID === CHATGPT)
      ? []
      : [{ id: CONNECT_CHATGPT, label: "Conectar ChatGPT…", description: "Usá los modelos de tu suscripción Plus o Pro", icon: "account", group: "Cuentas" }]
    const item = await pickOne([...items, ...connectItem], { title: "Modelo del Lead", placeholder: "Buscar modelo", favorites: true })
    if (!item) return
    if (item.id === CONNECT_CHATGPT) { openEditor({ kind: "accounts" }); return }
    const [providerID, ...rest] = item.id.split("/")
    await teamCall("team_chats_model", { chatId, agentId: lead.id, model: { providerID, modelID: rest.join("/") }, variant: null })
  }
  const saveSettings = (next: { memory?: boolean; autoApprove?: boolean }) => {
    void teamCall("team_chats_settings", {
      chatId,
      memory: next.memory ?? memoryOn,
      autoApprove: next.autoApprove ?? approveOn,
    })
  }
  return <form className="team-composer" onSubmit={e => { e.preventDefault(); void submit() }}
    onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault() }}
    onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)) } }}>
    <div className="team-composer-heading"><label htmlFor={`team-goal-${chatId}`}>{label}</label>{pending && <button className="btn btn-xs" type="button" aria-label="Detener pedido del Lead" title="Detener pedido del Lead" onClick={() => void teamCall("team_chat_cancel", { chatId })}>Detener</button>}</div>
    {images.length > 0 && <div className="team-chat-images team-image-drafts">{images.map((image, i) => <figure key={i}><button type="button" onClick={() => openImage(image.url, image.filename)} title={`Ampliar ${image.filename}`}><img src={image.url} alt={image.filename} /></button><figcaption>{image.filename}</figcaption><button type="button" className="btn btn-xs" disabled={locked} aria-label={`Quitar ${image.filename}`} onClick={() => setImages(previous => previous.filter((_, index) => index !== i))}><Icon name="close" /></button></figure>)}</div>}
    <textarea ref={textarea} id={`team-goal-${chatId}`} rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={pending ? "Podés preguntar quién está bloqueado o qué falló mientras el Lead trabaja…" : "Hablá con el Lead: pedí un cambio o preguntá qué falló…"}
      onPaste={e => { const files = Array.from(e.clipboardData.items).filter(item => item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { e.preventDefault(); void addImages(files) } }}
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }} />
    <input ref={fileInput} type="file" accept={IMAGE_TYPES} multiple hidden aria-label="Imágenes para el equipo" onChange={e => { if (e.target.files) void addImages(Array.from(e.target.files)); e.target.value = "" }} />
    {error && <p className="team-error" role="alert">{error}</p>}
    <div className="team-composer-options">
      <button type="button" className="composer-pill" disabled={pending || !lead} onClick={() => void chooseModel()} title={pending ? "Esperá o detené la respuesta del Lead para cambiar el modelo" : "Elegir modelo del Lead"}>
        <Icon name="sparkle" />
        <span className="composer-pill-text">{leadModelName}</span>
        <Icon name="chevron-down" />
      </button>
      <button type="button" className={`composer-pill approval-pill${approveOn ? " on" : ""}`}
        title={approveOn ? "Aprobación automática ACTIVADA en este chat: el equipo no te pide permiso. Clic para que vuelva a pedirlo." : "El equipo te pide permiso en este chat. Clic para que apruebe solo (no te interrumpe)."}
        onClick={() => saveSettings({ autoApprove: !approveOn })}>
        <Icon name={approveOn ? "pass-filled" : "shield"} />
        <span>{approveOn ? "Aprueba solo" : "Pide permiso"}</span>
      </button>
      <button type="button" className={`composer-pill memory-pill${memoryOn ? " on" : ""}`}
        title={memoryOn ? "Memoria activada: el equipo recuerda el proyecto y este chat. Clic para apagarla." : "Memoria apagada: en este chat no se inyecta ni se guarda memoria."}
        onClick={() => saveSettings({ memory: !memoryOn })}>
        <Icon name="library" />
        <span>{memoryOn ? "Memoria" : "Sin memoria"}</span>
      </button>
    </div>
    {voiceSetup && <VoiceSetup onClose={() => setVoiceSetup(false)} onRecord={recorder.start} />}
    <div className="team-composer-actions">
      <div className="team-composer-tools">
        <button className="btn btn-sm" type="button" onClick={onBrowser}><Icon name="globe" /> Navegador</button>
        <button className="btn btn-sm" type="button" disabled={locked} onClick={() => fileInput.current?.click()}><Icon name="file-media" /> {loading ? "Cargando imágenes…" : "Adjuntar imagen"}</button>
      </div>
      <div className="team-composer-send">
        {recording ? (
          <span className="voice-recording">
            <span className="voice-rec-dot" />
            <span className="voice-rec-time">{clock(now - recording.started)}</span>
            <button type="button" className="composer-icon" title="Descartar audio" onClick={() => recorder.cancel()}>
              <Icon name="trash" />
            </button>
            <button type="button" className="composer-icon voice-stop" title="Terminar y transcribir" onClick={() => void recorder.stop()}>
              <Icon name="check" />
            </button>
          </span>
        ) : (
          <button type="button" className="composer-icon voice-icon"
            title={recorder.state.status === "transcribing" ? "Transcribiendo…" : "Grabar voz"}
            disabled={recorder.state.status === "transcribing"}
            onClick={() => void toggleVoice()}>
            <Icon name={recorder.state.status === "transcribing" ? "loading" : "mic"} spin={recorder.state.status === "transcribing"} />
          </button>
        )}
        <button className="btn btn-primary" type="submit" disabled={locked || (!text.trim() && !images.length)}>{sending ? "Enviando…" : "Enviar"}</button>
      </div>
    </div>
  </form>
}
