import { useCallback, useEffect, useRef, useState } from "react"
import { toWav } from "./audio"

export type RecorderState = { status: "idle" } | { status: "recording"; started: number } | { status: "transcribing" }

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
const DEFAULT_MAX_MS = 10 * 60 * 1000
const MIN_MS = 700

type Active = { media: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: number; started: number; handlers: RecorderOptions }

function release(active: Active): void {
  window.clearTimeout(active.timer)
  active.media.ondataavailable = null
  active.media.onstop = null
  if (active.media.state !== "inactive") active.media.stop()
  for (const track of active.stream.getTracks()) track.stop()
}

function collect(active: Active): Promise<Blob> {
  const type = active.media.mimeType || "audio/webm"
  if (active.media.state === "inactive") return Promise.resolve(new Blob(active.chunks, { type }))
  return new Promise((resolve) => {
    active.media.onstop = () => resolve(new Blob(active.chunks, { type }))
    active.media.stop()
  })
}

export function recordingSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
}

export type RecorderOptions = {
  key?: string
  /** Recibe el audio ya convertido a WAV y devuelve el texto. */
  transcribe: (wav: Blob) => Promise<string>
  onText: (text: string, transcribedAt: number) => void | Promise<void>
  onError: (message: string) => void
  unsupportedHint: string
  tooShortHint?: string
  maxMs?: number
}

export function useVoiceRecorder({ key, transcribe, onText, onError, unsupportedHint, tooShortHint, maxMs = DEFAULT_MAX_MS }: RecorderOptions) {
  const [state, setState] = useState<RecorderState>({ status: "idle" })
  const active = useRef<Active | null>(null)
  const handlers = useRef<RecorderOptions>({ key, transcribe, onText, onError, unsupportedHint, tooShortHint })
  const processing = useRef<Promise<void> | null>(null)
  const opening = useRef<Promise<void> | null>(null)
  const generation = useRef(0)
  const stopRef = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => {
    handlers.current = { key, transcribe, onText, onError, unsupportedHint, tooShortHint }
  })

  useEffect(
    () => () => {
      // Finish against the handlers captured at recording start, even if the
      // user changed tabs. Never deliver an old dictation to the next session.
      void stopRef.current()
    },
    [],
  )

  const stop = useCallback(async () => {
    await opening.current
    if (processing.current) return processing.current
    const current = active.current
    if (!current) return
    active.current = null
    const token = generation.current
    const captured = current.handlers
    processing.current = (async () => {
      try {
        const blob = await collect(current)
        release(current)
        if (Date.now() - current.started < MIN_MS || blob.size === 0) {
          captured.onError(captured.tooShortHint ?? "Muy corto: tocá el micrófono para empezar a grabar y otra vez para terminar.")
          return
        }
        setState({ status: "transcribing" })
        const wav = await toWav(blob)
        const text = await captured.transcribe(wav)
        if (token !== generation.current) return
        // Preserve edits made during recording in the same composer, but never
        // route a completed dictation to another session after a tab switch.
        const delivery = handlers.current.key === captured.key ? handlers.current : captured
        if (text) await delivery.onText(text, Date.now())
        else captured.onError("No se entendió nada en el audio.")
      } catch (e) {
        if (token === generation.current) captured.onError(e instanceof Error ? e.message : String(e))
      } finally {
        release(current)
        setState({ status: "idle" })
        processing.current = null
      }
    })()
    return processing.current
  }, [])

  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  const start = useCallback(async () => {
    if (active.current || processing.current || opening.current) return
    const captured = handlers.current
    if (!recordingSupported()) {
      handlers.current.onError(handlers.current.unsupportedHint)
      return
    }
    let stream: MediaStream
    const token = generation.current
    let opened!: () => void
    opening.current = new Promise<void>(resolve => { opened = resolve })
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
      captured.onError(
        denied ? "El navegador no tiene permiso para usar el micrófono: tocá el candado junto a la dirección → Permisos → Micrófono → Permitir." : "No pude abrir el micrófono.",
      )
      opening.current = null; opened(); return
    }
    if (token !== generation.current) { stream.getTracks().forEach(track => track.stop()); opening.current = null; opened(); return }
    try {
      const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
      const media = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined)
      const chunks: Blob[] = []
      media.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      media.start(1000)
      const started = Date.now()
      const timer = window.setTimeout(() => void stopRef.current(), maxMs)
      active.current = { media, stream, chunks, timer, started, handlers: captured }
      setState({ status: "recording", started })
    } catch (e) {
      stream.getTracks().forEach(track => track.stop())
      captured.onError(e instanceof Error ? e.message : String(e))
    } finally { opening.current = null; opened() }
  }, [maxMs])

  const cancel = useCallback(() => {
    generation.current++
    if (active.current) release(active.current)
    active.current = null
    setState({ status: "idle" })
  }, [])

  return { state, start, stop, cancel }
}
