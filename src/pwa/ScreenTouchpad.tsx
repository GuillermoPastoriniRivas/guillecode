import { useEffect, useRef, useState, type PointerEvent } from "react"

export function ScreenTouchpad({ onMove, onClick, onDrag, onScroll }: { onMove: (dx: number, dy: number) => void; onClick: (button: "left" | "right") => void; onDrag: (held: boolean) => void; onScroll: (dy: number) => void }) {
  const [precise, setPrecise] = useState(false)
  const [dragging, setDragging] = useState(false)
  const drag = useRef(onDrag)
  useEffect(() => { drag.current = onDrag }, [onDrag])
  useEffect(() => () => drag.current(false), [])
  const finger = useRef<{ id: number; x: number; y: number; distance: number; started: number } | null>(null)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (finger.current || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    finger.current = { id: e.pointerId, x: e.clientX, y: e.clientY, distance: 0, started: Date.now() }
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const f = finger.current
    if (!f || f.id !== e.pointerId) return
    const dx = e.clientX - f.x, dy = e.clientY - f.y
    f.x = e.clientX; f.y = e.clientY
    f.distance += Math.hypot(dx, dy)
    onMove(dx * (precise ? 0.35 : 1), dy * (precise ? 0.35 : 1))
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const f = finger.current
    if (!f || f.id !== e.pointerId) return
    finger.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!dragging && e.type === "pointerup" && f.distance < 6 && Date.now() - f.started < 350) onClick("left")
  }
  return <div className="screen-touchpad">
    <div className="screen-pad" aria-label="Pad para mover el cursor" onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onContextMenu={e => e.preventDefault()}>
      <span>{dragging ? "Arrastrando…" : "Panel táctil"}</span>
      <small>{dragging ? "Mové el dedo y tocá Soltar al terminar" : "Deslizá para mover · tocá para hacer clic"}</small>
    </div>
    <div className="screen-mouse-buttons">
      <button type="button" className="btn btn-sm" disabled={dragging} onClick={() => onClick("left")}>Clic</button>
      <button type="button" className="btn btn-sm" disabled={dragging} onClick={() => onClick("right")}>Clic derecho</button>
      <button type="button" className="btn btn-sm" disabled={dragging} onClick={() => { onClick("left"); onClick("left") }}>Doble clic</button>
      <button type="button" className={`btn btn-sm${dragging ? " primary" : ""}`} aria-pressed={dragging} onClick={() => { onDrag(!dragging); setDragging(!dragging) }}>{dragging ? "Soltar arrastre" : "Arrastrar"}</button>
      <button type="button" className="btn btn-sm" onClick={() => onScroll(360)}>↑ Desplazar</button>
      <button type="button" className="btn btn-sm" onClick={() => onScroll(-360)}>↓ Desplazar</button>
    </div>
    <button type="button" className="screen-precision" aria-pressed={precise} onClick={() => setPrecise(v => !v)}>Movimiento preciso <span>{precise ? "Activado" : "Desactivado"}</span></button>
  </div>
}
