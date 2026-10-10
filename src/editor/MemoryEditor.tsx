import { useCallback, useEffect, useRef, useState } from "react"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { useProject } from "../state/project"
import { focusComposer, newSession } from "../state/agent"
import { useLayout } from "../state/layout"
import { notify } from "../state/toasts"
import { deleteMemoryEntry, loadMemory, memoryEntryPath, useMemory, writeMemory, type MemoryEntry, type MemorySection, type MemoryTask } from "../state/memory"
import { confirmAction } from "../components/Dialog"
import { Icon } from "../components/ui"

const KINDS = { decision: "Decisión", convencion: "Convención", gotcha: "Gotcha", failure: "Intento fallido", nota: "Nota" }
type OpenNote = { id: string; title: string; kind: string; body: string; source: string }

function when(value: string): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function Origin({ source, edited }: { source: string; edited?: boolean }) {
  const user = source === "user"
  return (
    <span className={`memory-origin ${user ? "user" : "agent"}`} title={user ? "Lo escribiste o editaste vos" : "Lo escribió el agente"}>
      <Icon name={user ? "account" : "hubot"} /> {user ? "Vos" : "Agente"}{edited ? " (edición tuya)" : ""}
    </span>
  )
}

function Text({ value, empty }: { value: string; empty: string }) {
  return value.trim() ? <p className="memory-prose">{value}</p> : <p className="memory-empty">{empty}</p>
}

export function MemoryEditor() {
  const root = useProject((s) => s.root) ?? ""
  const data = useMemory((s) => s.data)
  const error = useMemory((s) => s.error)
  const request = useMemory((s) => s.request)
  const [view, setView] = useState<MemorySection>("tasks")
  const [prefs, setPrefs] = useState("")
  const [overview, setOverview] = useState("")
  const [openNote, setOpenNote] = useState<OpenNote | null>(null)
  const [openTask, setOpenTask] = useState<MemoryTask | null>(null)
  const [noteEditing, setNoteEditing] = useState(false)
  const [taskEditing, setTaskEditing] = useState(false)
  const [creatingNote, setCreatingNote] = useState(false)
  const [editingText, setEditingText] = useState<null | "overview" | "preferences">(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [draftKind, setDraftKind] = useState("decision")
  const [draftBody, setDraftBody] = useState("")
  const [busy, setBusy] = useState(false)
  const readVersion = useRef(0)

  const closeAll = useCallback(() => {
    setOpenNote(null)
    setOpenTask(null)
    setNoteEditing(false)
    setTaskEditing(false)
    setCreatingNote(false)
    setEditingText(null)
  }, [])

  useEffect(() => {
    closeAll()
    setDraftTitle("")
    setDraftBody("")
    void loadMemory(root)
    return () => { ++readVersion.current }
  }, [root, closeAll])

  useEffect(() => { setPrefs(data.preferences) }, [data.preferences, root])
  useEffect(() => { setOverview(data.overview) }, [data.overview, root])

  const openEntry = useCallback(async (entry: MemoryEntry) => {
    if (!data.slug || data.scope !== root) return null
    const version = ++readVersion.current
    setView(entry.kind)
    setOpenNote(null)
    setOpenTask(null)
    setNoteEditing(false)
    setTaskEditing(false)
    try {
      const result = await call<{ content?: string; error?: string }>("memory_read_note", { id: memoryEntryPath(data.slug, entry) })
      if (version !== readVersion.current) return null
      if (result.error || typeof result.content !== "string") throw new Error(result.error ?? "No se pudo abrir esta entrada")
      if (entry.kind === "tasks") {
        const task = JSON.parse(result.content)
        const full: MemoryTask = { id: entry.id, title: task.title ?? "", updated: task.updatedAt ?? "", directory: task.directory ?? root, progress: task.progress ?? "", lastUser: task.lastUser ?? "", source: task.source ?? "agent" }
        setOpenTask(full)
        return full
      }
      const meta = useMemory.getState().data.notes.find((note) => note.id === entry.id)
      const body = result.content.replace(/^---[\s\S]*?\n---\r?\n?/, "").trim()
      setOpenNote({ id: entry.id, title: meta?.title ?? entry.id, kind: meta?.kind ?? "nota", body, source: meta?.source ?? "agent" })
    } catch (e) {
      if (version === readVersion.current) notify.error(errorMessage(e))
    }
    return null
  }, [data.slug, data.scope, root])

  // Una petición nueva del sidebar también debe navegar una pestaña ya abierta.
  useEffect(() => {
    if (!request || request.scope !== root || !data.slug || data.scope !== root) return
    ++readVersion.current
    closeAll()
    setView(request.view)
    if (request.entry) void openEntry(request.entry)
  }, [request, data.slug, data.scope, root, openEntry, closeAll])

  const selectView = (next: MemorySection) => {
    ++readVersion.current
    closeAll()
    setView(next)
  }

  const save = async (command: string, args: Record<string, unknown>, message: string, done?: () => void) => {
    setBusy(true)
    try {
      await writeMemory(command, args)
      notify.success(message)
      done?.()
      await loadMemory(root)
    } catch (e) {
      notify.error(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
    return true
  }

  const removeEntry = async (entry: MemoryEntry, title: string) => {
    setBusy(true)
    try {
      if (await deleteMemoryEntry(entry, title)) {
        if (entry.kind === "notes" && openNote?.id === entry.id) setOpenNote(null)
        if (entry.kind === "tasks" && openTask?.id === entry.id) setOpenTask(null)
      }
    } finally {
      setBusy(false)
    }
  }

  const clearText = async (section: "preferences" | "overview") => {
    const prefs = section === "preferences"
    if (!(await confirmAction(prefs ? "Borrar preferencias globales" : "Borrar descripción del proyecto", prefs ? "Se borra el contenido de las preferencias para todos los proyectos." : "Se borra la descripción guardada de este proyecto.", "Borrar", true))) return
    if (await save(prefs ? "memory_write_preferences" : "memory_write_overview", prefs ? { body: "" } : { scope: root, body: "" }, "Contenido borrado", () => prefs ? setPrefs("") : setOverview(""))) setEditingText(null)
  }

  const continueTask = (task: MemoryTask) => {
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

  if (!isTauri) return <div className="memory-editor"><p className="memory-empty">La memoria está disponible solo en la app de escritorio.</p></div>

  return (
    <div className="memory-editor">
      <header className="memory-head">
        <div className="memory-title">
          <Icon name="library" />
          <div><strong>Memoria de GuilleCode</strong><small>{data.slug ? `${data.slug} · guardada solo en esta PC` : "local, sin servicios externos"}</small></div>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={() => void loadMemory(root)} title="Recargar"><Icon name="refresh" /></button>
      </header>
      {error && <div className="memory-error">{error}</div>}
      <nav className="memory-tabs">
        {(["tasks", "notes", "overview", "preferences"] as MemorySection[]).map((id) => (
          <button key={id} type="button" disabled={busy} className={view === id ? "active" : ""} onClick={() => selectView(id)}>
            {id === "tasks" ? `Trabajos (${data.tasks.length})` : id === "notes" ? `Notas (${data.notes.length})` : id === "overview" ? "Proyecto" : "Preferencias"}
          </button>
        ))}
      </nav>
      <div className="memory-body">
        {view === "tasks" && (openTask ? (
          <div className="memory-card">
            <div className="memory-card-head">
              <strong>{openTask.title || openTask.id}</strong>
              <Origin source={openTask.source} />
              <span className="memory-when">{when(openTask.updated)}</span>
            </div>
            {taskEditing ? (
              <>
                <label className="memory-hint">Título</label>
                <input aria-label="Título del trabajo" className="memory-input" value={openTask.title} onChange={(e) => setOpenTask({ ...openTask, title: e.target.value })} />
                <label className="memory-hint">Último pedido</label>
                <textarea aria-label="Último pedido" className="memory-textarea" value={openTask.lastUser} onChange={(e) => setOpenTask({ ...openTask, lastUser: e.target.value })} />
                <label className="memory-hint">Progreso guardado</label>
                <textarea aria-label="Progreso guardado" className="memory-textarea tall" value={openTask.progress} onChange={(e) => setOpenTask({ ...openTask, progress: e.target.value })} />
                <div className="memory-card-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save("memory_write_task", { scope: root, id: openTask.id, title: openTask.title, lastUser: openTask.lastUser, progress: openTask.progress }, "Trabajo actualizado", () => setTaskEditing(false))}><Icon name="save" /> Guardar</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setTaskEditing(false)}>Cancelar</button>
                </div>
              </>
            ) : (
              <>
                <p className="memory-hint">Estado guardado automáticamente al terminar cada turno de esa conversación. Podés corregirlo o eliminarlo si algo quedó mal.</p>
                <small className="memory-when">{openTask.directory}</small>
                <label className="memory-hint">Último pedido</label>
                <Text value={openTask.lastUser} empty="Sin pedido registrado." />
                <label className="memory-hint">Progreso</label>
                <Text value={openTask.progress} empty="Sin progreso registrado." />
                <div className="memory-card-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => continueTask(openTask)}><Icon name="debug-start" /> Continuar en un chat nuevo</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setTaskEditing(true)}><Icon name="edit" /> Editar</button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeEntry({ kind: "tasks", id: openTask.id }, openTask.title)}><Icon name="trash" /> Eliminar</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setOpenTask(null)}>Volver</button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="memory-hint">El agente guarda acá el estado de cada conversación. Solo mirá; si algo quedó mal, corregilo o eliminálo.</p>
            {data.tasks.length === 0 && <p className="memory-empty">Todavía no hay trabajos. Van a aparecer al terminar cada turno del agente.</p>}
            {data.tasks.map((task) => (
              <div key={task.id} className="memory-card">
                <div className="memory-card-head"><strong>{task.title || task.id}</strong><Origin source={task.source} /><span className="memory-when">{when(task.updated)}</span></div>
                {task.progress && <p className="memory-line">{task.progress}</p>}
                <div className="memory-card-actions">
                  <button type="button" className="btn" onClick={() => void openEntry({ kind: "tasks", id: task.id })}><Icon name="book" /> Ver estado</button>
                  <button type="button" className="btn" onClick={() => void openEntry({ kind: "tasks", id: task.id }).then((full) => { if (full) continueTask(full) })}><Icon name="debug-start" /> Continuar</button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeEntry({ kind: "tasks", id: task.id }, task.title)}><Icon name="trash" /> Eliminar</button>
                </div>
              </div>
            ))}
          </>
        ))}
        {view === "notes" && (openNote ? (
          <div className="memory-card">
            <div className="memory-card-head">
              <strong>{openNote.title}</strong>
              <span className="memory-kind">{KINDS[openNote.kind as keyof typeof KINDS] ?? openNote.kind}</span>
              <Origin source={openNote.source} />
            </div>
            {noteEditing ? (
              <>
                <input aria-label="Título de la nota" className="memory-input" value={openNote.title} onChange={(e) => setOpenNote({ ...openNote, title: e.target.value })} />
                <select aria-label="Tipo de nota" className="memory-input" value={openNote.kind} onChange={(e) => setOpenNote({ ...openNote, kind: e.target.value })}>{Object.entries(KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
                <textarea aria-label="Contenido de la nota" className="memory-textarea tall" value={openNote.body} onChange={(e) => setOpenNote({ ...openNote, body: e.target.value })} />
                <div className="memory-card-actions">
                  <button type="button" className="btn btn-primary" disabled={busy || !openNote.title.trim()} onClick={() => void save("memory_write_note", { scope: root, id: openNote.id, title: openNote.title, body: openNote.body, kind: openNote.kind }, "Nota actualizada", () => setNoteEditing(false))}><Icon name="save" /> Guardar</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setNoteEditing(false)}>Cancelar</button>
                </div>
              </>
            ) : (
              <>
                <Text value={openNote.body} empty="Esta nota no tiene contenido." />
                <div className="memory-card-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => setNoteEditing(true)}><Icon name="edit" /> Editar</button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeEntry({ kind: "notes", id: openNote.id }, openNote.title)}><Icon name="trash" /> Eliminar nota</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setOpenNote(null)}>Volver</button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="memory-card-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setCreatingNote(!creatingNote)}><Icon name={creatingNote ? "close" : "add"} /> {creatingNote ? "Cancelar" : "Nueva nota"}</button>
            </div>
            {creatingNote && (
              <div className="memory-card">
                <p className="memory-hint">Algo que quieras dejarle escrito al próximo agente: una decisión, una convención, algo a evitar.</p>
                <div className="memory-new">
                  <input aria-label="Título de la nueva nota" className="memory-input" placeholder="Título de la nota" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
                  <select aria-label="Tipo de la nueva nota" className="memory-input" value={draftKind} onChange={(e) => setDraftKind(e.target.value)}>{Object.entries(KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
                </div>
                <textarea aria-label="Contenido de la nueva nota" className="memory-textarea" placeholder="Qué decidiste, por qué, y qué debería saber el próximo agente." value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
                <div className="memory-card-actions"><button type="button" className="btn btn-primary" disabled={busy || !draftTitle.trim()} onClick={() => void save("memory_write_note", { scope: root, title: draftTitle, body: draftBody, kind: draftKind }, "Nota guardada", () => { setDraftTitle(""); setDraftBody(""); setCreatingNote(false) })}><Icon name="add" /> Agregar nota</button></div>
              </div>
            )}
            {data.notes.length === 0 && !creatingNote && <p className="memory-empty">No hay notas todavía. El agente las crea solo; vos podés agregar una cuando quieras.</p>}
            {data.notes.map((note) => (
              <div key={note.id} className="memory-card">
                <div className="memory-card-head"><strong>{note.title}</strong><span className="memory-kind">{KINDS[note.kind as keyof typeof KINDS] ?? note.kind}</span><Origin source={note.source} /><span className="memory-when">{when(note.updated)}</span></div>
                {note.preview && <p className="memory-line">{note.preview}</p>}
                <div className="memory-card-actions">
                  <button type="button" className="btn" onClick={() => void openEntry({ kind: "notes", id: note.id })}><Icon name="book" /> Leer</button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeEntry({ kind: "notes", id: note.id }, note.title)}><Icon name="trash" /> Eliminar</button>
                </div>
              </div>
            ))}
          </>
        ))}
        {view === "overview" && (
          <div className="memory-card">
            <p className="memory-hint">Qué es este proyecto, su arquitectura y sus convenciones. Se inyecta al empezar cada conversación.</p>
            {editingText === "overview" ? (
              <>
                <textarea aria-label="Descripción del proyecto" className="memory-textarea tall" value={overview} onChange={(e) => setOverview(e.target.value)} />
                <div className="memory-card-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save("memory_write_overview", { scope: root, body: overview }, "Descripción del proyecto guardada", () => setEditingText(null))}><Icon name="save" /> Guardar</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => { setOverview(data.overview); setEditingText(null) }}>Cancelar</button>
                </div>
              </>
            ) : (
              <>
                <Text value={overview} empty="Sin descripción del proyecto todavía." />
                <div className="memory-card-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => setEditingText("overview")}><Icon name="edit" /> Editar</button>
                  {overview.trim() && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void clearText("overview")}><Icon name="trash" /> Borrar</button>}
                </div>
              </>
            )}
          </div>
        )}
        {view === "preferences" && (
          <div className="memory-card">
            <p className="memory-hint">Preferencias que valen para todos los proyectos (idioma, estilo, reglas).</p>
            {editingText === "preferences" ? (
              <>
                <textarea aria-label="Preferencias globales" className="memory-textarea tall" value={prefs} onChange={(e) => setPrefs(e.target.value)} />
                <div className="memory-card-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save("memory_write_preferences", { body: prefs }, "Preferencias guardadas", () => setEditingText(null))}><Icon name="save" /> Guardar</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => { setPrefs(data.preferences); setEditingText(null) }}>Cancelar</button>
                </div>
              </>
            ) : (
              <>
                <Text value={prefs} empty="Sin preferencias guardadas todavía." />
                <div className="memory-card-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => setEditingText("preferences")}><Icon name="edit" /> Editar</button>
                  {prefs.trim() && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void clearText("preferences")}><Icon name="trash" /> Borrar</button>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
