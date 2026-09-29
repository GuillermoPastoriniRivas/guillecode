import { useCallback, useEffect, useMemo, useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  prCheckout,
  prComment,
  prCreate,
  prDiff,
  prMerge,
  prReady,
  prReview,
  prView,
  type PrCheck,
  type PrDetail,
} from "../lib/gh"
import { gitDefaultBranch, gitPush } from "../lib/git"
import { generatePullRequest } from "../lib/ai"
import { splitMultiFilePatch } from "../lib/diff"
import { errorMessage } from "../lib/tauri"
import { timeAgo, formatDateTime } from "../lib/time"
import { basename, dirname } from "../lib/paths"
import { bumpHead, refreshAllRepos, useGit } from "../state/git"
import { notify, withProgress } from "../state/toasts"
import { openEditor, removeTabs } from "../state/editors"
import { openAiReview } from "../state/aiReview"
import { Markdown } from "../agent/Markdown"
import { DiffRows } from "../components/DiffRows"
import { openMenuAt } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { FileIcon, Icon, Spinner } from "../components/ui"

function checkState(c: PrCheck): "success" | "failure" | "pending" | "neutral" {
  const conclusion = (c.conclusion ?? c.state ?? "").toUpperCase()
  if (["SUCCESS"].includes(conclusion)) return "success"
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion)) return "failure"
  if (["NEUTRAL", "SKIPPED", "STALE"].includes(conclusion)) return "neutral"
  return "pending"
}

const CHECK_ICON = { success: "pass-filled", failure: "error", pending: "loading", neutral: "circle-slash" } as const

export function PrEditor({ repo, number }: { repo: string; number: number }) {
  const [pr, setPr] = useState<PrDetail | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<"conversation" | "files" | "checks">("conversation")
  const [comment, setComment] = useState("")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setPr(await prView(repo, number))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [repo, number])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab !== "files" || diff !== null) return
    prDiff(repo, number)
      .then(setDiff)
      .catch((e) => setDiff(`error: ${errorMessage(e)}`))
  }, [tab, diff, repo, number])

  const files = useMemo(() => (diff && !diff.startsWith("error:") ? splitMultiFilePatch(diff) : []), [diff])

  const act = async (label: string, work: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await withProgress(label, work, success)
      await load()
    } catch {
      return
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="editor-message center">{error}</div>
  if (!pr)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )

  const checks = pr.statusCheckRollup ?? []
  const failing = checks.filter((c) => checkState(c) === "failure").length
  const pending = checks.filter((c) => checkState(c) === "pending").length
  const state = pr.isDraft ? "draft" : pr.state.toLowerCase()

  const mergeMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { label: "Squash and merge", icon: "git-merge", run: () => void doMerge("squash") },
      { label: "Merge commit", icon: "git-merge", run: () => void doMerge("merge") },
      { label: "Rebase and merge", icon: "git-merge", run: () => void doMerge("rebase") },
    ])

  const doMerge = async (method: "squash" | "merge" | "rebase") => {
    const ok = await confirmAction(`Mergear PR #${pr.number}`, `${pr.headRefName} → ${pr.baseRefName} (${method}). Se borra la rama remota.`, "Mergear")
    if (ok) await act("Mergeando", () => prMerge(repo, pr.number, method, true), "PR mergeado")
  }

  return (
    <div className="doc-page pr-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <span className={`pr-state-pill ${state}`}>
            <Icon name={state === "merged" ? "git-merge" : state === "closed" ? "git-pull-request-closed" : state === "draft" ? "git-pull-request-draft" : "git-pull-request"} />
            {state === "open" ? "Abierto" : state === "merged" ? "Mergeado" : state === "closed" ? "Cerrado" : "Borrador"}
          </span>
          <span>#{pr.number}</span>
          <span className="branch-flow">
            <code>{pr.headRefName}</code> <Icon name="arrow-right" /> <code>{pr.baseRefName}</code>
          </span>
        </div>
        <h1>{pr.title}</h1>
        <div className="doc-meta">
          <span className="avatar-initial">{pr.author.login.slice(0, 1).toUpperCase()}</span>
          <strong>{pr.author.login}</strong>
          <span title={formatDateTime(Date.parse(pr.createdAt))}>abierto {timeAgo(Date.parse(pr.createdAt))}</span>
          <span className="add">+{pr.additions}</span>
          <span className="del">−{pr.deletions}</span>
          <span>{pr.changedFiles} archivos</span>
          {pr.reviewDecision && <span className={`pill review-${pr.reviewDecision.toLowerCase()}`}>{pr.reviewDecision.replace(/_/g, " ").toLowerCase()}</span>}
          {pr.labels.map((l) => (
            <span key={l.name} className="label-pill" style={{ borderColor: `#${l.color}`, color: `#${l.color}` }}>
              {l.name}
            </span>
          ))}
        </div>
        <div className="doc-actions">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act("Checkout del PR", () => prCheckout(repo, pr.number), "Estás en la rama del PR")}>
            <Icon name="git-branch" /> Checkout
          </button>
          {pr.isDraft && state === "draft" && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act("Marcando listo", () => prReady(repo, pr.number), "PR listo para revisar")}>
              <Icon name="eye" /> Listo para revisión
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => openAiReview({ kind: "aiReview", repo, scope: "pr", number: pr.number, title: pr.title })}
          >
            <Icon name="sparkle" /> Revisar con IA
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void openUrl(pr.url)}>
            <Icon name="link-external" /> GitHub
          </button>
          <span className="toolbar-spacer" />
          {state === "open" && (
            <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act("Aprobando", () => prReview(repo, pr.number, "approve", ""), "PR aprobado")}>
                <Icon name="check" /> Aprobar
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={(e) => mergeMenu(e.currentTarget)}>
                <Icon name="git-merge" /> Merge <Icon name="chevron-down" />
              </button>
            </>
          )}
        </div>
        <nav className="doc-tabs">
          <button type="button" className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>
            <Icon name="comment-discussion" /> Conversación <span className="count">{pr.comments.length + pr.reviews.length}</span>
          </button>
          <button type="button" className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
            <Icon name="diff-multiple" /> Archivos <span className="count">{pr.changedFiles}</span>
          </button>
          <button type="button" className={tab === "checks" ? "active" : ""} onClick={() => setTab("checks")}>
            <Icon name={failing ? "error" : pending ? "loading" : "pass"} spin={!failing && pending > 0} /> Checks{" "}
            <span className="count">{checks.length}</span>
          </button>
        </nav>
      </header>

      {tab === "conversation" && (
        <section className="doc-section">
          <div className="timeline-item">
            <div className="timeline-head">
              <strong>{pr.author.login}</strong> <span>{timeAgo(Date.parse(pr.createdAt))}</span>
            </div>
            <div className="timeline-body">{pr.body ? <Markdown text={pr.body} /> : <em className="muted">Sin descripción</em>}</div>
          </div>
          {[
            ...pr.reviews.map((r) => ({ kind: "review" as const, at: r.submittedAt, author: r.author.login, body: r.body, state: r.state })),
            ...pr.comments.map((c) => ({ kind: "comment" as const, at: c.createdAt, author: c.author.login, body: c.body, state: "" })),
          ]
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .map((item, i) => (
              <div key={i} className={`timeline-item ${item.kind}`}>
                <div className="timeline-head">
                  <strong>{item.author}</strong>
                  {item.kind === "review" && <span className={`pill review-${item.state.toLowerCase()}`}>{item.state.replace(/_/g, " ").toLowerCase()}</span>}
                  <span>{timeAgo(Date.parse(item.at))}</span>
                </div>
                {item.body && (
                  <div className="timeline-body">
                    <Markdown text={item.body} />
                  </div>
                )}
              </div>
            ))}
          <div className="comment-box">
            <textarea
              placeholder="Dejá un comentario (markdown)…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
            />
            <div className="comment-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={!comment.trim() || busy}
                onClick={() => void act("Pidiendo cambios", () => prReview(repo, pr.number, "request-changes", comment), "Cambios pedidos").then(() => setComment(""))}
              >
                Pedir cambios
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!comment.trim() || busy}
                onClick={() => void act("Comentando", () => prComment(repo, pr.number, comment), "Comentario publicado").then(() => setComment(""))}
              >
                Comentar
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "files" && (
        <section className="doc-section">
          {diff === null && <Spinner />}
          {diff?.startsWith("error:") && <div className="editor-message">{diff}</div>}
          {files.map((f) => (
            <div key={f.file} className={`diff-card${collapsed[f.file] ? " collapsed" : ""}`}>
              <button type="button" className="diff-card-head" onClick={() => setCollapsed((c) => ({ ...c, [f.file]: !c[f.file] }))}>
                <Icon name={collapsed[f.file] ? "chevron-right" : "chevron-down"} />
                <FileIcon path={f.file} />
                <span className="diff-card-name">{basename(f.file)}</span>
                <span className="diff-card-dir">{dirname(f.file) === f.file ? "" : dirname(f.file)}</span>
                <span className="toolbar-spacer" />
                <span className={`status-tag ${f.status}`}>{f.status}</span>
                <span className="add">+{f.additions}</span>
                <span className="del">−{f.deletions}</span>
              </button>
              {!collapsed[f.file] && <DiffRows patch={f.patch} file={f.file} split maxRows={1200} />}
            </div>
          ))}
        </section>
      )}

      {tab === "checks" && (
        <section className="doc-section">
          {checks.length === 0 && <em className="muted">Sin checks</em>}
          <div className="checks">
            {checks.map((c, i) => {
              const s = checkState(c)
              const url = c.detailsUrl ?? c.targetUrl
              return (
                <div key={i} className={`check-row ${s}`}>
                  <Icon name={CHECK_ICON[s]} spin={s === "pending"} />
                  <span className="check-name">{c.name ?? c.context}</span>
                  <span className="check-workflow">{c.workflowName}</span>
                  <span className="toolbar-spacer" />
                  {url && (
                    <button type="button" className="btn btn-xs" onClick={() => void openUrl(url)}>
                      Detalles
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

export function PrCreateEditor({ repo }: { repo: string }) {
  const branch = useGit((s) => s.byRepo[repo]?.status?.branch ?? "")
  const [base, setBase] = useState("")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [draft, setDraft] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [creating, setCreating] = useState(false)
  const [preview, setPreview] = useState(false)

  useEffect(() => {
    gitDefaultBranch(repo)
      .then((b) => setBase(b.replace(/^origin\//, "")))
      .catch(() => setBase("main"))
  }, [repo])

  const generate = async () => {
    setGenerating(true)
    try {
      const out = await generatePullRequest(repo, base.includes("/") ? base : `origin/${base}`)
      setTitle(out.title)
      setBody(out.body)
    } catch (e) {
      notify.error("No se pudo generar la descripción", errorMessage(e))
    } finally {
      setGenerating(false)
    }
  }

  const create = async () => {
    setCreating(true)
    try {
      await withProgress("Subiendo la rama", () => gitPush(repo))
      const url = await withProgress("Creando el PR", () => prCreate(repo, title, body, base, draft), "PR creado")
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1])
      removeTabs((t) => t.input.kind === "prCreate")
      if (number) openEditor({ kind: "pr", repo, number })
      bumpHead()
      await refreshAllRepos()
    } catch {
      return
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="doc-page pr-create">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="git-pull-request-create" /> Nuevo pull request
        </div>
        <div className="branch-flow big">
          <code>{branch || "…"}</code>
          <Icon name="arrow-right" />
          <input className="input input-sm" value={base} onChange={(e) => setBase(e.target.value)} placeholder="rama base" />
        </div>
      </header>
      <section className="doc-section form">
        <div className="form-row">
          <input className="input input-lg" placeholder="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={generating || !base} onClick={() => void generate()}>
            {generating ? <Spinner size={12} /> : <Icon name="sparkle" />} Generar con IA
          </button>
        </div>
        <div className="md-editor">
          <div className="md-editor-tabs">
            <button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>
              Escribir
            </button>
            <button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>
              Vista previa
            </button>
          </div>
          {preview ? (
            <div className="md-preview">{body ? <Markdown text={body} /> : <em className="muted">Nada para previsualizar</em>}</div>
          ) : (
            <textarea placeholder="Descripción en markdown" value={body} onChange={(e) => setBody(e.target.value)} rows={16} />
          )}
        </div>
        <div className="form-row">
          <label className="checkbox">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Crear como borrador
          </label>
          <span className="toolbar-spacer" />
          <button type="button" className="btn btn-primary" disabled={!title.trim() || creating || !branch} onClick={() => void create()}>
            {creating ? <Spinner size={12} /> : <Icon name="git-pull-request-create" />} Push y crear PR
          </button>
        </div>
      </section>
    </div>
  )
}
