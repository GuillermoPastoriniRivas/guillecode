import { useEffect } from "react"
import {
  confirmDeleteRoutine,
  openRoutine,
  runRoutineNow,
  runStatusLabel,
  scheduleLabel,
  setRoutineEnabled,
  startRoutines,
  useRoutines,
  type Routine,
} from "../state/routines"
import { basename } from "../lib/paths"
import { clockTime, shortAgo } from "../lib/time"
import { openContextMenu } from "../components/ContextMenu"
import { EmptyState, Icon, IconButton } from "../components/ui"

function RoutineRow({ routine }: { routine: Routine }) {
  const last = routine.runs[0]
  const status = runStatusLabel(last)
  const running = last && !last.finishedAt
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: "Correr ahora", icon: "play", disabled: !!running, run: () => void runRoutineNow(routine.id) },
      {
        label: routine.enabled ? "Pausar" : "Reanudar",
        icon: routine.enabled ? "debug-pause" : "debug-start",
        run: () => void setRoutineEnabled(routine.id, !routine.enabled),
      },
      { label: "Editar", icon: "edit", run: () => openRoutine(routine.id) },
      { separator: true },
      { label: "Eliminar", icon: "trash", danger: true, run: () => void confirmDeleteRoutine(routine) },
    ])
  return (
    <div className={`routine-row${routine.enabled ? "" : " paused"}`} onClick={() => openRoutine(routine.id)} onContextMenu={menu}>
      <span className={`routine-dot ${status.tone}`}>
        {running ? <Icon name="loading" spin /> : <Icon name={routine.enabled ? "calendar" : "debug-pause"} />}
      </span>
      <span className="routine-main">
        <span className="routine-name">{routine.name}</span>
        <span className="routine-sub">
          {scheduleLabel(routine.schedule)} · {basename(routine.project)}
        </span>
        <span className="routine-sub">
          {!routine.enabled ? "Pausada" : routine.nextRun ? `Próxima: ${clockTime(routine.nextRun)}` : ""}
          {last ? ` · ${status.label} ${shortAgo(last.startedAt)}` : ""}
        </span>
      </span>
      <span className="routine-actions" onClick={(e) => e.stopPropagation()}>
        <IconButton icon="play" title="Correr ahora" disabled={!!running} onClick={() => void runRoutineNow(routine.id)} />
      </span>
    </div>
  )
}

export function RoutinesView() {
  const items = useRoutines((s) => s.items)
  const loaded = useRoutines((s) => s.loaded)

  useEffect(() => {
    startRoutines()
  }, [])

  return (
    <div className="view routines-view">
      <div className="view-header">
        <span className="view-title">Rutinas</span>
        <span className="view-actions">
          <IconButton icon="add" title="Nueva rutina" onClick={() => openRoutine("new")} />
        </span>
      </div>
      {loaded && items.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="Sin rutinas todavía"
          action={
            <button type="button" className="btn btn-sm btn-primary" onClick={() => openRoutine("new")}>
              <Icon name="add" /> Nueva rutina
            </button>
          }
        >
          Una rutina le pide algo al agente en un horario fijo: un reporte, una revisión, un chequeo. Corre aunque cierres la ventana.
        </EmptyState>
      ) : (
        <div className="routine-list">
          {items.map((r) => (
            <RoutineRow key={r.id} routine={r} />
          ))}
        </div>
      )}
    </div>
  )
}
