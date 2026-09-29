import { useCallback, useEffect, useState } from "react"
import { ghStatus, prList, type GhStatus, type PrSummary } from "../lib/gh"
import { errorMessage } from "../lib/tauri"
import { shortAgo } from "../lib/time"
import { basename } from "../lib/paths"
import { useGit } from "../state/git"
import { openEditor } from "../state/editors"
import { runInTerminal } from "../state/terminals"
import { EmptyState, Icon, IconButton, Spinner } from "../components/ui"

const CHECK_ICON: Record<string, string> = { success: "pass-filled", failure: "error", pending: "loading" }

export function PullRequestsView() {
  const repo = useGit((s) => s.activeRepo)
  const branch = useGit((s) => (s.activeRepo ? s.byRepo[s.activeRepo]?.status?.branch : undefined))
  const [gh, setGh] = useState<GhStatus | null>(null)
  const [state, setState] = useState<"open" | "closed" | "merged" | "all">("open")
  const [prs, setPrs] = useState<PrSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    ghStatus(repo)
      .then((status) => !cancelled && setGh(status))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [repo])

  const authenticated = !!gh?.authenticated
  const load = useCallback(async () => {
    if (!repo || !authenticated) return
    setLoading(true)
    try {
      setPrs(await prList(repo, state))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [repo, state, authenticated])

  useEffect(() => {
    void load()
  }, [load])

  if (!repo)
    return (
      <div className="view">
        <div className="view-header">
          <span className="view-title">Pull requests</span>
        </div>
        <EmptyState icon="git-pull-request" title="Abrí un repo git para ver sus PRs" />
      </div>
    )

  const isMine = (p: PrSummary) => p.headRefName === branch && !p.isCrossRepository
  const mine = prs?.find(isMine)

  return (
    <div className="view prs-view">
      <div className="view-header">
        <span className="view-title">Pull requests · {basename(repo)}</span>
        <span className="view-actions">
          {loading && <Spinner size={12} />}
          <IconButton icon="git-pull-request-create" title="Nuevo pull request" onClick={() => openEditor({ kind: "prCreate", repo })} />
          <IconButton icon="refresh" title="Refrescar" onClick={() => void load()} />
        </span>
      </div>
      {gh && !gh.installed && (
        <EmptyState
          icon="github"
          title="Falta el CLI de GitHub"
          action={
            <button type="button" className="btn btn-primary" onClick={() => void runInTerminal("winget install --id GitHub.cli")}>
              Instalar gh
            </button>
          }
        >
          GuilleCode usa <code>gh</code> con tu propia cuenta: no guarda tokens.
        </EmptyState>
      )}
      {gh && gh.installed && !gh.authenticated && (
        <EmptyState
          icon="github"
          title="Iniciá sesión en GitHub"
          action={
            <button type="button" className="btn btn-primary" onClick={() => void runInTerminal("gh auth login")}>
              gh auth login
            </button>
          }
        >
          Se abre en la terminal integrada.
        </EmptyState>
      )}
      {gh?.authenticated && (
        <>
          <div className="segmented">
            {(["open", "merged", "closed", "all"] as const).map((s) => (
              <button key={s} type="button" className={state === s ? "active" : ""} onClick={() => setState(s)}>
                {s === "open" ? "Abiertos" : s === "merged" ? "Mergeados" : s === "closed" ? "Cerrados" : "Todos"}
              </button>
            ))}
          </div>
          {branch && !mine && state === "open" && prs && (
            <button type="button" className="pr-cta" onClick={() => openEditor({ kind: "prCreate", repo })}>
              <Icon name="git-pull-request-create" />
              <span>
                Crear PR para <code>{branch}</code>
              </span>
            </button>
          )}
          {error && <div className="view-error">{error}</div>}
          <div className="pr-list">
            {prs?.length === 0 && <div className="view-note">No hay PRs {state === "open" ? "abiertos" : ""}</div>}
            {prs?.map((pr) => (
              <button key={pr.number} type="button" className={`pr-row${isMine(pr) ? " current" : ""}`} onClick={() => openEditor({ kind: "pr", repo, number: pr.number })}>
                <Icon
                  name={pr.state === "MERGED" ? "git-merge" : pr.state === "CLOSED" ? "git-pull-request-closed" : pr.isDraft ? "git-pull-request-draft" : "git-pull-request"}
                  className={`pr-icon ${pr.state.toLowerCase()}${pr.isDraft ? " draft" : ""}`}
                />
                <span className="pr-main">
                  <span className="pr-title">{pr.title}</span>
                  <span className="pr-meta">
                    #{pr.number} · {pr.author} · {shortAgo(Date.parse(pr.updatedAt))}
                    {isMine(pr) && <span className="pill">tu rama</span>}
                  </span>
                </span>
                {pr.checks && <Icon name={CHECK_ICON[pr.checks]} spin={pr.checks === "pending"} className={`pr-checks ${pr.checks}`} />}
                {pr.reviewDecision === "APPROVED" && <Icon name="check" className="pr-approved" title="Aprobado" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
