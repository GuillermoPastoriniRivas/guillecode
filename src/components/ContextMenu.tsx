import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { create } from "zustand"
import { Icon } from "./ui"
import { formatKeys } from "../commands/registry"

export type MenuItem =
  | { separator: true }
  | {
      label: string
      icon?: string
      keys?: string
      danger?: boolean
      disabled?: boolean
      run: () => void
    }

type MenuState = { x: number; y: number; items: MenuItem[] } | null

const useMenu = create<{ menu: MenuState }>(() => ({ menu: null }))

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault()
  e.stopPropagation?.()
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect()
  useMenu.setState({ menu: { x: r.left, y: r.bottom + 4, items } })
}

export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [focus, setFocus] = useState(-1)

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null)
      return
    }
    const rect = ref.current.getBoundingClientRect()
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8)
    const y = menu.y + rect.height > window.innerHeight - 8 ? Math.max(8, menu.y - rect.height) : menu.y
    setPos({ x: Math.max(8, x), y })
    setFocus(-1)
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = () => useMenu.setState({ menu: null })
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      const actionable = menu.items
        .map((item, i) => ({ item, i }))
        .filter((x) => !("separator" in x.item) && !x.item.disabled)
      if (e.key === "Escape") {
        e.preventDefault()
        close()
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const idx = actionable.findIndex((x) => x.i === focus)
        const next = e.key === "ArrowDown" ? (idx + 1) % actionable.length : (idx - 1 + actionable.length) % actionable.length
        setFocus(actionable[next]?.i ?? -1)
      } else if (e.key === "Enter" && focus >= 0) {
        e.preventDefault()
        const item = menu.items[focus]
        if (item && !("separator" in item)) {
          close()
          item.run()
        }
      }
    }
    window.addEventListener("mousedown", onDown, true)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("blur", close)
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("mousedown", onDown, true)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("blur", close)
      window.removeEventListener("resize", close)
    }
  }, [menu, focus])

  if (!menu) return null
  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        "separator" in item ? (
          <div key={i} className="context-menu-separator" />
        ) : (
          <button
            key={i}
            type="button"
            className={`context-menu-item${item.danger ? " danger" : ""}${focus === i ? " focused" : ""}`}
            disabled={item.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => {
              useMenu.setState({ menu: null })
              item.run()
            }}
          >
            <span className="context-menu-icon">{item.icon && <Icon name={item.icon} />}</span>
            <span className="context-menu-label">{item.label}</span>
            {item.keys && <span className="context-menu-keys">{formatKeys(item.keys)}</span>}
          </button>
        ),
      )}
    </div>
  )
}
