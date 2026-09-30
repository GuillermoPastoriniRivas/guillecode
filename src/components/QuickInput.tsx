import { useEffect, useMemo, useRef, useState } from "react"
import {
  closeQuickInput,
  resolveInput,
  resolvePick,
  useQuickInput,
  type QuickItem,
} from "../state/quickinput"
import { useProject } from "../state/project"
import { getFileIndex, useFileIndex } from "../state/fileIndex"
import { useEditors, openFile } from "../state/editors"
import { selectSession, useAgent } from "../state/agent"
import { useLayout } from "../state/layout"
import { allCommands, executeCommand, formatKeys, recentCommandIds } from "../commands/registry"
import { rankFuzzy, type FuzzyMatch } from "../lib/fuzzy"
import { basename, joinPath, relativePath } from "../lib/paths"
import { activeCode, goToLine } from "../editor/bridge"
import { shortAgo } from "../lib/time"
import { FileIcon, Highlighted, Icon, Kbd, Spinner } from "./ui"

type Row = {
  id: string
  label: string
  description?: string
  detail?: string
  icon?: string
  iconColor?: string
  filePath?: string
  keys?: string
  group?: string
  groupFavorites?: boolean
  groupSep?: boolean
  favorite?: boolean
  onToggleFavorite?: () => void
  match?: FuzzyMatch
  descMatch?: FuzzyMatch
  accept: (sideways: boolean) => void
}

const MODES = [
  { prefix: "", label: "Ir a archivo", icon: "go-to-file" },
  { prefix: ">", label: "Comandos", icon: "symbol-event" },
  { prefix: ":", label: "Ir a línea", icon: "symbol-number" },
  { prefix: "#", label: "Sesiones del agente", icon: "hubot" },
]

const CATEGORY_ORDER = ["GuilleCode", "Archivo"]
const categoryRank = (category?: string) => {
  const i = CATEGORY_ORDER.indexOf(category ?? "")
  return i === -1 ? CATEGORY_ORDER.length : i
}

function useRecentFiles(root: string | null): string[] {
  const groups = useEditors((s) => s.groups)
  return useMemo(() => {
    if (!root) return []
    const out: string[] = []
    for (const g of groups) for (const t of g.tabs) if (t.input.kind === "file") out.push(relativePath(root, t.input.path))
    return out
  }, [groups, root])
}

export function QuickInput() {
  const { open, value, request, nonce } = useQuickInput()
  const root = useProject((s) => s.root)
  const files = useFileIndex((s) => s.files)
  const indexLoading = useFileIndex((s) => s.loading)
  const sessions = useAgent((s) => s.sessions)
  const favoriteModels = useAgent((s) => s.favoriteModels)
  const recentFiles = useRecentFiles(root)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setSelected(0)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      if (request) el.select()
      else el.setSelectionRange(el.value.length, el.value.length)
    })
    if (root && !request) void getFileIndex(root)
  }, [open, nonce, root, request])

  const setValue = (v: string) => {
    useQuickInput.setState({ value: v })
    setSelected(0)
  }

  const mode = request ? request.kind : value.startsWith(">") ? "commands" : value.startsWith(":") ? "line" : value.startsWith("#") ? "sessions" : value.startsWith("?") ? "help" : "files"
  const query = request ? value : mode === "files" ? value : value.slice(1)

  const rows: Row[] = useMemo(() => {
    if (!open) return []
    if (request?.kind === "pick") {
      const q = query.trim()
      const limit = q ? 200 : request.items.length
      const ranked = rankFuzzy(request.items, query, (i: QuickItem) => `${i.label} ${i.description ?? ""}`, limit)
      return ranked.map(({ item, match }) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        detail: item.detail,
        icon: item.icon,
        iconColor: item.iconColor,
        keys: item.keys,
        group: request.favorites && !q ? (item.favorite ? "★ Favoritos" : item.group) : item.group,
        groupFavorites: request.favorites && !q,
        favorite: request.favorites ? favoriteModels.includes(item.id) : undefined,
        onToggleFavorite: request.favorites ? item.onToggleFavorite : undefined,
        match: { score: match.score, positions: match.positions.filter((p) => p < item.label.length) },
        accept: () => resolvePick(item),
      }))
    }
    if (request?.kind === "input") return []
    if (mode === "help") {
      return MODES.map((m) => ({
        id: `mode-${m.prefix}`,
        label: m.prefix ? `${m.prefix}  ${m.label}` : `…  ${m.label}`,
        icon: m.icon,
        accept: () => setValue(m.prefix),
      }))
    }
    if (mode === "commands") {
      const recent = recentCommandIds()
      const list = allCommands()
      const searching = !!query.trim()
      const ranked = searching
        ? rankFuzzy(list, query, (c) => `${c.category ? c.category + ": " : ""}${c.title}`, 120)
        : [...list]
            .sort((a, b) => {
              const ra = recent.indexOf(a.id)
              const rb = recent.indexOf(b.id)
              if (ra !== -1 || rb !== -1) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb)
              const rankA = categoryRank(a.category)
              const rankB = categoryRank(b.category)
              if (rankA !== rankB) return rankA - rankB
              return `${a.category}${a.title}`.localeCompare(`${b.category}${b.title}`)
            })
            .map((item) => ({ item, match: { score: 0, positions: [] as number[] } }))
      return ranked.map(({ item, match }) => {
        const grouped = !searching
        const label = grouped ? item.title : `${item.category ? item.category + ": " : ""}${item.title}`
        return {
          id: item.id,
          label,
          icon: item.icon ?? "symbol-event",
          keys: item.keys?.[0],
          group: grouped ? (recent.includes(item.id) ? "usados recientemente" : item.category ?? "Otros") : undefined,
          groupSep: grouped,
          match,
          accept: () => {
            closeQuickInput()
            void executeCommand(item.id)
          },
        }
      })
    }
    if (mode === "line") {
      const code = activeCode()
      const m = query.trim().match(/^(\d+)(?:[:,](\d+))?$/)
      if (!code) return [{ id: "noeditor", label: "Abrí un archivo para ir a una línea", icon: "info", accept: () => closeQuickInput() }]
      const lines = code.view.state.doc.lines
      if (!m)
        return [
          {
            id: "hint",
            label: `Escribí un número de línea entre 1 y ${lines}`,
            icon: "symbol-number",
            accept: () => undefined,
          },
        ]
      const line = Number(m[1])
      const col = m[2] ? Number(m[2]) : 1
      return [
        {
          id: "goto",
          label: `Ir a la línea ${line}${m[2] ? `, columna ${col}` : ""}`,
          icon: "arrow-right",
          accept: () => {
            closeQuickInput()
            goToLine(code.view, line, col)
          },
        },
      ]
    }
    if (mode === "sessions") {
      const ranked = rankFuzzy(sessions, query, (s) => s.title || "Sin título", 80)
      return ranked.map(({ item, match }) => ({
        id: item.id,
        label: item.title || "Sin título",
        description: shortAgo(item.time.updated),
        icon: "comment-discussion",
        match,
        accept: () => {
          closeQuickInput()
          useLayout.getState().toggleAgent(true)
          selectSession(item.id)
        },
      }))
    }
    if (!root) return []
    const pool = query.trim() ? files : [...new Set([...recentFiles.slice().reverse(), ...files])]
    const ranked = rankFuzzy(pool, query, (f) => f, 80)
    return ranked.map(({ item, match }) => {
      const name = basename(item)
      const baseStart = item.length - name.length
      return {
        id: item,
        label: name,
        description: item.slice(0, Math.max(0, baseStart - 1)),
        filePath: item,
        group: !query.trim() && recentFiles.includes(item) ? "abiertos" : undefined,
        match: { score: match.score, positions: match.positions.filter((p) => p >= baseStart).map((p) => p - baseStart) },
        descMatch: { score: 0, positions: match.positions.filter((p) => p < baseStart - 1) },
        accept: (sideways: boolean) => {
          closeQuickInput()
          const abs = joinPath(root, item)
          if (sideways) {
            const groups = useEditors.getState().groups
            const current = useEditors.getState().activeGroupId
            const idx = groups.findIndex((g) => g.id === current)
            const other = groups[idx + 1] ?? groups[idx - 1]
            openFile(abs, other ? { groupId: other.id } : {})
          } else openFile(abs)
        },
      }
    })
  }, [open, request, query, mode, files, root, recentFiles, sessions, favoriteModels])

  useEffect(() => {
    listRef.current?.querySelector(".quick-row.selected")?.scrollIntoView({ block: "nearest" })
  }, [selected, rows])

  if (!open) return null

  const inputRequest = request?.kind === "input" ? request : null
  const validation = inputRequest?.validate ? inputRequest.validate(value) : null
  const placeholder =
    request?.placeholder ??
    (mode === "commands"
      ? "Escribí un comando"
      : mode === "sessions"
        ? "Buscar sesiones del agente"
        : mode === "line"
          ? "Número de línea"
          : "Buscar archivos por nombre  ·  > comandos  ·  : línea  ·  # sesiones")

  const accept = (sideways = false) => {
    if (inputRequest) {
      if (validation) return
      resolveInput(value)
      return
    }
    rows[selected]?.accept(sideways)
  }

  return (
    <div className="quick-backdrop" onMouseDown={() => closeQuickInput()}>
      <div className="quick-input" onMouseDown={(e) => e.stopPropagation()}>
        {request?.title && <div className="quick-title">{request.title}</div>}
        <div className="quick-field">
          <Icon name={mode === "commands" ? "chevron-right" : inputRequest ? "edit" : "search"} className="quick-field-icon" />
          <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                closeQuickInput()
              } else if (e.key === "ArrowDown") {
                e.preventDefault()
                setSelected((s) => Math.min(rows.length - 1, s + 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setSelected((s) => Math.max(0, s - 1))
              } else if (e.key === "PageDown") {
                e.preventDefault()
                setSelected((s) => Math.min(rows.length - 1, s + 10))
              } else if (e.key === "PageUp") {
                e.preventDefault()
                setSelected((s) => Math.max(0, s - 10))
              } else if (e.key === "Enter") {
                e.preventDefault()
                accept(e.ctrlKey || e.altKey)
              }
            }}
          />
          {indexLoading && mode === "files" && !request && <Spinner size={12} />}
        </div>
        {inputRequest && (
          <div className={`quick-prompt${validation ? " error" : ""}`}>
            {validation ?? inputRequest.prompt ?? "Enter para confirmar · Esc para cancelar"}
          </div>
        )}
        {!inputRequest && (
          <div className="quick-list" ref={listRef}>
            {rows.length === 0 && (
              <div className="quick-empty">{mode === "files" && indexLoading ? "Indexando archivos…" : "Sin resultados"}</div>
            )}
            {rows.map((row, i) => (
              <div key={row.id}>
                {row.group &&
                  (i === 0 || rows[i - 1].group !== row.group) &&
                  (row.groupFavorites || row.groupSep
                    ? i > 0
                      ? <div className="quick-group quick-group-sep">{row.group}</div>
                      : <div className="quick-group">{row.group}</div>
                    : <div className="quick-group">{row.group}</div>)}
                <div
                  className={`quick-row${i === selected ? " selected" : ""}`}
                  onMouseMove={() => i !== selected && setSelected(i)}
                  onClick={(e) => {
                    setSelected(i)
                    row.accept(e.ctrlKey || e.altKey)
                  }}
                >
                  {row.filePath ? (
                    <FileIcon path={row.filePath} />
                  ) : (
                    <Icon name={row.icon ?? "circle-small"} style={row.iconColor ? { color: row.iconColor } : undefined} className="quick-row-icon" />
                  )}
                  <span className="quick-row-label">
                    {row.match ? <Highlighted text={row.label} positions={row.match.positions} /> : row.label}
                  </span>
                  {row.description && (
                    <span className="quick-row-desc">
                      {row.descMatch ? <Highlighted text={row.description} positions={row.descMatch.positions} /> : row.description}
                    </span>
                  )}
                  {row.detail && <span className="quick-row-detail">{row.detail}</span>}
                  {row.keys && <Kbd>{formatKeys(row.keys)}</Kbd>}
                  {row.onToggleFavorite && (
                    <button
                      type="button"
                      className={`quick-star${row.favorite ? " on" : ""}`}
                      title={row.favorite ? "Quitar de favoritos" : "Marcar como favorito"}
                      onClick={(e) => {
                        e.stopPropagation()
                        row.onToggleFavorite?.()
                      }}
                    >
                      <Icon name={row.favorite ? "star-full" : "star-empty"} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
