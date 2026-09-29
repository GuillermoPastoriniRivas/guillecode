import { useEffect, useState } from "react"
import { gitCommitDetail, parseRef, type CommitDetail } from "../lib/git"
import { errorMessage } from "../lib/tauri"
import { formatDateTime, timeAgo } from "../lib/time"
import { basename, dirname } from "../lib/paths"
import { openEditor } from "../state/editors"
import { focusComposer } from "../state/agent"
import { useLayout } from "../state/layout"
import { FileIcon, Icon, Spinner } from "../components/ui"

const STATUS_LABEL: Record<string, string> = { A: "nuevo", M: "modificado", D: "borrado", R: "renombrado", C: "copiado", T: "tipo" }

export function CommitEditor({ repo, hash }: { repo: string; hash: string }) {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    gitCommitDetail(repo, hash)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [repo, hash])

  if (error) return <div className="editor-message center">{error}</div>
  if (!detail)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )
  const c = detail.commit
  const totals = detail.files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 })
  return (
    <div className="doc-page commit-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="git-commit" /> Commit <code>{c.hash.slice(0, 10)}</code>
          <button type="button" className="icon-link" title="Copiar hash" onClick={() => void navigator.clipboard.writeText(c.hash)}>
            <Icon name="copy" />
          </button>
        </div>
        <h1>{c.subject}</h1>
        <div className="doc-meta">
          <span className="avatar-initial">{c.author.slice(0, 1).toUpperCase()}</span>
          <strong>{c.author}</strong>
          <span>{c.email}</span>
          <span title={formatDateTime(c.time * 1000)}>{timeAgo(c.time * 1000)}</span>
          {c.parents.length > 1 && <span className="pill">merge</span>}
          {c.refs.map(parseRef).map((r) => (
            <span key={`${r.kind}:${r.name}`} className={`ref-badge ${r.kind}`}>
              <Icon name={r.kind === "tag" ? "tag" : r.kind === "remote" ? "cloud" : "git-branch"} /> {r.name}
            </span>
          ))}
        </div>
        {detail.body && <pre className="commit-body">{detail.body}</pre>}
        <div className="doc-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              useLayout.getState().toggleAgent(true)
              focusComposer(`Explicame el commit ${c.hash.slice(0, 10)} ("${c.subject}"): qué cambia, por qué y si ves riesgos.`)
            }}
          >
            <Icon name="sparkle" /> Preguntarle al agente
          </button>
          <button type="button" className="btn btn-sm" onClick={() => openEditor({ kind: "graph", repo })}>
            <Icon name="git-commit" /> Ver en el historial
          </button>
        </div>
      </header>
      <section className="doc-section">
        <div className="doc-section-title">
          {detail.files.length} archivo{detail.files.length === 1 ? "" : "s"}
          <span className="add">+{totals.add}</span>
          <span className="del">−{totals.del}</span>
        </div>
        <div className="file-list">
          {detail.files.map((f) => (
            <button
              key={f.path}
              type="button"
              className="file-list-row"
              onClick={() =>
                openEditor({ kind: "commitFile", repo, hash: c.hash, parent: detail.parent, path: f.path, orig: f.orig })
              }
            >
              <FileIcon path={f.path} />
              <span className="file-list-name">{basename(f.path)}</span>
              <span className="file-list-dir">{dirname(f.path) === f.path ? "" : dirname(f.path)}</span>
              {f.orig && <span className="file-list-dir">← {f.orig}</span>}
              <span className="toolbar-spacer" />
              <span className={`status-tag s-${f.status}`}>{STATUS_LABEL[f.status] ?? f.status}</span>
              <span className="add">+{f.additions}</span>
              <span className="del">−{f.deletions}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
