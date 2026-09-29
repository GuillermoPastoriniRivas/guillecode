import { useProject, openProject, pickProject } from "../state/project"
import { useAgent, selectSession, newSession, focusComposer } from "../state/agent"
import { useLayout } from "../state/layout"
import { showQuickOpen } from "../state/quickinput"
import { executeCommand } from "../commands/registry"
import { basename, projectName } from "../lib/paths"
import { shortAgo } from "../lib/time"
import { Icon, Kbd } from "../components/ui"
import { Logo } from "../components/Logo"

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl+P", "Ir a archivo"],
  ["Ctrl+Shift+P", "Todos los comandos"],
  ["Ctrl+L", "Mandar la selección al agente"],
  ["Ctrl+Shift+F", "Buscar en el proyecto"],
  ["Ctrl+Shift+G", "Git"],
  ["Ctrl+`", "Terminal"],
  ["Ctrl+B / Ctrl+Alt+B", "Mostrar/ocultar paneles"],
  ["Ctrl+Alt+M", "Foco en el chat"],
  ["Ctrl+Alt+N", "Nueva sesión del agente"],
]

export function WelcomeEditor() {
  const root = useProject((s) => s.root)
  const recent = useProject((s) => s.recent)
  const sessions = useAgent((s) => s.sessions)
  return (
    <div className="welcome-page">
      <div className="welcome-hero">
        <Logo size={64} className="welcome-logo-svg" />
        <div>
          <h1>GuilleCode</h1>
          <p>El agente y el código en la misma ventana: chateás, ves los cambios en vivo, los revisás y hacés el PR sin salir.</p>
        </div>
      </div>
      <div className="welcome-grid">
        <section className="welcome-card">
          <h3>Empezar</h3>
          <button type="button" className="welcome-link" onClick={() => showQuickOpen()}>
            <Icon name="go-to-file" /> Abrir un archivo…
          </button>
          <button
            type="button"
            className="welcome-link"
            onClick={() => {
              useLayout.getState().toggleAgent(true)
              newSession()
              focusComposer()
            }}
          >
            <Icon name="sparkle" /> Nueva sesión con el agente
          </button>
          <button type="button" className="welcome-link" onClick={() => void executeCommand("git.openGraph")}>
            <Icon name="git-commit" /> Ver historial de git
          </button>
          <button type="button" className="welcome-link" onClick={() => void pickProject()}>
            <Icon name="folder-opened" /> Abrir otra carpeta…
          </button>
        </section>
        <section className="welcome-card">
          <h3>Proyectos recientes</h3>
          {recent.length === 0 && <em className="muted">Todavía no abriste proyectos</em>}
          {recent.slice(0, 7).map((p) => (
            <button key={p} type="button" className={`welcome-link${p === root ? " current" : ""}`} onClick={() => p !== root && void openProject(p)} title={p}>
              <Icon name={p === root ? "root-folder-opened" : "root-folder"} /> {basename(p)}
              <span className="welcome-link-dim">{p}</span>
            </button>
          ))}
        </section>
        <section className="welcome-card">
          <h3>Sesiones del agente en {projectName(root)}</h3>
          {sessions.length === 0 && <em className="muted">Sin sesiones todavía</em>}
          {sessions
            .filter((s) => !s.parentID)
            .slice(0, 7)
            .map((s) => (
              <button
                key={s.id}
                type="button"
                className="welcome-link"
                onClick={() => {
                  useLayout.getState().toggleAgent(true)
                  selectSession(s.id)
                }}
              >
                <Icon name="comment-discussion" /> {s.title || "Sin título"}
                <span className="welcome-link-dim">{shortAgo(s.time.updated)}</span>
              </button>
            ))}
        </section>
        <section className="welcome-card">
          <h3>Atajos</h3>
          <div className="shortcut-list">
            {SHORTCUTS.map(([k, label]) => (
              <div key={k} className="shortcut-row">
                <span>{label}</span>
                <Kbd>{k}</Kbd>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
