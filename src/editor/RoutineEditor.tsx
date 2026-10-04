import { useEffect, useMemo, useState } from "react"
import {
  confirmDeleteRoutine,
  runRoutineNow,
  runStatusLabel,
  saveRoutine,
  scheduleLabel,
  setRoutineEnabled,
  startRoutines,
  useRoutines,
  WEEKDAYS,
  type Routine,
  type RoutineDraft,
  type RoutineRun,
  type Schedule,
} from "../state/routines"
import { selectSession, toggleFavoriteModel, useAgent, variantLabel } from "../state/agent"
import { openEditor, removeTabs, tabId } from "../state/editors"
import { openProject, useProject } from "../state/project"
import { useLayout } from "../state/layout"
import { pickOne } from "../state/quickinput"
import { Markdown } from "../agent/Markdown"
import { Icon, Spinner } from "../components/ui"
import { Segmented, Select, Stepper, TimePicker, Toggle } from "../components/fields"
import { modelKey, rememberSessionDirectory } from "../lib/opencode"
import { findFeature, useFeatures } from "../state/features"
import { basename, samePath } from "../lib/paths"
import { clockTime, formatDateTime } from "../lib/time"

const EXAMPLE = [
  "Revisá los costos de AWS de la última semana con `aws ce get-cost-and-usage` y compará contra la semana anterior.",
  "Si algún servicio subió más de 20 %, explicá por qué con lo que sepas del proyecto.",
  "Terminá con un resumen de 5 líneas y, si hay algo que hacer, una lista de acciones.",
].join(" ")

function emptyDraft(project: string): RoutineDraft {
  const s = useAgent.getState()
  return {
    id: "",
    name: "",
    project,
    prompt: "",
    schedule: { kind: "weekly", days: [0, 1, 2, 3, 4], time: "09:00" },
    agent: s.agentName || "build",
    model: { providerID: s.model.providerID, modelID: s.model.modelID },
    variant: null,
    enabled: true,
  }
}

function toDraft(r: Routine): RoutineDraft {
  return {
    id: r.id,
    name: r.name,
    project: r.project,
    prompt: r.prompt,
    schedule: r.schedule,
    agent: r.agent,
    model: r.model,
    variant: r.variant,
    enabled: r.enabled,
  }
}

function duration(run: RoutineRun): string {
  if (!run.finishedAt) return "en curso"
  const secs = Math.round((run.finishedAt - run.startedAt) / 1000)
  return secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`
}

function RunCard({ run, project }: { run: RoutineRun; project: string }) {
  const root = useProject((s) => s.root)
  const status = runStatusLabel(run)
  const sameProject = !!root && samePath(root, project)
  const openSession = () => {
    if (!run.sessionId) return
    if (!sameProject) {
      if (findFeature(project)) {
        rememberSessionDirectory(run.sessionId, project)
        useLayout.getState().toggleAgent(true)
        selectSession(run.sessionId)
        return
      }
      void openProject(project)
      return
    }
    useLayout.getState().toggleAgent(true)
    selectSession(run.sessionId)
  }
  return (
    <article className="routine-run">
      <header className="routine-run-head">
        <span className={`routine-pill ${status.tone}`}>{status.label}</span>
        <span>{formatDateTime(run.startedAt)}</span>
        <span className="routine-run-meta">
          {run.manual ? "manual" : "programada"} · {duration(run)}
        </span>
        <span className="toolbar-spacer" />
        {run.sessionId && (
          <button type="button" className="btn btn-xs" onClick={openSession}>
            <Icon name="comment-discussion" /> {sameProject ? "Abrir sesión" : `Abrir ${basename(project)}`}
          </button>
        )}
      </header>
      {run.error && (
        <div className="editor-banner warning">
          <Icon name="warning" />
          <span>{run.error}</span>
        </div>
      )}
      {run.summary && (
        <div className="routine-run-body">
          <Markdown text={run.summary} />
        </div>
      )}
    </article>
  )
}

const SCHEDULE_KINDS: Array<{ value: Schedule["kind"]; label: string }> = [
  { value: "interval", label: "Cada N horas" },
  { value: "daily", label: "Todos los días" },
  { value: "weekly", label: "Días de la semana" },
]

function ScheduleFields({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  const time = schedule.kind === "interval" ? "09:00" : schedule.time
  return (
    <div className="routine-schedule">
      <Segmented
        value={schedule.kind}
        options={SCHEDULE_KINDS}
        onChange={(kind) => {
          if (kind === schedule.kind) return
          if (kind === "interval") onChange({ kind, hours: 6 })
          else if (kind === "daily") onChange({ kind, time })
          else onChange({ kind, days: [0, 1, 2, 3, 4], time })
        }}
      />
      <div className="routine-schedule-detail">
        {schedule.kind === "interval" ? (
          <Stepper value={schedule.hours} min={1} max={168} suffix={schedule.hours === 1 ? "hora" : "horas"} onChange={(hours) => onChange({ kind: "interval", hours })} />
        ) : (
          <span className="routine-inline">
            a las
            <TimePicker value={schedule.time} onChange={(t) => onChange({ ...schedule, time: t })} />
          </span>
        )}
        {schedule.kind === "weekly" && (
          <div className="routine-days">
            {WEEKDAYS.map((d, i) => {
              const on = schedule.days.includes(i)
              return (
                <button
                  key={d}
                  type="button"
                  className={`routine-day${on ? " on" : ""}`}
                  onClick={() => {
                    const days = on ? schedule.days.filter((x) => x !== i) : [...schedule.days, i]
                    onChange({ ...schedule, days: days.length ? days : [i] })
                  }}
                >
                  {d}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function RoutineForm({ routine }: { routine: Routine | null }) {
  const root = useProject((s) => s.root)
  const recent = useProject((s) => s.recent)
  const models = useAgent((s) => s.models)
  const agents = useAgent((s) => s.agents)
  const favoriteModels = useAgent((s) => s.favoriteModels)
  const [draft, setDraft] = useState<RoutineDraft>(() => (routine ? toDraft(routine) : emptyDraft(root ?? "")))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<RoutineDraft>) => setDraft((d) => ({ ...d, ...patch }))

  const featureList = useFeatures((s) => s.list)
  const projects = useMemo(() => {
    const features = (featureList?.features ?? []).filter((f) => !f.missing && !f.archived).map((f) => f.root)
    const list = [...(root ? [root] : []), ...features, ...recent, ...(draft.project ? [draft.project] : [])]
    return list.filter((p, i) => list.findIndex((q) => samePath(p, q)) === i)
  }, [root, recent, draft.project, featureList])
  const projectLabel = (p: string) => {
    const feature = findFeature(p, featureList)
    if (!feature) return basename(p)
    return feature.kind === "main" ? `${basename(p)} · principal` : `${basename(featureList?.project ?? p)} · ${feature.label}`
  }

  const modelInfo = draft.model ? models.find((m) => m.providerID === draft.model!.providerID && m.modelID === draft.model!.modelID) : undefined
  const last = routine?.runs[0]
  const running = !!last && !last.finishedAt

  const chooseModel = async () => {
    const current = draft.model ? modelKey(draft.model) : ""
    const item = await pickOne(
      models
        .map((m) => {
          const key = modelKey(m)
          return {
            id: key,
            label: m.name,
            description: m.providerName,
            icon: key === current ? "check" : "circle-small",
            favorite: favoriteModels.includes(key),
            onToggleFavorite: () => toggleFavoriteModel(key),
          }
        })
        .sort((a, b) => Number(b.favorite) - Number(a.favorite)),
      { title: "Modelo de la rutina", placeholder: "Buscar modelo", favorites: true },
    )
    if (!item) return
    const [providerID, ...rest] = item.id.split("/")
    set({ model: { providerID, modelID: rest.join("/") }, variant: null })
  }

  const save = async () => {
    setSaving(true)
    const saved = await saveRoutine({ ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() })
    setSaving(false)
    if (saved && !routine) {
      const draftTab = tabId({ kind: "routine", id: "new" })
      openEditor({ kind: "routine", id: saved.id })
      removeTabs((t) => t.id === draftTab)
    }
  }

  const canSave = !!draft.name.trim() && !!draft.prompt.trim() && !!draft.project && !saving

  return (
    <div className="doc-page routine-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="calendar" /> Rutina programada
        </div>
        <h1>{routine ? routine.name : "Nueva rutina"}</h1>
        {routine && (
          <div className="doc-meta">
            <span>{scheduleLabel(routine.schedule)}</span>
            <span>{routine.enabled ? (routine.nextRun ? `próxima: ${formatDateTime(routine.nextRun)}` : "") : "pausada"}</span>
            {last && <span className={`routine-pill ${runStatusLabel(last).tone}`}>{runStatusLabel(last).label}</span>}
          </div>
        )}
        <div className="doc-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={!canSave} onClick={() => void save()}>
            <Icon name={saving ? "loading" : "save"} spin={saving} /> Guardar
          </button>
          {routine && (
            <>
              <button type="button" className="btn btn-sm" disabled={running} onClick={() => void runRoutineNow(routine.id)}>
                <Icon name="play" /> Correr ahora
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void setRoutineEnabled(routine.id, !routine.enabled)}>
                <Icon name={routine.enabled ? "debug-pause" : "debug-start"} /> {routine.enabled ? "Pausar" : "Reanudar"}
              </button>
              <span className="toolbar-spacer" />
              <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => void confirmDeleteRoutine(routine)}>
                <Icon name="trash" /> Eliminar
              </button>
            </>
          )}
        </div>
      </header>
      <section className="doc-section routine-form">
        <label className="routine-field">
          <span className="routine-label">Nombre</span>
          <input className="input" value={draft.name} placeholder="Reporte semanal de costos de AWS" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="routine-field">
          <span className="routine-label">Proyecto</span>
          <Select
            className="routine-select-wide"
            icon="root-folder"
            value={draft.project}
            options={projects.map((p) => ({ value: p, label: projectLabel(p), description: p }))}
            onChange={(project) => set({ project })}
          />
        </div>
        <div className="routine-field">
          <span className="routine-label">Cuándo</span>
          <ScheduleFields schedule={draft.schedule} onChange={(schedule) => set({ schedule })} />
        </div>
        <label className="routine-field">
          <span className="routine-label">Instrucciones</span>
          <textarea
            className="input routine-prompt"
            rows={9}
            value={draft.prompt}
            placeholder={EXAMPLE}
            onChange={(e) => set({ prompt: e.target.value })}
          />
          <span className="routine-hint">
            El agente trabaja en la carpeta del proyecto con las mismas herramientas que en el chat: terminal (git, gh, AWS CLI), web y memoria. Si pide un permiso, te aviso.
          </span>
        </label>
        <div className="routine-row-fields">
          <div className="routine-field">
            <span className="routine-label">Modelo</span>
            <button type="button" className="select-trigger" onClick={() => void chooseModel()}>
              <Icon name="sparkle" className="select-lead" />
              <span className="select-value">{modelInfo?.name ?? draft.model?.modelID ?? "El del chat"}</span>
              <Icon name="chevron-down" className="select-chevron" />
            </button>
          </div>
          {modelInfo && modelInfo.variants.length > 0 && (
            <div className="routine-field">
              <span className="routine-label">Esfuerzo</span>
              <Select
                icon="lightbulb"
                value={draft.variant ?? ""}
                options={[
                  { value: "", label: "Automático", description: "Lo que usa el modelo por defecto" },
                  ...modelInfo.variants.map((v) => ({ value: v, label: variantLabel(v) })),
                ]}
                onChange={(v) => set({ variant: v || null })}
              />
            </div>
          )}
          <div className="routine-field">
            <span className="routine-label">Agente</span>
            <Select
              icon="hubot"
              value={draft.agent ?? ""}
              options={agents.map((a) => ({ value: a.name, label: a.name, description: a.description }))}
              onChange={(agent) => set({ agent: agent || null })}
            />
          </div>
          <div className="routine-field">
            <span className="routine-label">Estado</span>
            <Toggle checked={draft.enabled} onChange={(enabled) => set({ enabled })} label={draft.enabled ? "Activa" : "Pausada"} />
          </div>
        </div>
      </section>
      {routine && routine.runs.length > 0 && (
        <section className="doc-section">
          <div className="doc-section-title">Últimas corridas</div>
          {routine.runs.map((run) => (
            <RunCard key={run.id} run={run} project={routine.project} />
          ))}
        </section>
      )}
      {routine && running && last?.startedAt && (
        <div className="routine-running-note">
          <Spinner size={12} /> Corriendo desde las {clockTime(last.startedAt)}
        </div>
      )}
    </div>
  )
}

export function RoutineEditor({ id }: { id: string }) {
  const routine = useRoutines((s) => (id === "new" ? null : (s.items.find((r) => r.id === id) ?? null)))
  const loaded = useRoutines((s) => s.loaded)

  useEffect(() => {
    startRoutines()
  }, [])

  if (id !== "new" && !loaded)
    return (
      <div className="editor-overlay">
        <Spinner />
      </div>
    )
  if (id !== "new" && !routine) return <div className="editor-message center">Esta rutina ya no existe.</div>
  return <RoutineForm key={routine?.id ?? "new"} routine={routine} />
}
