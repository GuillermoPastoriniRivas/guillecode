import { useCallback, useEffect, useState } from "react"
import { call, isTauri } from "../lib/tauri"
import { useProject } from "../state/project"
import { focusComposer, newSession } from "../state/agent"
import { useLayout } from "../state/layout"
import { notify } from "../state/toasts"
import { Icon } from "../components/ui"

type Note = { id: string; title: string; kind: string; updated: string; preview: string }
type Task = { id: string; title: string; updated: string; directory: string; progress: string; lastUser: string }
type Overview = { scope: string; slug: string; preferences: string; overview: string; notes: Note[]; tasks: Task[] }

type View = "tasks" | "notes" | "preferences" | "overview"

const EMPTY: Overview = { scope: "", slug: "", preferences: "", overview: "", notes: [], tasks: [] }

function when(value: string): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function MemoryEditor() {
  const root = useProject((s) => s.root)
  const [data, setData] = useState<Overview>(EMPTY)
  const [view, setView] = useState<View>("tasks")
  const [error, setError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState("")
  const [overview, setOverview] = useState("")
  const [openNote, setOpenNote] = useState<{ id: string; title: string; kind: string; body: string } | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [draftKind, setDraftKind] = useState("decision")
  const [draftBody, setDraftBody] = useState("")

  const load = useCallback(async () => {
    if (!isTauri) return
    try {
      const next = await call<Overview>("memory_overview", { scope: root ?? "" })
      setData(next)
      setPrefs(next.preferences)
      setOverview(next.overview)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [root])

  useEffect(() => {
    void load()
  }, [load])

  const savePrefs = async () => {
    await call("memory_write_preferences", { body: prefs })
    notify.success("Preferencias guardadas")
    void load()
  }

  const saveOverview = async () => {
    await call("memory_write_overview", { scope: root ?? "", body: overview })
    notify.success("Descripción del proyecto guardada")
    void load()
  }

  const openEntry = async (id: string) => {
    const result = await call<{ path?: string; content?: string; error?: string }>("memory_read_note", { id })
    if (result.error || typeof result.content !== "string") {
      notify.error("No se pudo abrir")
      return
    }
    const body = result.content.replace(/^---[\s\S]*?\n---\n?/, "").trim()
    const title = result.content.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? id
    const kind = result.content.match(/^type:\s*(.+)$/m)?.[1]?.trim() ?? "nota"
    setOpenNote({ id, title, kind, body })
  }

  const saveNote = async () => {
    if (!draftTitle.trim()) return
    await call("memory_write_note", { scope: root ?? "", title: draftTitle, body: draftBody, kind: draftKind })
    notify.success("Nota guardada")
    setDraftTitle("")
    setDraftBody("")
    void load()
  }

  const saveOpenNote = async () => {
    if (!openNote) return
    await call("memory_write_note", { scope: root ?? "", title: openNote.title, body: openNote.body, kind: openNote.kind })
    notify.success("Nota actualizada")
    setOpenNote(null)
    void load()
  }

  const removeNote = async (id: string) => {
    await call("memory_delete_note", { id })
    if (openNote?.id === id) setOpenNote(null)
    notify.info("Nota eliminada")
    void load()
  }

  const continueTask = (task: Task) => {
    const prompt = [
      `Continuá con el trabajo «${task.title || task.id}».`,
      task.lastUser ? `\nÚltimo pedido: ${task.lastUser}` : "",
      task.progress ? `\n\nProgreso previo:\n${task.progress}` : "",
      "\n\nSeguí desde el próximo paso pendiente. Confirmá qué falta antes de cambiar de dirección.",
    ].join("")
    useLayout.getState().toggleAgent(true)
    newSession()
    focusComposer(prompt)
  }

  if (!isTauri) {
    return <div className="memory-editor"><p className="memory-empty">La memoria está disponible solo en la app de escritorio.</p></div>
  }

  return (
    <div className="memory-editor">
      <header className="memory-head">
        <div className="memory-title">
          <Icon name="library" />
          <div>
            <strong>Memoria de GuilleCode</strong>
            <small>{data.slug ? `${data.slug} · guardada solo en esta PC` : "local, sin servicios externos"}</small>
          </div>
        </div>
        <button type="button" className="btn" onClick={() => void load()} title="Recargar">
          <Icon name="refresh" />
        </button>
      </header>

      {error && <div className="memory-error">{error}</div>}

      <nav className="memory-tabs">
        {(["tasks", "notes", "overview", "preferences"] as View[]).map((id) => (
          <button key={id} type="button" className={view === id ? "active" : ""} onClick={() => setView(id)}>
            {id === "tasks" ? `Trabajos (${data.tasks.length})` : id === "notes" ? `Notas (${data.notes.length})` : id === "overview" ? "Proyecto" : "Preferencias"}
          </button>
        ))}
      </nav>

      <div className="memory-body">
        {view === "tasks" && (
          <>
            <p className="memory-hint">Cada conversación deja acá su estado. «Continuar» abre un chat nuevo con ese contexto, sin importar el modelo.</p>
            {data.tasks.length === 0 && <p className="memory-empty">Todavía no hay trabajos. Van a aparecer al terminar cada turno del agente.</p>}
            {data.tasks.map((task) => (
              <div key={task.id} className="memory-card">
                <div className="memory-card-head">
                  <strong>{task.title || task.id}</strong>
                  <span className="memory-when">{when(task.updated)}</span>
                </div>
                {task.lastUser && <p className="memory-line"><b>Pedido:</b> {task.lastUser.slice(0, 220)}</p>}
                {task.progress && <p className="memory-line">{task.progress.slice(0, 320)}</p>}
                <div className="memory-card-actions">
                  <button type="button" className="btn primary" onClick={() => continueTask(task)}>
                    <Icon name="debug-start" /> Continuar en un chat nuevo
                  </button>
                  <button type="button" className="btn" onClick={() => void openEntry(task.id)}>
                    <Icon name="go-to-file" /> Ver estado
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {view === "notes" && (
          <>
            {openNote ? (
              <div className="memory-card">
                <input className="memory-input" value={openNote.title} onChange={(e) => setOpenNote({ ...openNote, title: e.target.value })} />
                <textarea className="memory-textarea" value={openNote.body} onChange={(e) => setOpenNote({ ...openNote, body: e.target.value })} />
                <div className="memory-card-actions">
                  <button type="button" className="btn primary" onClick={() => void saveOpenNote()}>
                    <Icon name="save" /> Guardar
                  </button>
                  <button type="button" className="btn" onClick={() => setOpenNote(null)}>Cerrar</button>
                </div>
              </div>
            ) : (
              <>
                <div className="memory-card">
                  <div className="memory-new">
                    <input className="memory-input" placeholder="Título de la nota" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
                    <select className="memory-input" value={draftKind} onChange={(e) => setDraftKind(e.target.value)}>
                      <option value="decision">Decisión</option>
                      <option value="convencion">Convención</option>
                      <option value="gotcha">Gotcha</option>
                      <option value="failure">Intento fallido</option>
                      <option value="nota">Nota</option>
                    </select>
                  </div>
                  <textarea className="memory-textarea" placeholder="Qué decidiste, por qué, y qué debería saber el próximo agente." value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
                  <div className="memory-card-actions">
                    <button type="button" className="btn primary" disabled={!draftTitle.trim()} onClick={() => void saveNote()}>
                      <Icon name="add" /> Agregar nota
                    </button>
                  </div>
                </div>
                {data.notes.length === 0 && <p className="memory-empty">No hay notas todavía.</p>}
                {data.notes.map((note) => (
                  <div key={note.id} className="memory-card">
                    <div className="memory-card-head">
                      <strong>{note.title}</strong>
                      <span className="memory-kind">{note.kind}</span>
                      <span className="memory-when">{when(note.updated)}</span>
                    </div>
                    {note.preview && <p className="memory-line">{note.preview}</p>}
                    <div className="memory-card-actions">
                      <button type="button" className="btn" onClick={() => void openEntry(note.id)}>
                        <Icon name="go-to-file" /> Abrir
                      </button>
                      <button type="button" className="btn danger" onClick={() => void removeNote(note.id)}>
                        <Icon name="trash" />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {view === "overview" && (
          <div className="memory-card">
            <p className="memory-hint">Qué es este proyecto, su arquitectura y sus convenciones. Se inyecta al empezar cada conversación.</p>
            <textarea className="memory-textarea tall" value={overview} onChange={(e) => setOverview(e.target.value)} />
            <div className="memory-card-actions">
              <button type="button" className="btn primary" onClick={() => void saveOverview()}>
                <Icon name="save" /> Guardar
              </button>
            </div>
          </div>
        )}

        {view === "preferences" && (
          <div className="memory-card">
            <p className="memory-hint">Preferencias que valen para todos los proyectos (idioma, estilo, reglas).</p>
            <textarea className="memory-textarea tall" value={prefs} onChange={(e) => setPrefs(e.target.value)} />
            <div className="memory-card-actions">
              <button type="button" className="btn primary" onClick={() => void savePrefs()}>
                <Icon name="save" /> Guardar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
