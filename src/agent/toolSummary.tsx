import type { ReactNode } from "react"
import { Icon } from "../components/ui"
import { DiffRows } from "../components/DiffRows"
import { useProject } from "../state/project"
import { openFile } from "../state/editors"
import { selectSession } from "../state/agent"
import { countChanges } from "../lib/diff"
import { relativePath, resolvePath } from "../lib/paths"

export type ToolState = {
  status: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  output?: string
  error?: string
  title?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}

export type Summary = { icon: string; verb: string; target: ReactNode; stats?: ReactNode; body?: ReactNode; actions?: ReactNode }

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v))
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)

// oxlint-disable-next-line react/only-export-components
function PathLink({ path, line, children }: { path: string; line?: number; children?: ReactNode }) {
  const root = useProject((s) => s.root)
  const rel = root ? relativePath(root, path) : path
  return (
    <button
      type="button"
      className="tool-path"
      title={`Abrir ${rel}${line ? ` en la línea ${line}` : ""}`}
      onClick={(e) => {
        e.stopPropagation()
        if (!root) return
        openFile(resolvePath(root, path), line ? { line } : { preview: true })
      }}
    >
      {children ?? rel}
    </button>
  )
}

function editPatch(state: ToolState): string {
  const meta = state.metadata ?? {}
  const filediff = meta.filediff as { patch?: string } | undefined
  return str(filediff?.patch) || str(meta.diff)
}

export function summarize(tool: string, state: ToolState): Summary {
  const input = state.input ?? {}
  const meta = state.metadata ?? {}
  const filePath = str(input.filePath ?? input.path ?? input.file)
  switch (tool) {
    case "read": {
      const offset = num(input.offset)
      const limit = num(input.limit)
      const range = offset !== undefined ? ` · líneas ${offset}–${offset + (limit ?? 0)}` : ""
      return {
        icon: "eye",
        verb: "Leyó",
        target: filePath ? <PathLink path={filePath} line={offset ? offset : undefined} /> : "archivo",
        stats: range ? <span className="tool-dim">{range}</span> : undefined,
      }
    }
    case "edit":
    case "multiedit": {
      const patch = editPatch(state)
      const c = patch ? countChanges(patch) : null
      return {
        icon: "edit",
        verb: "Editó",
        target: filePath ? <PathLink path={filePath} /> : "archivo",
        stats: c ? (
          <span className="tool-stats">
            <span className="add">+{c.additions}</span>
            <span className="del">−{c.deletions}</span>
          </span>
        ) : undefined,
        body: patch ? <DiffRows patch={patch} maxRows={160} /> : undefined,
      }
    }
    case "write": {
      const content = str(input.content)
      const exists = meta.exists === true
      return {
        icon: exists ? "edit" : "new-file",
        verb: exists ? "Reescribió" : "Creó",
        target: filePath ? <PathLink path={filePath} /> : "archivo",
        stats: content ? <span className="tool-dim">{content.split("\n").length} líneas</span> : undefined,
        body: content ? <pre className="tool-pre">{content.split("\n").slice(0, 60).join("\n")}</pre> : undefined,
      }
    }
    case "apply_patch":
    case "patch": {
      const patch = str(input.patchText ?? input.patch)
      return {
        icon: "diff",
        verb: "Aplicó un parche",
        target: "",
        body: patch ? <pre className="tool-pre">{patch.slice(0, 6000)}</pre> : undefined,
      }
    }
    case "bash": {
      const command = str(input.command)
      const output = str(meta.output ?? state.output)
      return {
        icon: "terminal",
        verb: str(input.description) || "Ejecutó",
        target: <code className="tool-command">{command.length > 90 ? command.slice(0, 90) + "…" : command}</code>,
        body: (
          <div className="tool-terminal">
            <div className="tool-terminal-cmd">
              <span className="prompt">❯</span> {command}
            </div>
            {output && <pre>{output.length > 12000 ? output.slice(-12000) : output}</pre>}
          </div>
        ),
      }
    }
    case "grep":
      return {
        icon: "search",
        verb: "Buscó",
        target: <code className="tool-command">{str(input.pattern)}</code>,
        stats: input.include ? <span className="tool-dim">en {str(input.include)}</span> : undefined,
        body: state.output ? <pre className="tool-pre">{state.output}</pre> : undefined,
      }
    case "glob":
      return {
        icon: "files",
        verb: "Buscó archivos",
        target: <code className="tool-command">{str(input.pattern)}</code>,
        body: state.output ? <pre className="tool-pre">{state.output}</pre> : undefined,
      }
    case "list":
      return {
        icon: "folder-opened",
        verb: "Listó",
        target: filePath ? <PathLink path={filePath} /> : "la carpeta",
        body: state.output ? <pre className="tool-pre">{state.output}</pre> : undefined,
      }
    case "webfetch":
      return { icon: "globe", verb: "Leyó la web", target: <span className="tool-dim">{str(input.url)}</span> }
    case "todowrite":
    case "todoread": {
      const todos = (input.todos as unknown[] | undefined)?.length
      return { icon: "checklist", verb: "Actualizó el plan", target: todos ? <span className="tool-dim">{todos} tareas</span> : "" }
    }
    case "task": {
      const sessionId = str(meta.sessionId ?? (meta.summary as { sessionId?: string } | undefined)?.sessionId)
      return {
        icon: "hubot",
        verb: `Subagente ${str(input.subagent_type) || ""}`.trim(),
        target: <span className="tool-dim">{str(input.description)}</span>,
        body: state.output ? <pre className="tool-pre">{state.output}</pre> : undefined,
        actions: sessionId ? (
          <button
            type="button"
            className="btn btn-xs"
            onClick={(e) => {
              e.stopPropagation()
              selectSession(sessionId)
            }}
          >
            <Icon name="link-external" /> Abrir sesión
          </button>
        ) : undefined,
      }
    }
    case "question":
      return { icon: "question", verb: "Te hizo una pregunta", target: "" }
    case "skill":
      return { icon: "book", verb: "Cargó la skill", target: <span className="tool-dim">{str(input.name)}</span> }
    default:
      return {
        icon: "tools",
        verb: state.title || tool,
        target: "",
        body:
          Object.keys(input).length > 0 || state.output ? (
            <>
              {Object.keys(input).length > 0 && <pre className="tool-pre">{JSON.stringify(input, null, 2)}</pre>}
              {state.output && <pre className="tool-pre">{state.output}</pre>}
            </>
          ) : undefined,
      }
  }
}
