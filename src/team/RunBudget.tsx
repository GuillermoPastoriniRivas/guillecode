import { useState } from "react"
import { teamCall } from "../state/teams"
import type { RunLimits, TeamRun } from "./types"

export function RunBudget({ run }: { run: TeamRun }) {
  const [limits, setLimits] = useState<RunLimits>(run.team.limits ?? {})
  const [saving, setSaving] = useState(false)
  const change = (key: keyof RunLimits, value: string) => setLimits((v) => ({ ...v, [key]: value === "" ? null : Number(value) }))
  return <details className="team-card"><summary>Ajustar límites de esta ejecución</summary>
    <p className="team-note">Se conserva el uso acumulado y se registra el ajuste en el historial. La duración cuenta desde el inicio original. Dejá vacío para quitar un límite.</p>
    <div className="team-form-grid">
      <label>Duración máxima (minutos)<input type="number" min={1} max={1440} value={limits.maxRunMinutes ?? ""} onChange={(e) => change("maxRunMinutes", e.target.value)} /></label>
      <label>Presupuesto USD<input type="number" min={0.01} step={0.01} value={limits.maxCostUsd ?? ""} onChange={(e) => change("maxCostUsd", e.target.value)} /></label>
      <label>Límite de tokens<input type="number" min={1} value={limits.maxTokens ?? ""} onChange={(e) => change("maxTokens", e.target.value)} /></label>
    </div>
    <button className="btn btn-sm" disabled={saving} onClick={async () => { setSaving(true); await teamCall("team_runs_limits", { runId: run.id, limits }); setSaving(false) }}>Guardar límites</button>
  </details>
}
