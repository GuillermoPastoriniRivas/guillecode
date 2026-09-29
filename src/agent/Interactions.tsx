import { useState } from "react"
import {
  rejectQuestion,
  replyPermission,
  replyQuestion,
  type PermissionRequest,
  type QuestionRequest,
  type Todo,
} from "../state/agent"
import { openEditor, openFile } from "../state/editors"
import { useProject } from "../state/project"
import { DiffRows } from "../components/DiffRows"
import { Icon } from "../components/ui"
import { relativePath, resolvePath } from "../lib/paths"

const PERMISSION_LABELS: Record<string, { title: string; icon: string }> = {
  edit: { title: "Quiere editar un archivo", icon: "edit" },
  write: { title: "Quiere escribir un archivo", icon: "new-file" },
  bash: { title: "Quiere ejecutar un comando", icon: "terminal" },
  webfetch: { title: "Quiere leer una página web", icon: "globe" },
  external_directory: { title: "Quiere acceder fuera del proyecto", icon: "folder" },
  doom_loop: { title: "Está repitiendo la misma acción", icon: "warning" },
  read: { title: "Quiere leer un archivo", icon: "eye" },
  task: { title: "Quiere lanzar un subagente", icon: "hubot" },
}

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const root = useProject((s) => s.root)
  const [rejecting, setRejecting] = useState(false)
  const [message, setMessage] = useState("")
  const [showDiff, setShowDiff] = useState(false)
  const label = PERMISSION_LABELS[request.permission] ?? { title: `Pide permiso: ${request.permission}`, icon: "shield" }
  const meta = request.metadata ?? {}
  const diff = typeof meta.diff === "string" ? meta.diff : null
  const filepath = typeof meta.filepath === "string" ? meta.filepath : null
  const command = typeof meta.command === "string" ? meta.command : null
  const rel = filepath && root ? relativePath(root, filepath) : filepath
  return (
    <div className="interaction-card permission-card">
      <div className="interaction-head">
        <Icon name={label.icon} className="interaction-icon" />
        <div className="interaction-titles">
          <div className="interaction-title">{label.title}</div>
          <div className="interaction-sub">
            {rel ? (
              <button type="button" className="tool-path" onClick={() => root && filepath && openFile(resolvePath(root, filepath))}>
                {rel}
              </button>
            ) : (
              request.patterns.join(", ")
            )}
          </div>
        </div>
        {diff && (
          <button type="button" className="interaction-toggle" onClick={() => setShowDiff(!showDiff)}>
            <Icon name={showDiff ? "chevron-up" : "diff"} /> {showDiff ? "Ocultar" : "Ver diff"}
          </button>
        )}
      </div>
      {command && <pre className="tool-pre">{command}</pre>}
      {diff && showDiff && (
        <div className="interaction-diff">
          <DiffRows patch={diff} maxRows={120} />
        </div>
      )}
      {rejecting ? (
        <div className="interaction-reject">
          <input
            autoFocus
            placeholder="Decile qué hacer en su lugar (opcional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void replyPermission(request, "reject", message.trim() || undefined)
              if (e.key === "Escape") setRejecting(false)
            }}
          />
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void replyPermission(request, "reject", message.trim() || undefined)}>
            Rechazar
          </button>
        </div>
      ) : (
        <div className="interaction-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void replyPermission(request, "once")}>
            <Icon name="check" /> Permitir
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title={request.always.length ? `Siempre para: ${request.always.join(", ")}` : undefined}
            onClick={() => void replyPermission(request, "always")}
          >
            <Icon name="check-all" /> Siempre
          </button>
          <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => setRejecting(true)}>
            <Icon name="close" /> Rechazar
          </button>
        </div>
      )}
    </div>
  )
}

export function QuestionCard({ request }: { request: QuestionRequest }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""))
  const [open, setOpen] = useState(true)
  const count = request.questions.length
  const preview = request.questions.map((q) => q.header || q.question).join(" · ")
  const toggle = (qi: number, label: string, multiple: boolean) => {
    setAnswers((prev) =>
      prev.map((a, i) => {
        if (i !== qi) return a
        if (!multiple) return [label]
        return a.includes(label) ? a.filter((x) => x !== label) : [...a, label]
      }),
    )
  }
  const final = answers.map((a, i) => (custom[i].trim() ? [...a, custom[i].trim()] : a))
  const ready = final.every((a) => a.length > 0)
  return (
    <div className={`interaction-card question-card${open ? "" : " collapsed"}`}>
      <div className="interaction-head">
        <Icon name="question" className="interaction-icon" />
        <div className="interaction-titles">
          <div className="interaction-title">El agente te pregunta</div>
          <div className="interaction-sub">
            {open ? `${count} pregunta${count === 1 ? "" : "s"} sin responder` : preview}
          </div>
        </div>
        <button
          type="button"
          className="interaction-toggle"
          aria-expanded={open}
          title={open ? "Colapsar para leer la conversación" : "Expandir para responder"}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "chevron-down" : "chevron-up"} /> {open ? "Colapsar" : "Expandir"}
        </button>
      </div>
      {open && (
        <>
          {request.questions.map((q, qi) => (
            <div key={qi} className="question">
              {q.header && <div className="question-header">{q.header}</div>}
              <div className="question-text">{q.question}</div>
              <div className="question-options">
                {q.options.map((o) => {
                  const on = answers[qi].includes(o.label)
                  return (
                    <button
                      key={o.label}
                      type="button"
                      className={`question-option${on ? " selected" : ""}`}
                      onClick={() => toggle(qi, o.label, !!q.multiple)}
                    >
                      <Icon name={q.multiple ? (on ? "pass-filled" : "circle-large-outline") : on ? "circle-filled" : "circle-outline"} />
                      <span>
                        <strong>{o.label}</strong>
                        {o.description && <em>{o.description}</em>}
                      </span>
                    </button>
                  )
                })}
              </div>
              {q.custom !== false && (
                <input
                  className="question-custom"
                  placeholder="Otra respuesta…"
                  value={custom[qi]}
                  onChange={(e) => setCustom((prev) => prev.map((c, i) => (i === qi ? e.target.value : c)))}
                />
              )}
            </div>
          ))}
          <div className="interaction-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!ready} onClick={() => void replyQuestion(request, final)}>
              <Icon name="send" /> Responder
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void rejectQuestion(request)}>
              Saltear
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const TODO_ICONS: Record<string, string> = {
  completed: "pass-filled",
  in_progress: "circle-large-filled",
  cancelled: "circle-slash",
  pending: "circle-large-outline",
}

export function TodoList({ todos, live }: { todos: Todo[]; live: boolean }) {
  const [open, setOpen] = useState(live)
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === "completed").length
  const current = todos.find((t) => t.status === "in_progress")
  return (
    <div className={`todo-list${open ? " open" : ""}`}>
      <button type="button" className="todo-head" onClick={() => setOpen(!open)}>
        <Icon name="checklist" />
        <span className="todo-title">Plan</span>
        <span className="todo-progress">
          <span className="todo-bar" style={{ width: `${(done / todos.length) * 100}%` }} />
        </span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
        {!open && current && <span className="todo-current">{current.content}</span>}
        <Icon name={open ? "chevron-down" : "chevron-up"} />
      </button>
      {open && (
        <ul>
          {todos.map((t, i) => (
            <li key={t.id ?? i} className={`todo todo-${t.status}`}>
              <Icon name={TODO_ICONS[t.status] ?? "circle-large-outline"} />
              <span>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ChangesBar({ sessionId, files, additions, deletions }: { sessionId: string; files: number; additions: number; deletions: number }) {
  if (files === 0) return null
  return (
    <button type="button" className="changes-bar" onClick={() => openEditor({ kind: "review", sessionId })}>
      <Icon name="diff-multiple" />
      <span>
        {files} archivo{files === 1 ? "" : "s"} cambiado{files === 1 ? "" : "s"}
      </span>
      <span className="add">+{additions}</span>
      <span className="del">−{deletions}</span>
      <span className="changes-bar-cta">
        Revisar <Icon name="arrow-right" />
      </span>
    </button>
  )
}
