import { memo, useMemo } from "react"
import { computeRows, type Row } from "../lib/diff"

type Pair = {
  left: { ln: number | null; text: string; kind: "del" | "context" } | null
  right: { ln: number | null; text: string; kind: "add" | "context" } | null
  hunk?: string
}

function toPairs(rows: Row[]): Pair[] {
  const pairs: Pair[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    if (r.kind === "hunk") {
      pairs.push({ left: null, right: null, hunk: r.text })
      i++
      continue
    }
    if (r.kind === "del" || r.kind === "add") {
      const dels: Row[] = []
      const adds: Row[] = []
      while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++])
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++])
      const n = Math.max(dels.length, adds.length)
      for (let k = 0; k < n; k++) {
        pairs.push({
          left: dels[k] ? { ln: dels[k].old, text: dels[k].text, kind: "del" } : null,
          right: adds[k] ? { ln: adds[k].new, text: adds[k].text, kind: "add" } : null,
        })
      }
      continue
    }
    pairs.push({ left: { ln: r.old, text: r.text, kind: "context" }, right: { ln: r.new, text: r.text, kind: "context" } })
    i++
  }
  return pairs
}

export const DiffRows = memo(function DiffRows({
  patch,
  file = "",
  maxRows = 400,
  split = false,
  onLineClick,
}: {
  patch: string
  file?: string
  maxRows?: number
  split?: boolean
  onLineClick?: (line: number) => void
}) {
  const rows = useMemo(() => computeRows({ file, patch, additions: 0, deletions: 0 }) ?? [], [patch, file])
  const visible = useMemo(() => rows.slice(0, maxRows), [rows, maxRows])
  const pairs = useMemo(() => (split ? toPairs(visible) : []), [split, visible])
  if (rows.length === 0) return <div className="diff-empty">Sin cambios de contenido</div>
  return (
    <div className="diff-rows">
      {split ? (
        <table className="diff-table split">
          <colgroup>
            <col className="ln-col" />
            <col />
            <col className="ln-col" />
            <col />
          </colgroup>
          <tbody>
            {pairs.map((p, i) =>
              p.hunk ? (
                <tr key={i} className="hunk">
                  <td colSpan={4}>{p.hunk}</td>
                </tr>
              ) : (
                <tr key={i}>
                  <td className={`ln ${p.left?.kind ?? "empty"}`}>{p.left?.ln ?? ""}</td>
                  <td className={`code ${p.left?.kind ?? "empty"}`}>{p.left ? p.left.text || " " : ""}</td>
                  <td
                    className={`ln ${p.right?.kind ?? "empty"}${onLineClick && p.right?.ln ? " clickable" : ""}`}
                    onClick={() => p.right?.ln && onLineClick?.(p.right.ln)}
                  >
                    {p.right?.ln ?? ""}
                  </td>
                  <td className={`code ${p.right?.kind ?? "empty"}`}>{p.right ? p.right.text || " " : ""}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      ) : (
        <table className="diff-table unified">
          <colgroup>
            <col className="ln-col" />
            <col className="ln-col" />
            <col />
          </colgroup>
          <tbody>
            {visible.map((r, i) =>
              r.kind === "hunk" ? (
                <tr key={i} className="hunk">
                  <td colSpan={3}>{r.text}</td>
                </tr>
              ) : (
                <tr key={i} className={r.kind}>
                  <td className="ln">{r.old ?? ""}</td>
                  <td
                    className={`ln${onLineClick && r.new ? " clickable" : ""}`}
                    onClick={() => r.new && onLineClick?.(r.new)}
                  >
                    {r.new ?? ""}
                  </td>
                  <td className="code">
                    <span className="marker">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                    {r.text || " "}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {rows.length > maxRows && <div className="diff-truncated">Mostrando {maxRows} de {rows.length} líneas</div>}
    </div>
  )
})
