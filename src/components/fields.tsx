import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { Icon } from "./ui"

function placePopover(anchor: HTMLElement, el: HTMLElement): boolean {
  const a = anchor.getBoundingClientRect()
  if (a.bottom < 0 || a.top > window.innerHeight) return false
  el.style.minWidth = `${a.width}px`
  const p = el.getBoundingClientRect()
  const fitsBelow = a.bottom + 4 + p.height <= window.innerHeight - 8
  el.style.top = `${fitsBelow ? a.bottom + 4 : Math.max(8, a.top - 4 - p.height)}px`
  el.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - p.width - 8))}px`
  el.style.visibility = "visible"
  return true
}

function usePopover<A extends HTMLElement, P extends HTMLElement>(open: boolean, close: () => void) {
  const anchor = useRef<A>(null)
  const pop = useRef<P>(null)

  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !anchor.current || !el) return
    placePopover(anchor.current, el)
    el.querySelectorAll<HTMLElement>("[data-selected='true']").forEach((x) => x.scrollIntoView({ block: "center" }))
  }, [open])

  useEffect(() => {
    if (!open) return
    let frame = 0
    const follow = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (anchor.current && pop.current && !placePopover(anchor.current, pop.current)) close()
      })
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (pop.current?.contains(target) || anchor.current?.contains(target)) return
      close()
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && pop.current?.contains(e.target)) return
      follow()
    }
    document.addEventListener("mousedown", onDown)
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", follow)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("mousedown", onDown)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", follow)
    }
  }, [open, close])

  return [anchor, pop] as const
}

const HIDDEN = { left: 0, top: 0, visibility: "hidden" as const }

export type SelectOption<T extends string> = { value: T; label: string; description?: string; icon?: string }

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Elegí…",
  icon,
  className,
  title,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  icon?: string
  className?: string
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const close = useCallback(() => setOpen(false), [])
  const [trigger, menu] = usePopover<HTMLButtonElement, HTMLDivElement>(open, close)
  const current = options.find((o) => o.value === value)

  const moveTo = (index: number) => {
    setActive(index)
    requestAnimationFrame(() => menu.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" }))
  }

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  const choose = (option: SelectOption<T>) => {
    onChange(option.value)
    setOpen(false)
    trigger.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        show()
      }
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      moveTo(Math.min(options.length - 1, active + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      moveTo(Math.max(0, active - 1))
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      if (options[active]) choose(options[active])
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false)
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`select-trigger${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        {(current?.icon ?? icon) && <Icon name={current?.icon ?? icon!} className="select-lead" />}
        <span className={`select-value${current ? "" : " placeholder"}`}>{current?.label ?? placeholder}</span>
        <Icon name="chevron-down" className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="select-menu" role="listbox" style={HIDDEN} onMouseDown={(e) => e.preventDefault()}>
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-index={i}
                data-selected={o.value === value}
                className={`select-option${i === active ? " active" : ""}${o.value === value ? " selected" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                <span className="select-check">{o.value === value && <Icon name="check" />}</span>
                {o.icon && <Icon name={o.icon} className="select-option-icon" />}
                <span className="select-option-text">
                  <span>{o.label}</span>
                  {o.description && <small>{o.description}</small>}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)
const pad = (n: number) => String(n).padStart(2, "0")

export function TimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const [trigger, menu] = usePopover<HTMLButtonElement, HTMLDivElement>(open, close)
  const [hh, mm] = value.split(":").map((x) => Number(x) || 0)
  const minutes = MINUTES.includes(mm) ? MINUTES : [...MINUTES, mm].sort((a, b) => a - b)

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`select-trigger time-trigger${open ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false)
        }}
      >
        <Icon name="clock" className="select-lead" />
        <span className="select-value">{`${pad(hh)}:${pad(mm)}`}</span>
        <Icon name="chevron-down" className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="select-menu time-menu" style={HIDDEN} onMouseDown={(e) => e.preventDefault()}>
            <div className="time-col">
              <span className="time-col-title">Hora</span>
              {HOURS.map((h) => (
                <button key={h} type="button" data-selected={h === hh} className={`time-cell${h === hh ? " selected" : ""}`} onClick={() => onChange(`${pad(h)}:${pad(mm)}`)}>
                  {pad(h)}
                </button>
              ))}
            </div>
            <div className="time-col">
              <span className="time-col-title">Min</span>
              {minutes.map((m) => (
                <button
                  key={m}
                  type="button"
                  data-selected={m === mm}
                  className={`time-cell${m === mm ? " selected" : ""}`}
                  onClick={() => {
                    onChange(`${pad(hh)}:${pad(m)}`)
                    setOpen(false)
                  }}
                >
                  {pad(m)}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  suffix?: string
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n))
  return (
    <span className="stepper-wrap">
      <span className="stepper">
        <button type="button" aria-label="Menos" disabled={value <= min} onClick={() => onChange(clamp(value - 1))}>
          <Icon name="remove" />
        </button>
        <input
          className="stepper-value"
          inputMode="numeric"
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value.replace(/\D/g, ""), 10)
            if (!Number.isNaN(n)) onChange(clamp(n))
          }}
        />
        <button type="button" aria-label="Más" disabled={value >= max} onClick={() => onChange(clamp(value + 1))}>
          <Icon name="add" />
        </button>
      </span>
      {suffix && <span className="stepper-suffix">{suffix}</span>}
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  iconOnly = false,
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: string }>
  onChange: (value: T) => void
  iconOnly?: boolean
}) {
  return (
    <span className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={iconOnly ? o.label : undefined}
          title={iconOnly ? o.label : undefined}
          className={`segmented-item${o.value === value ? " active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {(!iconOnly || !o.icon) && o.label}
        </button>
      ))}
    </span>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="toggle-track">
        <span className="toggle-knob" />
      </span>
      {label && <span>{label}</span>}
    </button>
  )
}
