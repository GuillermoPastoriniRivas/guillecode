import { create } from "zustand"
import { reviewCode, type RawFinding } from "../lib/ai"
import { gitChangesContext } from "../lib/git"
import { prDiff } from "../lib/gh"
import { basename, joinPath, normalizePath, relativePath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { modelKey } from "../lib/opencode"
import { currentModelInfo, useAgent } from "./agent"
import { openEditor, tabId, type EditorInput } from "./editors"
import { useProject } from "./project"

export type Severity = "alta" | "media" | "baja"

export type Finding = {
  id: string
  file: string
  path: string | null
  line: number | null
  severity: Severity
  title: string
  detail: string
  suggestion: string
}

export type ReviewRun = {
  status: "running" | "done" | "error"
  startedAt: number
  finishedAt: number | null
  summary: string
  findings: Finding[]
  error: string | null
  model: string
  truncated: boolean
}

type AiReviewState = { runs: Record<string, ReviewRun>; dismissed: Record<string, true> }

export const useAiReview = create<AiReviewState>(() => ({ runs: {}, dismissed: {} }))

export type AiReviewInput = Extract<EditorInput, { kind: "aiReview" }>

const SEVERITY_ORDER: Record<Severity, number> = { alta: 0, media: 1, baja: 2 }
const MAX_PR_DIFF_CHARS = 160_000

function severityOf(value: unknown): Severity {
  const s = String(value ?? "").toLowerCase()
  if (s.startsWith("alt") || s === "high" || s === "critical") return "alta"
  if (s.startsWith("baj") || s === "low") return "baja"
  return "media"
}

function toFindings(key: string, repo: string, raw: RawFinding[]): Finding[] {
  return raw
    .filter((f) => f && (f.title || f.detail))
    .map((f, i) => {
      const file = String(f.file ?? "")
        .trim()
        .replace(/^[ab]\//, "")
        .replace(/^\.\//, "")
      const line = Number(f.line)
      return {
        id: `${key}#${i}`,
        file,
        path: file ? normalizePath(joinPath(repo, file)) : null,
        line: Number.isFinite(line) && line > 0 ? Math.floor(line) : null,
        severity: severityOf(f.severity),
        title: String(f.title ?? "").trim() || "Problema",
        detail: String(f.detail ?? "").trim(),
        suggestion: String(f.suggestion ?? "").trim(),
      }
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

function repoLabel(repo: string): string {
  const root = useProject.getState().root
  const rel = root ? relativePath(root, repo) : ""
  return rel && rel !== "." ? rel : basename(repo)
}

async function buildPrompt(input: AiReviewInput): Promise<{ prompt: string; truncated: boolean }> {
  const header = `Repo: "${repoLabel(input.repo)}". Las rutas del diff son relativas a la raíz de ese repo.`
  if (input.scope === "pr" && input.number) {
    const raw = await prDiff(input.repo, input.number)
    if (!raw.trim()) throw new Error(`El PR #${input.number} no tiene cambios`)
    const truncated = raw.length > MAX_PR_DIFF_CHARS
    const diff = truncated ? raw.slice(0, MAX_PR_DIFF_CHARS) : raw
    return {
      prompt: [header, `Revisá el pull request #${input.number}${input.title ? ` ("${input.title}")` : ""}.`, "", `Diff${truncated ? " (recortado)" : ""}:`, diff].join("\n"),
      truncated,
    }
  }
  const ctx = await gitChangesContext(input.repo)
  if (!ctx.diff.trim() && ctx.untracked.length === 0) throw new Error("No hay cambios sin commitear para revisar")
  return {
    prompt: [
      header,
      "Revisá los cambios sin commitear (staged y sin stage, contra HEAD).",
      "",
      "Archivos:",
      ctx.stat || "(ninguno con diff)",
      ...(ctx.untracked.length ? ["", "Archivos nuevos sin trackear (no están en el diff; leelos si hace falta):", ...ctx.untracked] : []),
      "",
      `Diff${ctx.truncated ? " (recortado; leé los archivos si necesitás más)" : ""}:`,
      ctx.diff,
    ].join("\n"),
    truncated: ctx.truncated,
  }
}

export function reviewKey(input: AiReviewInput): string {
  return tabId(input)
}

export async function runAiReview(input: AiReviewInput): Promise<void> {
  const key = reviewKey(input)
  if (useAiReview.getState().runs[key]?.status === "running") return
  const agent = useAgent.getState()
  const model = currentModelInfo(agent)?.name ?? modelKey(agent.model)
  const dismissed = Object.fromEntries(Object.entries(useAiReview.getState().dismissed).filter(([id]) => !id.startsWith(`${key}#`)))
  useAiReview.setState((s) => ({
    dismissed,
    runs: {
      ...s.runs,
      [key]: { status: "running", startedAt: Date.now(), finishedAt: null, summary: "", findings: [], error: null, model, truncated: false },
    },
  }))
  const finish = (patch: Partial<ReviewRun>) =>
    useAiReview.setState((s) => {
      const run = s.runs[key]
      return run ? { runs: { ...s.runs, [key]: { ...run, ...patch, finishedAt: Date.now() } } } : {}
    })
  try {
    const { prompt, truncated } = await buildPrompt(input)
    const label = input.scope === "pr" ? `revisión PR #${input.number}` : "revisión de cambios"
    const result = await reviewCode(label, prompt)
    finish({ status: "done", summary: result.summary, findings: toFindings(key, input.repo, result.findings), truncated })
  } catch (e) {
    finish({ status: "error", error: errorMessage(e) })
  }
}

export function openAiReview(input: AiReviewInput): void {
  openEditor(input)
  const run = useAiReview.getState().runs[reviewKey(input)]
  if (!run || run.status === "error") void runAiReview(input)
}

export function dismissFinding(id: string): void {
  useAiReview.setState((s) => ({ dismissed: { ...s.dismissed, [id]: true } }))
}

export function findingsForPath(runs: Record<string, ReviewRun>, dismissed: Record<string, true>, path: string): Finding[] {
  const target = normalizePath(path).toLowerCase()
  const out: Finding[] = []
  for (const run of Object.values(runs)) {
    if (run.status !== "done") continue
    for (const f of run.findings) if (f.path && f.path.toLowerCase() === target && !dismissed[f.id]) out.push(f)
  }
  return out
}
