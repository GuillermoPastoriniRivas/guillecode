import { useEffect, useMemo } from "react"
import {
  dismissFinding,
  reviewKey,
  runAiReview,
  useAiReview,
  type AiReviewInput,
  type Finding,
  type Severity,
} from "../state/aiReview"
import { addContext, focusComposer } from "../state/agent"
import { openFile } from "../state/editors"
import { useLayout } from "../state/layout"
import { Markdown } from "../agent/Markdown"
import { EmptyState, FileIcon, Icon, Spinner } from "../components/ui"
import { basename, dirname } from "../lib/paths"
import { timeAgo } from "../lib/time"

const SEVERITY_LABEL: Record<Severity, string> = { alta: "Alta", media: "Media", baja: "Baja" }

function fixWithAgent(f: Finding) {
  useLayout.getState().toggleAgent(true)
  if (f.path) addContext({ kind: "file", path: f.path })
  const where = f.file ? ` en \`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""
  const parts = [`Arreglá este problema que marcó la revisión${where}: ${f.title}.`]
  if (f.detail) parts.push(f.detail)
  if (f.suggestion) parts.push(`Sugerencia: ${f.suggestion}`)
  focusComposer(parts.join("\n\n"))
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <article className={`ai-finding sev-${finding.severity}`}>
      <header className="ai-finding-head">
        <span className={`ai-sev sev-${finding.severity}`}>{SEVERITY_LABEL[finding.severity]}</span>
        <strong className="ai-finding-title">{finding.title}</strong>
      </header>
      {finding.file && (
        <button
          type="button"
          className="ai-finding-file"
          disabled={!finding.path}
          onClick={() => finding.path && openFile(finding.path, finding.line ? { line: finding.line } : {})}
        >
          <FileIcon path={finding.file} />
          <span className="file-list-name">{basename(finding.file)}</span>
          {finding.line && <span className="ai-finding-line">:{finding.line}</span>}
          <span className="file-list-dir">{dirname(finding.file) === finding.file ? "" : dirname(finding.file)}</span>
        </button>
      )}
      {finding.detail && (
        <div className="ai-finding-body">
          <Markdown text={finding.detail} />
        </div>
      )}
      {finding.suggestion && (
        <div className="ai-finding-suggestion">
          <span className="ai-finding-label">Sugerencia</span>
          <Markdown text={finding.suggestion} />
        </div>
      )}
      <div className="ai-finding-actions">
        <button type="button" className="btn btn-xs btn-primary" onClick={() => fixWithAgent(finding)}>
          <Icon name="sparkle" /> Arreglar con el agente
        </button>
        <button type="button" className="btn btn-xs" onClick={() => dismissFinding(finding.id)}>
          Descartar
        </button>
      </div>
    </article>
  )
}

export function AiReviewEditor({ input }: { input: AiReviewInput }) {
  const key = reviewKey(input)
  const run = useAiReview((s) => s.runs[key])
  const dismissed = useAiReview((s) => s.dismissed)

  useEffect(() => {
    if (!useAiReview.getState().runs[key]) void runAiReview(input)
  }, [key, input])

  const visible = useMemo(() => (run?.findings ?? []).filter((f) => !dismissed[f.id]), [run, dismissed])
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { alta: 0, media: 0, baja: 0 }
    for (const f of visible) c[f.severity] += 1
    return c
  }, [visible])

  const subject = input.scope === "pr" ? `PR #${input.number}${input.title ? ` · ${input.title}` : ""}` : "Cambios sin commitear"
  const running = run?.status === "running"
  const title = !run || running
    ? "Revisando…"
    : run.status === "error"
      ? "La revisión falló"
      : visible.length === 0
        ? "Sin problemas para marcar"
        : `${visible.length} hallazgo${visible.length === 1 ? "" : "s"}`

  return (
    <div className="doc-page ai-review-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="sparkle" /> Revisión con IA · {subject}
        </div>
        <h1>{title}</h1>
        <div className="doc-meta">
          {run?.model && <span>{run.model}</span>}
          {run?.finishedAt && <span>{timeAgo(run.finishedAt)}</span>}
          {counts.alta > 0 && <span className="ai-sev sev-alta">{counts.alta} alta</span>}
          {counts.media > 0 && <span className="ai-sev sev-media">{counts.media} media</span>}
          {counts.baja > 0 && <span className="ai-sev sev-baja">{counts.baja} baja</span>}
          {run?.truncated && <span className="pill">diff recortado</span>}
        </div>
        <div className="doc-actions">
          <button type="button" className="btn btn-sm" disabled={running} onClick={() => void runAiReview(input)}>
            <Icon name="refresh" /> Volver a revisar
          </button>
        </div>
      </header>
      <section className="doc-section">
        {running && (
          <div className="ai-review-running">
            <Spinner size={16} />
            <span>El modelo está leyendo el diff y los archivos que necesita. Puede tardar uno o dos minutos.</span>
          </div>
        )}
        {run?.status === "error" && (
          <div className="editor-banner warning">
            <Icon name="warning" />
            <span>{run.error}</span>
          </div>
        )}
        {run?.status === "done" && run.summary && (
          <div className="ai-review-summary">
            <Markdown text={run.summary} />
          </div>
        )}
        {run?.status === "done" && visible.length === 0 && (
          <EmptyState icon="pass" title="No encontró problemas">
            La revisión no marca bugs ni riesgos en estos cambios.
          </EmptyState>
        )}
        {visible.map((f) => (
          <FindingCard key={f.id} finding={f} />
        ))}
      </section>
    </div>
  )
}
