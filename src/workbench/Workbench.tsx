import { useEffect, useRef, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useLayout, type ViewId } from "../state/layout"
import { initProject, openProject, useProject, pickProject } from "../state/project"
import { basename } from "../lib/paths"
import { bindAgentProject, loadAgentMeta, startEventStream, useAgent } from "../state/agent"
import { AccountsEditor } from "../editor/AccountsEditor"
import { initAttention } from "../state/attention"
import { initApprovals } from "../state/approvals"
import { initUnseen } from "../state/unseen"
import { startUsagePolling } from "../state/usage"
import { startRoutines } from "../state/routines"
import { startOutputCapture } from "../state/output"
import { ensureShells, startAgentTerminals } from "../state/terminals"
import { bindRoot } from "../state/workspace"
import { initFeatures } from "../state/features"
import { registerBuiltinCommands } from "../commands/builtin"
import { installKeybindings } from "../commands/registry"
import { isTauri, onWindowEvent } from "../lib/tauri"
import { isMainWindow } from "../lib/windows"
import { startWindowTitle } from "../state/windowTitle"
import { closeThisWindow, closeToTray, hideToTray, hubAvailable, listenWindowClose, requestQuit } from "../state/hub"
import { useZoom } from "../state/zoom"
import { ActivityBar, StatusBar, TitleBar } from "./Chrome"
import { Panel } from "./Panel"
import { EditorArea } from "../editor/EditorArea"
import { AgentPanel } from "../agent/AgentPanel"
import { ExplorerView } from "../views/ExplorerView"
import { SearchView } from "../views/SearchView"
import { ScmView } from "../views/ScmView"
import { AgentsView } from "../views/AgentsView"
import { PullRequestsView } from "../views/PullRequestsView"
import { RoutinesView } from "../views/RoutinesView"
import { MemoryView } from "../views/MemoryView"
import { Sash } from "../components/Sash"
import { QuickInput } from "../components/QuickInput"
import { ContextMenuHost } from "../components/ContextMenu"
import { DialogHost } from "../components/Dialog"
import { ImageLightbox } from "../components/ImageLightbox"
import { Toasts } from "../components/Toasts"
import { Icon, Spinner } from "../components/ui"
import { Logo } from "../components/Logo"
import { UpdatesHost } from "../components/Updates"
import { startUpdates } from "../state/updates"

const VIEW_COMPONENTS: Record<ViewId, () => React.ReactElement> = {
  explorer: ExplorerView,
  search: SearchView,
  scm: ScmView,
  agents: AgentsView,
  prs: PullRequestsView,
  routines: RoutinesView,
  memory: MemoryView,
}

let booted = false

function boot() {
  if (booted) return
  booted = true
  registerBuiltinCommands()
  installKeybindings()
  useZoom.getState().apply()
  startOutputCapture()
  initAttention()
  initApprovals()
  initUnseen()
  startUpdates()
  void initProject().then(() => {
    const root = useProject.getState().root
    bindAgentProject(root)
    startEventStream()
    void loadAgentMeta()
    startUsagePolling()
    startRoutines()
    if (!root) return
    bindRoot(root)
    initFeatures()
    void ensureShells()
    startAgentTerminals()
  })
  if (isTauri) {
    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault()
      if (!isMainWindow()) {
        await closeThisWindow()
        return
      }
      if (closeToTray() && (await hubAvailable())) await hideToTray()
      else await requestQuit()
    })
    if (isMainWindow()) onWindowEvent("hub://quit", () => void requestQuit())
    listenWindowClose()
    startWindowTitle()
  }
}

function SideBar() {
  const view = useLayout((s) => s.activeView)
  const View = VIEW_COMPONENTS[view]
  return (
    <aside className="side-bar">
      <View />
    </aside>
  )
}

function NoProject() {
  const error = useProject((s) => s.error)
  const recent = useProject((s) => s.recent)
  const [accounts, setAccounts] = useState(false)
  if (accounts) return <div className="doc-page"><button type="button" className="btn" onClick={() => setAccounts(false)}><Icon name="arrow-left" /> Volver</button><AccountsEditor /></div>
  return (
    <div className="no-project">
      <Logo size={80} className="welcome-logo-svg" />
      <h1>GuilleCode</h1>
      <p>Agente y editor en una sola app. Elegí la carpeta del proyecto para arrancar.</p>
      {error && <div className="view-error">{error}</div>}
      <button type="button" className="btn btn-primary btn-lg" onClick={() => void pickProject()}>
        <Icon name="folder-opened" /> Abrir carpeta
      </button>
      <button type="button" className="btn" onClick={() => setAccounts(true)}><Icon name="account" /> Cuentas de IA</button>
      {recent.length > 0 && (
        <div className="no-project-recent">
          <span className="no-project-recent-title">Recientes</span>
          {recent.slice(0, 8).map((p) => (
            <button key={p} type="button" className="no-project-recent-item" title={p} onClick={() => void openProject(p)}>
              <Icon name="root-folder" />
              <span className="no-project-recent-name">{basename(p)}</span>
              <span className="no-project-recent-path">{p}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Workbench() {
  const modelsLoaded = useAgent((s) => s.modelsLoaded)
  const modelCount = useAgent((s) => s.models.length)
  const [setup, setSetup] = useState(false)
  const [previousModelCount, setPreviousModelCount] = useState<number | null>(null)
  if (modelsLoaded && previousModelCount !== modelCount) {
    setPreviousModelCount(modelCount)
    if (modelCount === 0) setSetup(true)
  }
  const ready = useProject((s) => s.ready)
  const root = useProject((s) => s.root)
  const sidebarVisible = useLayout((s) => s.sidebarVisible)
  const sidebarWidth = useLayout((s) => s.sidebarWidth)
  const panelVisible = useLayout((s) => s.panelVisible)
  const panelHeight = useLayout((s) => s.panelHeight)
  const panelMaximized = useLayout((s) => s.panelMaximized)
  const agentVisible = useLayout((s) => s.agentVisible)
  const agentWidth = useLayout((s) => s.agentWidth)
  const focusChat = useLayout((s) => s.focusChat)
  const start = useRef(0)

  useEffect(() => {
    boot()
  }, [])

  useEffect(() => {
    const fit = () => useLayout.getState().fitToViewport()
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [])

  if (!ready)
    return (
      <div className="boot">
        <Logo size={80} className="welcome-logo-svg pulse" />
        <Spinner size={18} />
        <span>Levantando opencode…</span>
      </div>
    )

  if (setup || !modelsLoaded || modelCount === 0) return (
    <div className="workbench">
      <TitleBar />
      <AccountsEditor onboarding onContinue={() => setSetup(false)} />
      <UpdatesHost />
      <DialogHost />
      <Toasts />
    </div>
  )

  return (
    <div className="workbench">
      <TitleBar />
      <div className={`workbench-main${focusChat ? " focus-chat" : ""}`}>
        <ActivityBar />
        {sidebarVisible && (
          <>
            <div className="side-bar-slot" style={{ width: sidebarWidth }}>
              <SideBar />
            </div>
            <Sash
              orientation="vertical"
              onDrag={(delta) => {
                if (start.current === 0) start.current = useLayout.getState().sidebarWidth
                useLayout.getState().setSidebarWidth(start.current + delta)
              }}
              onDragEnd={() => {
                start.current = 0
              }}
            />
          </>
        )}
        {!focusChat && (
          <div className="center">
            {root ? (
              <>
                {!(panelVisible && panelMaximized) && <EditorArea />}
                {panelVisible && (
                  <>
                    {!panelMaximized && (
                      <Sash
                        orientation="horizontal"
                        onDrag={(delta) => {
                          if (start.current === 0) start.current = useLayout.getState().panelHeight
                          useLayout.getState().setPanelHeight(start.current - delta)
                        }}
                        onDragEnd={() => {
                          start.current = 0
                        }}
                        onDoubleClick={() => useLayout.getState().togglePanelMaximized()}
                      />
                    )}
                    <div className="panel-slot" style={panelMaximized ? { flex: 1 } : { height: panelHeight }}>
                      <Panel />
                    </div>
                  </>
                )}
              </>
            ) : (
              <NoProject />
            )}
          </div>
        )}
        {agentVisible && (
          <>
            {!focusChat && (
              <Sash
                orientation="vertical"
                onDrag={(delta) => {
                  if (start.current === 0) start.current = useLayout.getState().agentWidth
                  useLayout.getState().setAgentWidth(start.current - delta)
                }}
                onDragEnd={() => {
                  start.current = 0
                }}
                onDoubleClick={() => useLayout.getState().applyPreset(agentWidth > window.innerWidth * 0.5 ? "balanced" : "agent")}
              />
            )}
            <div className="agent-slot" style={focusChat ? { flex: 1 } : root ? { width: agentWidth } : { flex: 1 }}>
              <AgentPanel />
            </div>
          </>
        )}
      </div>
      <StatusBar />
      <QuickInput />
      <ContextMenuHost />
      <DialogHost />
      <ImageLightbox />
      <UpdatesHost />
      <Toasts />
    </div>
  )
}
