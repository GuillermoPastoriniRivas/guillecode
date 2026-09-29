import { useCallback, useEffect, useMemo, useState } from "react"
import { gitLog, parseRef, type Commit } from "../lib/git"
import { errorMessage } from "../lib/tauri"
import { shortAgo, formatDateTime } from "../lib/time"
import { openEditor } from "../state/editors"
import { useGit } from "../state/git"
import { basename } from "../lib/paths"
import { Icon, Spinner } from "../components/ui"

const LANE_W = 14
const ROW_H = 28
const PAGE = 300
const COLORS = ["#7aa2ff", "#c58cff", "#5fd4a0", "#ffb86b", "#ff7ab6", "#5ad1e0", "#e6d36a", "#ff8f7a"]

type GraphRow = {
  commit: Commit
  column: number
  before: Array<string | null>
  after: Array<string | null>
}

function trim(lanes: Array<string | null>): Array<string | null> {
  const out = [...lanes]
  while (out.length && out[out.length - 1] === null) out.pop()
  return out
}

export function buildGraph(commits: Commit[]): GraphRow[] {
  const rows: GraphRow[] = []
  let lanes: Array<string | null> = []
  for (const commit of commits) {
    const before = [...lanes]
    let column = before.indexOf(commit.hash)
    if (column === -1) {
      column = before.indexOf(null)
      if (column === -1) column = before.length
      before[column] = commit.hash
    }
    const after = before.map((h) => (h === commit.hash ? null : h))
    const [first, ...rest] = commit.parents
    if (first) {
      const existing = after.indexOf(first)
      if (existing === -1) after[column] = first
    }
    for (const p of rest) {
      if (after.includes(p)) continue
      const free = after.indexOf(null)
      if (free === -1) after.push(p)
      else after[free] = p
    }
    rows.push({ commit, column, before, after: trim(after) })
    lanes = trim(after)
  }
  return rows
}

function x(lane: number) {
  return LANE_W / 2 + lane * LANE_W + 2
}

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const mid = ROW_H / 2
  const paths: Array<{ d: string; color: string }> = []
  row.before.forEach((hash, lane) => {
    if (hash === null) return
    const color = COLORS[lane % COLORS.length]
    if (hash === row.commit.hash) {
      paths.push({ d: `M${x(lane)} 0 C${x(lane)} ${mid / 2} ${x(row.column)} ${mid / 2} ${x(row.column)} ${mid}`, color })
      return
    }
    const target = row.after.indexOf(hash)
    if (target === -1) return
    paths.push({ d: `M${x(lane)} 0 C${x(lane)} ${mid} ${x(target)} ${mid} ${x(target)} ${ROW_H}`, color: COLORS[target % COLORS.length] })
  })
  row.commit.parents.forEach((p) => {
    const target = row.after.indexOf(p)
    if (target === -1) return
    paths.push({
      d: `M${x(row.column)} ${mid} C${x(row.column)} ${ROW_H} ${x(target)} ${mid} ${x(target)} ${ROW_H}`,
      color: COLORS[target % COLORS.length],
    })
  })
  const merge = row.commit.parents.length > 1
  return (
    <svg width={width} height={ROW_H} className="graph-svg">
      {paths.map((p, i) => (
        <path key={i} d={p.d} stroke={p.color} strokeWidth={2} fill="none" />
      ))}
      <circle
        cx={x(row.column)}
        cy={mid}
        r={merge ? 3.5 : 4.5}
        fill={merge ? "var(--editor-bg)" : COLORS[row.column % COLORS.length]}
        stroke={COLORS[row.column % COLORS.length]}
        strokeWidth={2}
      />
    </svg>
  )
}

function RefBadges({ refs }: { refs: string[] }) {
  return (
    <>
      {refs
        .map(parseRef)
        .filter((r) => !(r.kind === "remote" && r.name.endsWith("/HEAD")))
        .map((r) => (
          <span key={`${r.kind}:${r.name}`} className={`ref-badge ${r.kind}`}>
            <Icon name={r.kind === "tag" ? "tag" : r.kind === "remote" ? "cloud" : "git-branch"} />
            {r.name}
          </span>
        ))}
    </>
  )
}

export function GraphEditor({ repo }: { repo: string }) {
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(true)
  const [filter, setFilter] = useState("")
  const [loadingMore, setLoadingMore] = useState(false)
  const revision = useGit((s) => s.headRevision)

  const load = useCallback(async () => {
    try {
      setCommits(await gitLog(repo, { limit: PAGE, all }))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [repo, all])

  useEffect(() => {
    void load()
  }, [load, revision])

  const rows = useMemo(() => buildGraph(commits ?? []), [commits])
  const maxLanes = useMemo(() => rows.reduce((m, r) => Math.max(m, r.before.length, r.after.length, r.column + 1), 1), [rows])
  const width = Math.min(maxLanes, 12) * LANE_W + 6
  const q = filter.trim().toLowerCase()

  const loadMore = async () => {
    if (!commits) return
    setLoadingMore(true)
    try {
      const more = await gitLog(repo, { limit: PAGE, skip: commits.length, all })
      setCommits([...commits, ...more])
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="graph-editor">
      <div className="graph-toolbar">
        <Icon name="git-commit" />
        <span className="graph-title">Historial de {basename(repo)}</span>
        <input className="input input-sm" placeholder="Filtrar por mensaje, autor o hash" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="checkbox">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Todas las ramas
        </label>
      </div>
      {error && <div className="editor-message center">{error}</div>}
      {!commits && !error && (
        <div className="editor-overlay">
          <Spinner />
        </div>
      )}
      <div className="graph-list">
        {rows.map((row) => {
          const c = row.commit
          const hidden = q && !`${c.subject} ${c.author} ${c.hash}`.toLowerCase().includes(q)
          return (
            <div
              key={c.hash}
              className={`graph-row${hidden ? " dimmed" : ""}`}
              onClick={() => openEditor({ kind: "commit", repo, hash: c.hash })}
              title={`${c.subject}\n${c.author} · ${formatDateTime(c.time * 1000)}`}
            >
              <GraphCell row={row} width={width} />
              <span className="graph-subject">
                <RefBadges refs={c.refs} />
                {c.subject}
              </span>
              <span className="graph-author">{c.author}</span>
              <span className="graph-date">{shortAgo(c.time * 1000)}</span>
              <span className="graph-hash">{c.hash.slice(0, 7)}</span>
            </div>
          )
        })}
        {commits && commits.length >= PAGE && commits.length % PAGE === 0 && (
          <button type="button" className="btn btn-sm graph-more" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <Spinner size={12} /> : <Icon name="chevron-down" />} Cargar más
          </button>
        )}
      </div>
    </div>
  )
}
