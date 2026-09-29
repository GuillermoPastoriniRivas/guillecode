import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from "react"
import { authHeader, errorText } from "./api"
import { Icon } from "./ui"
import { ScreenPackets, screenPoint, type InputEvent, type ScreenMeta } from "./screen-protocol"

const MAX_ZOOM = 6

type Gesture =
  | { kind: "pinch"; d0: number; c0: { x: number; y: number }; s0: number; t0: { x: number; y: number }; origin: { x: number; y: number } }
  | { kind: "pan"; p0: { x: number; y: number }; t0: { x: number; y: number } }

async function post(path: string, body: unknown) {
  const res = await fetch(`/hub/desktop/stream/${path}`, { method: "POST", headers: { Authorization: authHeader(), "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000), keepalive: path === "input" })
  const data = await res.json() as { error?: string; text?: string }
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
  return data
}

class InputQueue {
  private queue: InputEvent[] = []
  private running = false
  private closed = false
  private timer: ReturnType<typeof setInterval>
  private id: string
  private failed: (e: unknown) => void
  constructor(id: string, failed: (e: unknown) => void) {
    this.id = id
    this.failed = failed
    this.timer = setInterval(() => { this.add({ t: "hold" }) }, 1000)
  }
  add(event: InputEvent) {
    if (this.closed) return
    if (event.t === "move" && this.queue.at(-1)?.t === "move") this.queue.pop()
    this.queue.push(event)
    if (this.queue.length > 64) { this.failed(new Error("La conexión está lenta; soltá el control y volvé a intentarlo")); this.close(); return }
    void this.flush()
  }
  private async flush() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.closed) {
        const events = this.queue.splice(0, 64)
        await post("input", { id: this.id, events })
      }
    } catch (e) {
      this.failed(e)
      this.closed = true
      clearInterval(this.timer)
    } finally {
      this.running = false
      if (this.closed) void post("input", { id: this.id, release: true }).catch(() => {})
    }
  }
  close() {
    this.closed = true
    this.queue = []
    clearInterval(this.timer)
    // Release only after the last HTTP request: a delayed down must never follow up.
    if (!this.running) void post("input", { id: this.id, release: true }).catch(() => {})
  }
}

export function ScreenView({ target, active = true, controls = true, floating = false }: { target: string | null; active?: boolean; controls?: boolean; floating?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const input = useRef<InputQueue | null>(null)
  const [session, setSession] = useState<string | null>(null)
  const [control, setControl] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [status, setStatus] = useState("Conectando…")
  const [jpeg, setJpeg] = useState(false)
  const [retry, setRetry] = useState(0)
  const [visible, setVisible] = useState(!document.hidden)
  const [text, setText] = useState("")
  const [floatOpen, setFloatOpen] = useState(true)
  const view = useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = useState(16 / 10)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = view.current
    if (!floating || !el) return
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [floating])
  const pointer = useRef<{ id: number; x: number; y: number; b: string } | null>(null)
  const zoom = useRef({ s: 1, tx: 0, ty: 0 })
  const fingers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef(0)
  const tap = useRef<{ x: number; y: number } | null>(null)

  const applyZoom = () => {
    const el = canvas.current
    if (!el) return
    const { s, tx, ty } = zoom.current
    el.style.transform = s === 1 && tx === 0 && ty === 0 ? "" : `translate(${tx}px, ${ty}px) scale(${s})`
  }
  const clampScale = (s: number) => Math.max(1, Math.min(MAX_ZOOM, s))
  const setZoom = (s: number, tx: number, ty: number) => {
    const scale = clampScale(s)
    const el = canvas.current
    const mx = el ? ((scale - 1) * el.offsetWidth) / 2 : 0
    const my = el ? ((scale - 1) * el.offsetHeight) / 2 : 0
    zoom.current = { s: scale, tx: Math.max(-mx, Math.min(mx, tx)), ty: Math.max(-my, Math.min(my, ty)) }
    applyZoom()
  }
  const resetZoom = () => {
    zoom.current = { s: 1, tx: 0, ty: 0 }
    applyZoom()
  }

  useEffect(() => {
    const changed = () => { setVisible(!document.hidden); if (document.hidden) { input.current?.close(); setControl(false) } }
    const blur = () => { input.current?.close(); setControl(false) }
    document.addEventListener("visibilitychange", changed)
    window.addEventListener("blur", blur)
    window.addEventListener("pagehide", blur)
    return () => { document.removeEventListener("visibilitychange", changed); window.removeEventListener("blur", blur); window.removeEventListener("pagehide", blur) }
  }, [])

  useEffect(() => {
    setControl(false)
    setSession(null)
    resetZoom()
    if (!active || !visible) { setStatus("Vista en pausa"); return }
    const abort = new AbortController()
    let decoder: VideoDecoder | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let id: string | null = null
    let ack = 0
    let acking = false
    let lastData = Date.now()
    let failed = false
    const backing = document.createElement("canvas")
    const ctx = backing.getContext("2d")!
    let cursor: { x: number; y: number; visible: boolean; kind: string } | null = null
    const paint = () => {
      const el = canvas.current
      if (abort.signal.aborted || !el || !backing.width) return
      if (el.width !== backing.width) el.width = backing.width
      if (el.height !== backing.height) el.height = backing.height
      const out = el.getContext("2d")!
      out.drawImage(backing, 0, 0)
      if (cursor?.visible) {
        const x = cursor.x * el.width, y = cursor.y * el.height
        out.save(); out.translate(x, y)
        out.beginPath(); out.moveTo(0, 0); out.lineTo(0, 22); out.lineTo(6, 16); out.lineTo(11, 25); out.lineTo(15, 23); out.lineTo(10, 14); out.lineTo(19, 14); out.closePath()
        out.fillStyle = "white"; out.strokeStyle = "black"; out.lineWidth = 2; out.fill(); out.stroke(); out.restore()
      }
    }
    const acknowledge = async () => {
      if (!id || acking || abort.signal.aborted) return
      acking = true
      try { await post("ack", { id, seq: ack }) } catch (e) { fail(e) } finally { acking = false }
    }
    const fail = (e: unknown) => {
      if (abort.signal.aborted || failed) return
      failed = true
      setSession(null); setControl(false); setError(errorText(e)); setStatus("Reconectando…")
      input.current?.close()
      abort.abort()
      if (!jpeg) setJpeg(true)
      else timer = setTimeout(() => setRetry(n => n + 1), 2000)
    }
    const heartbeat = setInterval(() => {
      if (Date.now() - lastData > 8000) fail(new Error("La pantalla dejó de responder"))
      void acknowledge()
    }, 500)
    const run = async () => {
      setError(null); setStatus("Conectando…")
      const video = !jpeg && "VideoDecoder" in window
      const qs = new URLSearchParams({ mode: video ? "h264" : "jpeg", fps: "30", max: "1600" })
      if (target) qs.set("target", target)
      const res = await fetch(`/hub/desktop/stream?${qs}`, { headers: { Authorization: authHeader() }, signal: abort.signal, cache: "no-store" })
      if (!res.ok || !res.body) throw new Error(res.status === 401 ? "El enlace venció: volvé a escanear el QR" : `No se pudo abrir la pantalla (${res.status})`)
      const reader = res.body.getReader()
      const packets = new ScreenPackets()
      const textDecoder = new TextDecoder()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) throw new Error("Se desconectó el visor")
          lastData = Date.now()
          for (const p of packets.push(value)) {
            if (abort.signal.aborted) return
            if (p.kind === 0) {
              const meta = JSON.parse(textDecoder.decode(p.data)) as ScreenMeta
              if (meta.version !== 1 || meta.width < 2 || meta.height < 2 || meta.width > 4096 || meta.height > 4096) throw new Error("Formato de pantalla inválido")
              id = meta.id
              setAspect(meta.width / meta.height)
              backing.width = meta.width; backing.height = meta.height
              if (meta.format === "h264" && meta.codec && !decoder) {
                const config: VideoDecoderConfig = { codec: meta.codec, optimizeForLatency: true }
                // Annex-B: omit description. Providing avcC would select length-prefixed AVCC.
                if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error("Este celular no decodifica el video; usando JPEG")
                if (abort.signal.aborted) return
                decoder = new VideoDecoder({
                  output(frame) {
                    try {
                      if (abort.signal.aborted) return
                      ctx.drawImage(frame, 0, 0, backing.width, backing.height)
                      paint(); ack = Math.max(ack, frame.timestamp); setSession(id); setStatus("Video H.264")
                      void acknowledge()
                    } finally { frame.close() }
                  },
                  error: fail,
                })
                decoder.configure(config)
              }
            } else if (p.kind === 1) {
              const image = await createImageBitmap(new Blob([p.data as BlobPart], { type: "image/jpeg" }))
              try {
                if (abort.signal.aborted) return
                ctx.drawImage(image, 0, 0, backing.width, backing.height); paint()
                ack = p.seq; setSession(id); setStatus("En vivo · JPEG"); void acknowledge()
              } finally { image.close() }
            } else if (p.kind === 2 || p.kind === 3) {
              if (!decoder) throw new Error("El video llegó sin configuración")
              if (decoder.decodeQueueSize > 8) throw new Error("El celular no alcanza a decodificar el video")
              decoder.decode(new EncodedVideoChunk({ type: p.kind === 2 ? "key" : "delta", timestamp: p.seq, data: p.data as AllowSharedBufferSource }))
            } else if (p.kind === 4) { cursor = JSON.parse(textDecoder.decode(p.data)); paint() }
            else if (p.kind === 5) throw new Error((JSON.parse(textDecoder.decode(p.data)) as {error: string}).error)
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    void run().catch(fail)
    return () => {
      abort.abort(); clearInterval(heartbeat); clearTimeout(timer)
      input.current?.close()
      if (decoder && decoder.state !== "closed") decoder.close()
    }
  }, [target, active, visible, jpeg, retry])

  useEffect(() => {
    if (!control || !session || !active || !visible) return
    setInputError(null)
    const queue = new InputQueue(session, e => { setInputError(errorText(e)); setControl(false) })
    input.current = queue
    queue.add({ t: "hold" })
    return () => { queue.close(); if (input.current === queue) input.current = null; pointer.current = null }
  }, [control, session, active, visible])

  useEffect(() => {
    const el = canvas.current
    if (!el || !control) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const pos = screenPoint(e.clientX, e.clientY, el.getBoundingClientRect(), el.width, el.height)
      if (pos) input.current?.add({ t: "wheel", ...pos, dy: -e.deltaY, dx: e.deltaX })
    }
    el.addEventListener("wheel", wheel, { passive: false })
    return () => el.removeEventListener("wheel", wheel)
  }, [control])

  const point = (x: number, y: number) => {
    const el = canvas.current
    return el ? screenPoint(x, y, el.getBoundingClientRect(), el.width, el.height) : null
  }
  // Centro del canvas sin la traslación actual: la escala no mueve el centro.
  const gestureOrigin = (tx: number, ty: number) => {
    const rect = canvas.current?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2 - tx, y: rect.top + rect.height / 2 - ty } : null
  }
  const twoFingers = () => {
    const pts = [...fingers.current.values()]
    return pts.length >= 2 ? ([pts[0], pts[1]] as const) : null
  }
  // Corta un clic en curso para que el mouse de la PC no quede apretado al empezar el pinch.
  const releaseClick = () => {
    const held = pointer.current
    if (!held) return
    pointer.current = null
    input.current?.add({ t: "up", x: held.x, y: held.y, b: held.b })
  }
  const beginPinch = () => {
    const two = twoFingers()
    const origin = gestureOrigin(zoom.current.tx, zoom.current.ty)
    if (!two || !origin) return
    releaseClick()
    tap.current = null
    const [a, b] = two
    gesture.current = {
      kind: "pinch",
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      s0: zoom.current.s,
      t0: { x: zoom.current.tx, y: zoom.current.ty },
      origin,
    }
  }
  const movePinch = () => {
    const g = gesture.current
    const two = twoFingers()
    if (g?.kind !== "pinch" || !two) return
    const [a, b] = two
    const d1 = Math.hypot(a.x - b.x, a.y - b.y) || 1
    const c1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const s1 = clampScale(g.s0 * (d1 / g.d0))
    // Punto de la pantalla que estaba bajo los dedos: se queda bajo los dedos.
    const ux = (g.c0.x - g.origin.x - g.t0.x) / g.s0
    const uy = (g.c0.y - g.origin.y - g.t0.y) / g.s0
    setZoom(s1, c1.x - g.origin.x - s1 * ux, c1.y - g.origin.y - s1 * uy)
  }
  const zoomAt = (x: number, y: number, target: number) => {
    const origin = gestureOrigin(zoom.current.tx, zoom.current.ty)
    if (!origin) return
    const { s: s0, tx: tx0, ty: ty0 } = zoom.current
    const ux = (x - origin.x - tx0) / s0
    const uy = (y - origin.y - ty0) / s0
    setZoom(target, x - origin.x - target * ux, y - origin.y - target * uy)
  }
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer sintético o ya liberado */ }
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (fingers.current.size >= 2) { beginPinch(); return }

    if (control && input.current && !pointer.current) {
      const pos = point(e.clientX, e.clientY)
      if (!pos) return
      e.preventDefault(); e.currentTarget.focus()
      const b = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left"
      pointer.current = { id: e.pointerId, ...pos, b }
      input.current.add({ t: "down", ...pos, b })
      return
    }
    if (control) return
    e.preventDefault()
    tap.current = { x: e.clientX, y: e.clientY }
    if (zoom.current.s > 1) gesture.current = { kind: "pan", p0: { x: e.clientX, y: e.clientY }, t0: { x: zoom.current.tx, y: zoom.current.ty } }
  }
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (tap.current && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > 10) tap.current = null

    if (fingers.current.size >= 2) { movePinch(); return }

    if (pointer.current && pointer.current.id === e.pointerId) {
      if (!control) return
      const pos = point(e.clientX, e.clientY)
      if (!pos) return
      Object.assign(pointer.current, pos)
      input.current?.add({ t: "move", ...pos })
      return
    }
    const g = gesture.current
    if (g?.kind === "pan" && !control) {
      e.preventDefault()
      setZoom(zoom.current.s, g.t0.x + (e.clientX - g.p0.x), g.t0.y + (e.clientY - g.p0.y))
    }
  }
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    fingers.current.delete(e.pointerId)
    if (gesture.current?.kind === "pinch" && fingers.current.size < 2) gesture.current = null
    if (gesture.current?.kind === "pan") gesture.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)

    const tapAt = tap.current
    tap.current = null
    if (tapAt && !control && fingers.current.size === 0) {
      const now = Date.now()
      if (now - lastTap.current < 300) {
        lastTap.current = 0
        if (zoom.current.s > 1) resetZoom()
        else zoomAt(tapAt.x, tapAt.y, 2.5)
      } else {
        lastTap.current = now
      }
    }

    const held = pointer.current
    if (!held || held.id !== e.pointerId) return
    pointer.current = null
    const pos = point(e.clientX, e.clientY) ?? held
    input.current?.add({ t: "up", x: pos.x, y: pos.y, b: held.b })
  }
  const key = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!control || e.nativeEvent.isComposing || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) input.current?.add({ t: "text", s: e.key })
    else {
      const combo = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "win", e.key === " " ? "space" : e.key].filter(Boolean).join("+")
      input.current?.add({ t: "key", k: combo })
    }
  }

  const clipboard = async (action: "read" | "write") => {
    if (!session || !control) return
    try {
      const data = await post("input", {id: session, clipboard: action, text})
      if (action === "read") setText((data.text ?? "").slice(0, 2000))
      setInputError(null)
    } catch (e) { setInputError(errorText(e)) }
  }

  const panel = <>
    <div className="row">
      <button type="button" className={`btn btn-sm${control ? " primary" : ""}`} disabled={!session || !active} onClick={() => setControl(!control)}><Icon name="hand" /> {control ? "Soltar control" : "Controlar"}</button>
      <button type="button" className="btn btn-sm" onClick={() => { setJpeg(!jpeg); setRetry(n => n + 1) }}>{jpeg ? "Probar video" : "Usar JPEG"}</button>
      <small className="muted">{status}</small>
    </div>
    {inputError && <div className="alert">{inputError}</div>}
    {control && <>
      <div className="screen-keys">
        {["Esc", "Tab", "Enter", "Backspace", "Delete", "Ctrl+C", "Ctrl+V", "Alt+Tab", "ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight"].map(k => <button key={k} type="button" className="chip" onClick={() => input.current?.add({t:"key", k})}>{k.replace("ArrowLeft","←").replace("ArrowRight","→").replace("ArrowUp","↑").replace("ArrowDown","↓")}</button>)}
        <button type="button" className="chip" onClick={() => input.current?.add({t:"key", k:"shift+f10"})}>Clic derecho</button>
        <button type="button" className="chip" onClick={() => input.current?.add({t:"wheel", x:0.5,y:0.5,dy:360})}>Subir</button>
        <button type="button" className="chip" onClick={() => input.current?.add({t:"wheel", x:0.5,y:0.5,dy:-360})}>Bajar</button>
      </div>
      <form className="row" onSubmit={e => {e.preventDefault(); if (text) {input.current?.add({t:"text",s:text});setText("")}}}>
        <input aria-label="Texto para escribir en la PC" placeholder="Escribir en la PC…" value={text} maxLength={2000} onChange={e => setText(e.target.value)} />
        <button className="btn btn-sm" type="submit" disabled={!text}>Escribir</button>
      </form>
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={() => void clipboard("read")}>Leer portapapeles de la PC</button>
        <button type="button" className="btn btn-sm" disabled={!text} onClick={() => void clipboard("write")}>Copiar texto a la PC</button>
      </div>
      <small className="muted">Tocá para hacer clic y arrastrá para mover. El texto se pega usando el portapapeles de la PC. Debe estar desbloqueada y el control habilitado.</small>
    </>}
  </>

  // The canvas has its own column, so screenPoint still maps the visible image
  // correctly and the controls can never intercept a tap on the PC.
  const sidebarWidth = floatOpen ? Math.min(220, viewport.width * 0.3) : 44
  const videoWidth = Math.min(viewport.height * aspect, Math.max(0, viewport.width - sidebarWidth))

  return <div ref={view} className={`screen-view${control ? " controlling" : ""}${floating ? " floating" : ""}`}
    style={floating && viewport.width > 0 ? { gridTemplateColumns: `${videoWidth}px minmax(0, 1fr)` } : undefined}>
    <div className="screen-video">
      <canvas ref={canvas} width={0} height={0} aria-label="Pantalla en vivo de la PC" tabIndex={control ? 0 : -1}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onKeyDown={key}
        onContextMenu={e => { if (control) e.preventDefault() }} />
      {error && <div className="screen-error alert">{error}</div>}
      {!session && !error && <div className="screen-error muted">{status}</div>}
    </div>
    {controls && (floating ? (
      <div className={`screen-controls floating${floatOpen ? "" : " collapsed"}`}>
        <button type="button" className="float-head" aria-expanded={floatOpen} onClick={() => setFloatOpen(o => !o)}>
          <Icon name={floatOpen ? "chevron-right" : "chevron-left"} />
          <span>Botones</span>
          {control && <span className="float-tag">controlando</span>}
        </button>
        {floatOpen && <div className="float-body">{panel}</div>}
      </div>
    ) : (
      <div className="screen-controls">{panel}</div>
    ))}
  </div>
}
