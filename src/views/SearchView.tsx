import { useEffect, useMemo, useRef, useState } from "react"
import { create } from "zustand"
import { replaceInFiles, searchText, type SearchQuery, type SearchResult } from "../lib/search"
import { debounce } from "../lib/persist"
import { basename, dirname, joinPath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { useProject } from "../state/project"
import { openFile } from "../state/editors"
import { notify } from "../state/toasts"
import { reloadDocument } from "../editor/documents"
import { confirmAction } from "../components/Dialog"
import { FileIcon, Icon, IconButton, Spinner } from "../components/ui"

type SearchUi = {
  query: string
  replace: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  include: string
  exclude: string
  showReplace: boolean
  showFilters: boolean
  focusNonce: number
}

export const useSearchUi = create<SearchUi>(() => ({
  query: "",
  replace: "",
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  include: "",
  exclude: "",
  showReplace: false,
  showFilters: false,
  focusNonce: 0,
}))

export function focusSearch(initial?: string) {
  useSearchUi.setState((s) => ({ focusNonce: s.focusNonce + 1, ...(initial ? { query: initial } : {}) }))
}

function Toggle({ on, icon, title, onClick }: { on: boolean; icon: string; title: string; onClick: () => void }) {
  return (
    <button type="button" className={`input-toggle${on ? " on" : ""}`} title={title} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}

export function SearchView() {
  const root = useProject((s) => s.root)
  const ui = useSearchUi()
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const seq = useRef(0)

  const set = (patch: Partial<SearchUi>) => useSearchUi.setState(patch)

  const run = useMemo(
    () =>
      debounce((q: SearchQuery) => {
        const id = ++seq.current
        if (!q.query) {
          setResult(null)
          setLoading(false)
          return
        }
        setLoading(true)
        searchText(q)
          .then((r) => {
            if (id !== seq.current) return
            setResult(r)
            setError(null)
          })
          .catch((e) => id === seq.current && setError(errorMessage(e)))
          .finally(() => id === seq.current && setLoading(false))
      }, 260),
    [],
  )

  const query: SearchQuery | null = root
    ? {
        root,
        query: ui.query,
        regex: ui.regex,
        caseSensitive: ui.caseSensitive,
        wholeWord: ui.wholeWord,
        include: ui.include,
        exclude: ui.exclude,
        maxResults: 5000,
      }
    : null

  const queryKey = JSON.stringify(query)
  useEffect(() => {
    if (query) run(query)
  }, [queryKey])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [ui.focusNonce])

  const replaceAll = async () => {
    if (!query || !result || result.files.length === 0) return
    const ok = await confirmAction(
      "Reemplazar en todos los archivos",
      `Se reemplazan ${result.total} coincidencias en ${result.files.length} archivos por "${ui.replace}".`,
      "Reemplazar",
      true,
    )
    if (!ok) return
    try {
      const out = await replaceInFiles(query, ui.replace, result.files.map((f) => f.path))
      notify.success(`Reemplazadas ${out.replacements} coincidencias en ${out.files} archivos`)
      for (const f of result.files) void reloadDocument(joinPath(query.root, f.path), { flash: true })
      run(query)
    } catch (e) {
      notify.error("No se pudo reemplazar", errorMessage(e))
    }
  }

  return (
    <div className="view search-view">
      <div className="view-header">
        <span className="view-title">Buscar</span>
        <span className="view-actions">
          <IconButton
            icon="collapse-all"
            title="Colapsar resultados"
            onClick={() => setCollapsed(Object.fromEntries((result?.files ?? []).map((f) => [f.path, true])))}
          />
          <IconButton icon="clear-all" title="Limpiar" onClick={() => set({ query: "", replace: "" })} />
        </span>
      </div>
      <div className="search-form">
        <div className="search-row">
          <button type="button" className="search-expand" title="Reemplazar" onClick={() => set({ showReplace: !ui.showReplace })}>
            <Icon name={ui.showReplace ? "chevron-down" : "chevron-right"} />
          </button>
          <div className="search-inputs">
            <div className="input-with-toggles">
              <textarea
                ref={inputRef}
                rows={1}
                className="input"
                placeholder="Buscar"
                value={ui.query}
                spellCheck={false}
                onChange={(e) => set({ query: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    if (query) run(query)
                  }
                }}
              />
              <span className="input-toggles">
                <Toggle on={ui.caseSensitive} icon="case-sensitive" title="Distinguir mayúsculas" onClick={() => set({ caseSensitive: !ui.caseSensitive })} />
                <Toggle on={ui.wholeWord} icon="whole-word" title="Palabra completa" onClick={() => set({ wholeWord: !ui.wholeWord })} />
                <Toggle on={ui.regex} icon="regex" title="Expresión regular" onClick={() => set({ regex: !ui.regex })} />
              </span>
            </div>
            {ui.showReplace && (
              <div className="input-with-toggles">
                <input className="input" placeholder="Reemplazar" value={ui.replace} spellCheck={false} onChange={(e) => set({ replace: e.target.value })} />
                <span className="input-toggles">
                  <button type="button" className="input-toggle" title="Reemplazar todo" disabled={!result?.total} onClick={() => void replaceAll()}>
                    <Icon name="replace-all" />
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>
        <button type="button" className="search-filters-toggle" onClick={() => set({ showFilters: !ui.showFilters })}>
          <Icon name="ellipsis" />
        </button>
        {ui.showFilters && (
          <div className="search-filters">
            <label>
              archivos a incluir
              <input className="input" placeholder="ej. src, *.ts" value={ui.include} onChange={(e) => set({ include: e.target.value })} />
            </label>
            <label>
              archivos a excluir
              <input className="input" placeholder="ej. *.test.ts, docs" value={ui.exclude} onChange={(e) => set({ exclude: e.target.value })} />
            </label>
          </div>
        )}
      </div>
      <div className="search-summary">
        {loading && <Spinner size={12} />}
        {error && <span className="error-text">{error}</span>}
        {result && !error && (
          <span>
            {result.total} resultado{result.total === 1 ? "" : "s"} en {result.files.length} archivo{result.files.length === 1 ? "" : "s"}
            {result.truncated ? " (recortado)" : ""}
          </span>
        )}
      </div>
      <div className="search-results">
        {root &&
          result?.files.map((f) => (
            <div key={f.path} className="search-file">
              <div className="search-file-head" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))}>
                <Icon name={collapsed[f.path] ? "chevron-right" : "chevron-down"} className="tree-twistie" />
                <FileIcon path={f.path} />
                <span className="search-file-name">{basename(f.path)}</span>
                <span className="search-file-dir">{dirname(f.path) === f.path ? "" : dirname(f.path)}</span>
                <span className="pane-count">{f.matches.length}</span>
              </div>
              {!collapsed[f.path] &&
                f.matches.map((m, i) => {
                  return (
                    <div
                      key={i}
                      className="search-match"
                      onClick={() =>
                        openFile(joinPath(root, f.path), {
                          preview: true,
                          line: m.line,
                          column: m.col + 1,
                          endLine: m.line,
                          endColumn: m.colEnd + 1,
                        })
                      }
                      title={`Línea ${m.line}`}
                    >
                      <span className="search-line">{m.line}</span>
                      <span className="search-text">
                        {m.ranges.length === 0
                          ? m.text
                          : m.ranges.reduce<React.ReactNode[]>((acc, [s, e], ri) => {
                              const prevEnd = ri === 0 ? 0 : m.ranges[ri - 1][1]
                              acc.push(<span key={`t${ri}`}>{m.text.slice(prevEnd, s)}</span>)
                              acc.push(
                                <mark key={`m${ri}`} className={ui.showReplace && ui.replace ? "replaced" : ""}>
                                  {m.text.slice(s, e)}
                                </mark>,
                              )
                              if (ui.showReplace && ui.replace) acc.push(<ins key={`r${ri}`}>{ui.replace}</ins>)
                              if (ri === m.ranges.length - 1) acc.push(<span key="tail">{m.text.slice(e)}</span>)
                              return acc
                            }, [])}
                      </span>
                    </div>
                  )
                })}
            </div>
          ))}
      </div>
    </div>
  )
}
