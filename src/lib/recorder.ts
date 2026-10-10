import { useCallback, useEffect, useRef, useState } from "react"
import { toWav } from "./audio"

export type RecorderState = { status: "idle" } | { status: "recording"; started: number } | { status: "transcribing" }

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
const DEFAULT_MAX_MS = 10 * 60 * 1000
const MIN_MS = 700

type Active = { media: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: number; started: number }

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
  /** Recibe el audio ya convertido a WAV y devuelve el texto. */
  transcribe: (wav: Blob) => Promise<string>
  onText: (text: string) => void
  onError: (message: string) => void
  unsupportedHint: string
  tooShortHint?: string
  maxMs?: number
}

export function useVoiceRecorder({ transcribe, onText, onError, unsupportedHint, tooShortHint, maxMs = DEFAULT_MAX_MS }: RecorderOptions) {
  const [state, setState] = useState<RecorderState>({ status: "idle" })
  const active = useRef<Active | null>(null)
  const handlers = useRef({ transcribe, onText, onError, unsupportedHint, tooShortHint })
  const stopRef = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => {
    handlers.current = { transcribe, onText, onError, unsupportedHint, tooShortHint }
  })

  useEffect(
    () => () => {
      if (active.current) release(active.current)
      active.current = null
    },
    [],
  )

  const stop = useCallback(async () => {
    const current = active.current
    if (!current) return
    active.current = null
    const blob = await collect(current)
    release(current)
    if (Date.now() - current.started < MIN_MS || blob.size === 0) {
      setState({ status: "idle" })
      handlers.current.onError(handlers.current.tooShortHint ?? "Muy corto: tocá el micrófono para empezar a grabar y otra vez para terminar.")
      return
    }
    setState({ status: "transcribing" })
    try {
      const wav = await toWav(blob)
      const text = await handlers.current.transcribe(wav)
      if (text) handlers.current.onText(text)
      else handlers.current.onError("No se entendió nada en el audio.")
    } catch (e) {
      handlers.current.onError(e instanceof Error ? e.message : String(e))
    } finally {
      setState({ status: "idle" })
    }
  }, [])

  useEffect(() => {
    stopRef.current = stop
  }, [stop])

  const start = useCallback(async () => {
    if (active.current) return
    if (!recordingSupported()) {
      handlers.current.onError(handlers.current.unsupportedHint)
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
      handlers.current.onError(
        denied ? "El navegador no tiene permiso para usar el micrófono: tocá el candado junto a la dirección → Permisos → Micrófono → Permitir." : "No pude abrir el micrófono.",
      )
      return
    }
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
    const media = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined)
    const chunks: Blob[] = []
    media.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    media.start(1000)
    const started = Date.now()
    const timer = window.setTimeout(() => void stopRef.current(), maxMs)
    active.current = { media, stream, chunks, timer, started }
    setState({ status: "recording", started })
  }, [maxMs])

  const cancel = useCallback(() => {
    if (active.current) release(active.current)
    active.current = null
    setState({ status: "idle" })
  }, [])

  return { state, start, stop, cancel }
}
