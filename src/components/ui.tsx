import type { CSSProperties, MouseEvent, ReactNode } from "react"
import { highlightSegments } from "../lib/fuzzy"
import { fileKind } from "../lib/files"

export function Icon({
  name,
  className,
  style,
  spin,
  title,
}: {
  name: string
  className?: string
  style?: CSSProperties
  spin?: boolean
  title?: string
}) {
  return (
    <i
      className={`codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}${className ? ` ${className}` : ""}`}
      style={style}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  )
}

export function IconButton({
  icon,
  title,
  onClick,
  active,
  disabled,
  className,
  badge,
}: {
  icon: string
  title: string
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  active?: boolean
  disabled?: boolean
  className?: string
  badge?: number | string | null
}) {
  return (
    <button
      type="button"
      className={`icon-button${active ? " active" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} />
      {badge !== undefined && badge !== null && badge !== 0 && <span className="icon-badge">{badge}</span>}
    </button>
  )
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  const kind = fileKind(path)
  return <Icon name={kind.icon} className={`file-icon${className ? ` ${className}` : ""}`} style={{ color: kind.color }} />
}

export function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  return (
    <>
      {highlightSegments(text, positions).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="fuzzy-hit">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: string
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <Icon name={icon} className="empty-state-icon" />
      <div className="empty-state-title">{title}</div>
      {children && <div className="empty-state-body">{children}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}

export function Section({
  title,
  open,
  onToggle,
  actions,
  count,
  stats,
  children,
  grow,
}: {
  title: string
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  count?: number
  stats?: { added: number; removed: number } | null
  children: ReactNode
  grow?: boolean
}) {
  return (
    <section className={`pane-section${open ? " open" : ""}${grow && open ? " grow" : ""}`}>
      <div className="pane-section-header" onClick={onToggle} role="button">
        <Icon name={open ? "chevron-down" : "chevron-right"} className="pane-chevron" />
        <span className="pane-section-title">{title}</span>
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span
            className="pane-stats"
            title={`${stats.added} líneas agregadas, ${stats.removed} eliminadas`}
          >
            <span className="pane-added">+{stats.added}</span>
            <span className="pane-removed">−{stats.removed}</span>
          </span>
        )}
        {count !== undefined && count > 0 && <span className="pane-count">{count}</span>}
        <span className="pane-section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </div>
      {open && <div className="pane-section-body">{children}</div>}
    </section>
  )
}
