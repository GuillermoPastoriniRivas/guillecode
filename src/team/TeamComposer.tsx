import { useRef, useState } from "react"
import { Icon } from "../components/ui"
import { teamCall } from "../state/teams"
import { openImage } from "../state/lightbox"
import { IMAGE_TYPES, readTeamImages } from "./ChatImages"
import type { TeamImageInput } from "./types"
import { BrowserWorkspace } from "../agent/BrowserWorkspace"

export function TeamComposer({ chatId, label, pending, onSent }: { chatId: string; label: string; pending: boolean; onSent: () => void }) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<TeamImageInput[]>([])
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  const adding = useRef(false)
  const submitting = useRef(false)
  const locked = sending || pending || loading
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
  const submit = async () => {
    if (locked || submitting.current || adding.current || (!text.trim() && !images.length)) return
    submitting.current = true
    const message = text.trim(), attached = images
    setSending(true)
    try {
      const id = await teamCall<string>("team_chat_send", { chatId, text: message, images: attached })
      if (id) { setText(previous => previous.trim() === message ? "" : previous); setImages(previous => previous.filter(image => !attached.includes(image))); setError(""); onSent() }
    } finally { submitting.current = false; setSending(false) }
  }
  return <form className="team-composer" onSubmit={e => { e.preventDefault(); void submit() }}
    onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault() }}
    onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)) } }}>
    <label htmlFor={`team-goal-${chatId}`}>{label}</label>
    {images.length > 0 && <div className="team-chat-images team-image-drafts">{images.map((image, i) => <figure key={i}><button type="button" onClick={() => openImage(image.url, image.filename)} title={`Ampliar ${image.filename}`}><img src={image.url} alt={image.filename} /></button><figcaption>{image.filename}</figcaption><button type="button" className="btn btn-xs" disabled={locked} aria-label={`Quitar ${image.filename}`} onClick={() => setImages(previous => previous.filter((_, index) => index !== i))}><Icon name="close" /></button></figure>)}</div>}
    <textarea id={`team-goal-${chatId}`} rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="Hablá con el Lead: pedí un cambio o preguntá qué falló…"
      onPaste={e => { const files = Array.from(e.clipboardData.items).filter(item => item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { e.preventDefault(); void addImages(files) } }}
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }} />
    <input ref={fileInput} type="file" accept={IMAGE_TYPES} multiple hidden aria-label="Imágenes para el equipo" onChange={e => { if (e.target.files) void addImages(Array.from(e.target.files)); e.target.value = "" }} />
    {error && <p className="team-error" role="alert">{error}</p>}
    <BrowserWorkspace sessionId={`team:${chatId}`} shared />
    {pending && <button className="btn btn-sm" type="button" onClick={() => void teamCall("team_chat_cancel", { chatId })}>Detener pedido del Lead</button>}
    <div className="team-composer-actions"><button className="btn btn-sm" type="button" disabled={locked} onClick={() => fileInput.current?.click()}><Icon name="file-media" /> {loading ? "Cargando imágenes…" : "Adjuntar imagen"}</button><button className="btn btn-primary" type="submit" disabled={locked || (!text.trim() && !images.length)}>{sending ? "Enviando…" : "Enviar"}</button></div>
  </form>
}
