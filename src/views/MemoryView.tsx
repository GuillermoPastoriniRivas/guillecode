import { useEffect } from "react"
import { Icon, IconButton } from "../components/ui"
import { isTauri } from "../lib/tauri"
import { useProject } from "../state/project"
import { loadMemory, openMemory, useMemory } from "../state/memory"

export function MemoryView() {
  const root = useProject((s) => s.root) ?? ""
  const data = useMemory((s) => s.data)
  const loaded = useMemory((s) => s.loaded)
  const error = useMemory((s) => s.error)

  useEffect(() => {
    const refresh = () => void loadMemory(root)
    refresh()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [root])

  return (
    <div className="view memory-view">
      <div className="view-header">
        <span className="view-title">Memoria</span>
        <span className="view-actions">
          <IconButton icon="add" title="Nueva nota de memoria" onClick={() => openMemory("notes")} />
          <IconButton icon="refresh" title="Actualizar memoria" onClick={() => void loadMemory(root)} />
        </span>
      </div>
      {!isTauri ? <p className="view-note">La memoria está disponible solo en la app de escritorio.</p> : (
        <>
          <p className="view-note">Guardada solo en esta PC. Abrí una entrada para leerla, editarla o eliminarla.</p>
          {error && <div className="view-error">{error}</div>}
          <div className="memory-list">
            <button type="button" className="memory-nav-row" onClick={() => openMemory("preferences")}>
              <Icon name="settings-gear" /><span>Preferencias globales</span>
            </button>
            <button type="button" className="memory-nav-row" onClick={() => openMemory("overview")}>
              <Icon name="root-folder" /><span>Descripción del proyecto</span>
            </button>
            <button type="button" className="memory-nav-row memory-section-row" onClick={() => openMemory("notes")}>
              <Icon name="note" /><span>Notas y decisiones</span><span className="pane-count">{data.notes.length}</span>
            </button>
            {data.notes.map((note) => (
              <button key={note.id} type="button" className="memory-nav-row memory-entry-row" title={note.preview} onClick={() => openMemory("notes", { kind: "notes", id: note.id })}>
                <Icon name="file-text" /><span>{note.title}</span><Icon name={note.source === "user" ? "account" : "hubot"} className="memory-nav-origin" />
              </button>
            ))}
            {loaded && !data.notes.length && <p className="view-note">Todavía no hay notas.</p>}
            <button type="button" className="memory-nav-row memory-section-row" onClick={() => openMemory("tasks")}>
              <Icon name="history" /><span>Trabajos guardados</span><span className="pane-count">{data.tasks.length}</span>
            </button>
            {data.tasks.map((task) => (
              <button key={task.id} type="button" className="memory-nav-row memory-entry-row" title={task.progress} onClick={() => openMemory("tasks", { kind: "tasks", id: task.id })}>
                <Icon name="comment-discussion" /><span>{task.title || task.id}</span><Icon name={task.source === "user" ? "account" : "hubot"} className="memory-nav-origin" />
              </button>
            ))}
            {loaded && !data.tasks.length && <p className="view-note">Todavía no hay trabajos.</p>}
          </div>
        </>
      )}
    </div>
  )
}
