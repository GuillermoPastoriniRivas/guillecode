import { useEffect, useRef } from "react"
import { useLayout } from "../state/layout"
import {
  attachTerminal,
  clearTerminal,
  createTerminal,
  ensureShells,
  focusTerminal,
  shouldAutoFocus,
  terminalTitle,
  killTerminal,
  setActiveTerminal,
  setDefaultShell,
  useTerminals,
} from "../state/terminals"
import { useOutput } from "../state/output"
import { openMenuAt } from "../components/ContextMenu"
import { Icon, IconButton } from "../components/ui"
import { clockTime } from "../lib/time"

function TerminalSurface({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const detach = attachTerminal(id, el)
    if (shouldAutoFocus(id)) requestAnimationFrame(() => focusTerminal(id))
    return detach
  }, [id])
  return <div ref={ref} className="terminal-surface" />
}

function TerminalsPanel() {
  const terminals = useTerminals((s) => s.terminals)
  const activeId = useTerminals((s) => s.activeId)
  const shells = useTerminals((s) => s.shells)
  const defaultShell = useTerminals((s) => s.defaultShell)

  useEffect(() => {
    let cancelled = false
    void ensureShells().then(() => {
      if (!cancelled && useTerminals.getState().terminals.length === 0) createTerminal({ show: false })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const defaultId = shells.some((sh) => sh.id === defaultShell) ? defaultShell : null
  const defaultName = shells.find((sh) => sh.id === defaultId)?.name

  // Elegir un shell en el menú lo deja como predeterminado y abre una terminal:
  // el botón + (y Ctrl+Shift+`) pasan a abrir siempre el predeterminado.
  const newMenu = (el: HTMLElement) =>
    openMenuAt(
      el,
      shells.map((sh) => ({
        label: sh.name,
        icon: sh.id === defaultId ? "check" : sh.id === "cmd" ? "terminal-cmd" : sh.id === "bash" ? "terminal-bash" : "terminal-powershell",
        run: () => {
          setDefaultShell(sh.id)
          createTerminal({ shell: sh.id })
        },
      })),
    )

  return (
    <div className="terminals">
      <div className="terminal-main">{activeId && <TerminalSurface key={activeId} id={activeId} />}</div>
      {terminals.length > 0 && (
        <div className="terminal-list">
          <div className="terminal-list-actions">
            <IconButton icon="add" title={defaultName ? `Nueva terminal (${defaultName})` : "Nueva terminal"} onClick={() => createTerminal()} />
            <IconButton icon="chevron-down" title="Elegir shell predeterminado" onClick={(e) => newMenu(e.currentTarget)} />
            <IconButton icon="clear-all" title="Limpiar" onClick={() => clearTerminal(activeId)} />
          </div>
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`terminal-item${t.id === activeId ? " active" : ""}${t.exited ? " exited" : ""}`}
              onClick={() => setActiveTerminal(t.id)}
              title={t.agent ? `Abierta por el agente · ${t.cwd}` : t.cwd}
            >
              <Icon name={t.agent ? "hubot" : "terminal"} />
              <span>{terminalTitle(t, shells)}</span>
              <button
                type="button"
                className="terminal-kill"
                title="Cerrar terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  void killTerminal(t.id)
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OutputPanel() {
  const entries = useOutput((s) => s.entries)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    useOutput.getState().markSeen()
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])
  return (
    <div className="output" ref={ref}>
      {entries.length === 0 && <div className="view-note">Acá aparece cada comando de git y gh que corre GuilleCode, con su resultado.</div>}
      {entries.map((e) => (
        <div key={e.id} className={`output-entry${e.ok ? "" : " failed"}`}>
          <div className="output-head">
            <span className="output-time">{clockTime(e.time)}</span>
            <Icon name={e.ok ? "pass" : "error"} />
            <code>
              {e.tool} {e.args.filter((a) => !a.startsWith("core.quotepath") && !a.startsWith("color.ui") && a !== "-c").join(" ")}
            </code>
            <span className="output-ms">{e.ms} ms</span>
          </div>
          {e.output && <pre>{e.output}</pre>}
        </div>
      ))}
    </div>
  )
}

export function Panel() {
  const tab = useLayout((s) => s.panelTab)
  const maximized = useLayout((s) => s.panelMaximized)
  const unseen = useOutput((s) => s.unseenErrors)
  const layout = useLayout.getState()
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-tabs">
          <button type="button" className={tab === "terminal" ? "active" : ""} onClick={() => layout.showPanel("terminal")}>
            Terminal
          </button>
          <button type="button" className={tab === "output" ? "active" : ""} onClick={() => layout.showPanel("output")}>
            Salida git/gh {unseen > 0 && tab !== "output" && <span className="badge-dot error">{unseen}</span>}
          </button>
        </div>
        <span className="panel-actions">
          {tab === "output" && <IconButton icon="clear-all" title="Limpiar salida" onClick={() => useOutput.getState().clear()} />}
          <IconButton
            icon={maximized ? "chevron-down" : "chevron-up"}
            title={maximized ? "Restaurar tamaño" : "Maximizar panel"}
            onClick={() => useLayout.getState().togglePanelMaximized()}
          />
          <IconButton icon="close" title="Ocultar panel (Ctrl+J)" onClick={() => useLayout.getState().togglePanel()} />
        </span>
      </div>
      <div className="panel-body">{tab === "terminal" ? <TerminalsPanel /> : <OutputPanel />}</div>
    </section>
  )
}
