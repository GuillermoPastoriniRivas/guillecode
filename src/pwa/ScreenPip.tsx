import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { hub, type PcActivity, type PcStatus, type PcWindow } from "./api"
import { Icon, Sheet, usePoll } from "./ui"
import { ScreenView } from "./ScreenView"
import { ScreenSheet } from "./Pc"

const GEO_KEY = "guillecode.pwa.pip"
const OPEN_KEY = "guillecode.pwa.pip.open"
const INFO_MS = 5000
const FOLLOW_MS = 120000
const HEAD_H = 34

type Mode = "follow" | "screen" | (string & {})
type Geom = { x: number; y: number; w: number; h: number; mode: Mode; live: boolean }

export function pipOpen(): boolean {
  return localStorage.getItem(OPEN_KEY) === "1"
}

export function setPipOpen(open: boolean) {
  localStorage.setItem(OPEN_KEY, open ? "1" : "0")
}

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback)
const norm = (s: string) => s.trim().toLowerCase()

function defaults(): Geom {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.round(Math.min(300, Math.max(190, vw * 0.64)))
  const h = Math.round(Math.min(250, Math.max(150, vh * 0.3)))
  return { x: Math.max(8, vw - w - 10), y: Math.round(vh * 0.14), w, h, mode: "follow", live: true }
}

function loadGeom(): Geom {
  const d = defaults()
  try {
    const raw = localStorage.getItem(GEO_KEY)
    if (!raw) return d
    const p = JSON.parse(raw) as Partial<Geom>
    return { x: num(p.x, d.x), y: num(p.y, d.y), w: num(p.w, d.w), h: num(p.h, d.h), mode: typeof p.mode === "string" ? p.mode : "follow", live: p.live !== false }
  } catch {
    return d
  }
}

// El agente registra cada acción con la ventana al final («... · Bloc de notas»)
// o entre comillas («miró "Bloc de notas"»). Con eso deducimos qué ventana mirar.
function titleOfSummary(summary: string): string {
  const quoted = summary.match(/«([^»]+)»/)
  if (quoted) return quoted[1].trim()
  const i = summary.lastIndexOf(" · ")
  return i >= 0 ? summary.slice(i + 3).trim() : ""
}

function pickFollow(activity: PcActivity[], windows: PcWindow[]): string | null {
  const usable = windows.filter((w) => !w.minimized && !w.blocked)
  const recent = activity.find((a) => a.tool !== "stop" && Date.now() - a.at < FOLLOW_MS)
  if (!recent) return null
  const title = norm(titleOfSummary(recent.summary))
  if (title) {
    const exact = usable.find((w) => norm(w.title) === title)
    if (exact) return exact.id
    const partial = usable.find((w) => {
      const t = norm(w.title)
      return !!t && (t.includes(title) || title.includes(t))
    })
    if (partial) return partial.id
    const process = usable.find((w) => norm(w.process).replace(/\.exe$/, "") === title)
    if (process) return process.id
  }
  // El navegador (browser_*) no dice la ventana en el resumen: seguimos la que está al frente.
  return usable.find((w) => w.foreground)?.id ?? null
}

export function ScreenPip({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [geom, setGeom] = useState<Geom>(loadGeom)
  const [windows, setWindows] = useState<PcWindow[]>([])
  const [activity, setActivity] = useState<PcActivity[]>([])
  const [expanded, setExpanded] = useState(false)
  const [picking, setPicking] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [lastFollow, setLastFollow] = useState<string | null>(null)
  const geomRef = useRef(geom)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const resize = useRef<{ x: number; y: number; x0: number; y0: number; w: number; h: number } | null>(null)

  useEffect(() => {
    geomRef.current = geom
  }, [geom])

  const put = useCallback((patch: Partial<Geom>, persist = true) => {
    setGeom((g) => {
      const next = { ...g, ...patch }
      geomRef.current = next
      if (persist) localStorage.setItem(GEO_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const loadInfo = useCallback(async () => {
    try {
      const [status, list] = await Promise.all([hub<PcStatus>("GET", "/desktop"), hub<PcWindow[]>("GET", "/desktop/windows")])
      const nextActivity = status?.activity ?? []
      const nextWindows = (list ?? []).filter((w) => !w.minimized && !w.blocked)
      setActivity(nextActivity)
      setWindows(nextWindows)
      const fresh = pickFollow(nextActivity, nextWindows)
      if (fresh) setLastFollow(fresh)
    } catch {
      // sin conexión: dejamos lo último que había
    }
  }, [])

  usePoll(loadInfo, open ? INFO_MS : null)
  useEffect(() => {
    if (open) void loadInfo()
  }, [open, loadInfo])

  const follow = windows.some((w) => w.id === lastFollow) ? lastFollow : pickFollow(activity, windows)

  const target = geom.mode === "screen" ? null : geom.mode === "follow" ? follow : geom.mode
  const label =
    geom.mode === "screen"
      ? "Toda la pantalla"
      : geom.mode === "follow"
        ? (windows.find((w) => w.id === follow)?.title ?? "Sigue al agente")
        : (windows.find((w) => w.id === geom.mode)?.title ?? "Ventana")

  useEffect(() => {
    const fit = () => {
      const g = geomRef.current
      put({ x: Math.min(Math.max(4, g.x), Math.max(4, window.innerWidth - g.w - 4)), y: Math.min(Math.max(4, g.y), Math.max(4, window.innerHeight - HEAD_H - 4)) }, false)
    }
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [put])

  const onDragDown = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button")) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { dx: e.clientX - geomRef.current.x, dy: e.clientY - geomRef.current.y }
  }

  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const g = geomRef.current
    put({ x: Math.min(Math.max(4, e.clientX - d.dx), Math.max(4, window.innerWidth - g.w - 4)), y: Math.min(Math.max(4, e.clientY - d.dy), Math.max(4, window.innerHeight - HEAD_H - 4)) }, false)
  }

  const onDragUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    localStorage.setItem(GEO_KEY, JSON.stringify(geomRef.current))
  }

  const onResizeDown = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resize.current = { x: e.clientX, y: e.clientY, x0: geomRef.current.x, y0: geomRef.current.y, w: geomRef.current.w, h: geomRef.current.h }
  }

  const onResizeMove = (e: ReactPointerEvent<HTMLElement>) => {
    const r = resize.current
    if (!r) return
    const w = Math.min(Math.max(160, r.w + (e.clientX - r.x)), window.innerWidth - 8)
    const h = Math.min(Math.max(120, r.h + (e.clientY - r.y)), window.innerHeight - 100)
    // Si al agrandar el borde se iría de la pantalla, movemos el panel para que
    // la esquina (la manija) siga siendo alcanzable y se pueda volver a achicar.
    const x = Math.min(r.x0, Math.max(4, window.innerWidth - w - 4))
    const y = Math.min(r.y0, Math.max(4, window.innerHeight - h - 4))
    put({ w, h, x, y }, false)
  }

  const onResizeUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!resize.current) return
    resize.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    localStorage.setItem(GEO_KEY, JSON.stringify(geomRef.current))
  }

  if (!open) return null

  return (
    <>
      <section className="pip" style={{ left: geom.x, top: geom.y, width: geom.w, height: collapsed ? undefined : geom.h }} aria-label="Pantalla de la PC">
        <header className="pip-head" onPointerDown={onDragDown} onPointerMove={onDragMove} onPointerUp={onDragUp} onPointerCancel={onDragUp}>
          <Icon name="vm" />
          <span className="pip-title">{label}</span>
          <button type="button" className="pip-btn" onClick={() => setExpanded(true)} aria-label="Ampliar y controlar"><Icon name="screen-full" /></button>
          <button type="button" className="pip-btn" onClick={() => setPicking(true)} aria-label="Elegir qué ver">
            <Icon name="device-camera" />
          </button>
          <button type="button" className="pip-btn" onClick={() => put({ live: !geom.live })} aria-label={geom.live ? "Pausar la vista" : "Seguir en vivo"}>
            <Icon name={geom.live ? "debug-pause" : "play"} />
          </button>
          <button type="button" className="pip-btn" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expandir" : "Achicar"}>
            <Icon name={collapsed ? "chevron-up" : "chevron-down"} />
          </button>
          <button type="button" className="pip-btn" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" />
          </button>
        </header>
        {!collapsed && (
          <div className="pip-body">
            <ScreenView target={target} active={geom.live && !expanded} controls={false} />
          </div>
        )}
        {!collapsed && <div className="pip-resize" onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp} />}
      </section>
      {picking && (
        <Sheet title="Qué querés ver" onClose={() => setPicking(false)}>
          <div className="screen-targets">
            <button
              type="button"
              className={`chip${geom.mode === "follow" ? " on" : ""}`}
              onClick={() => {
                put({ mode: "follow" })
                setPicking(false)
              }}
            >
              Sigue al agente
            </button>
            <button
              type="button"
              className={`chip${geom.mode === "screen" ? " on" : ""}`}
              onClick={() => {
                put({ mode: "screen" })
                setPicking(false)
              }}
            >
              Toda la pantalla
            </button>
          </div>
          <div className="pip-pick-list">
            {windows.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`pick${geom.mode === w.id ? " on" : ""}`}
                onClick={() => {
                  put({ mode: w.id })
                  setPicking(false)
                }}
              >
                <Icon name="window" />
                <span>{w.title || w.process || "Ventana"}</span>
              </button>
            ))}
          </div>
          <small className="muted">«Sigue al agente» muestra la ventana que está usando. Usá «Ampliar y controlar» para manejar vos la PC.</small>
        </Sheet>
      )}
      {expanded && <ScreenSheet initialTarget={target} onClose={() => setExpanded(false)} />}
    </>
  )
}
