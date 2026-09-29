import { useRef } from "react"

export function Sash({
  orientation,
  onDrag,
  onDragEnd,
  onDoubleClick,
  className,
}: {
  orientation: "vertical" | "horizontal"
  onDrag: (delta: number, start: number) => void
  onDragEnd?: () => void
  onDoubleClick?: () => void
  className?: string
}) {
  const dragging = useRef(false)
  return (
    <div
      className={`sash sash-${orientation}${className ? ` ${className}` : ""}`}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        e.preventDefault()
        const startPos = orientation === "vertical" ? e.clientX : e.clientY
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        dragging.current = true
        document.body.classList.add(orientation === "vertical" ? "resizing-x" : "resizing-y")
        el.classList.add("active")
        const move = (ev: PointerEvent) => {
          if (!dragging.current) return
          const pos = orientation === "vertical" ? ev.clientX : ev.clientY
          onDrag(pos - startPos, startPos)
        }
        const up = () => {
          dragging.current = false
          document.body.classList.remove("resizing-x", "resizing-y")
          el.classList.remove("active")
          el.removeEventListener("pointermove", move)
          el.removeEventListener("pointerup", up)
          el.removeEventListener("pointercancel", up)
          onDragEnd?.()
        }
        el.addEventListener("pointermove", move)
        el.addEventListener("pointerup", up)
        el.addEventListener("pointercancel", up)
      }}
    />
  )
}
