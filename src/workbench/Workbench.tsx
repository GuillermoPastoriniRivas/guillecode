import { useEffect, useRef, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useLayout, type ViewId } from "../state/layout"
import { initProject, useProject, pickProject } from "../state/project"
import { initGit } from "../state/git"
import { initExplorer } from "../state/explorer"
import { persistEditors, restoreEditors } from "../state/editors"
import { bindAgentProject, loadAgentMeta, startEventStream, useAgent } from "../state/agent"
import { AccountsEditor } from "../editor/AccountsEditor"
import { initAttention } from "../state/attention"
import { startUsagePolling } from "../state/usage"
import { startRoutines } from "../state/routines"
import { startOutputCapture } from "../state/output"
import { ensureShells } from "../state/terminals"
import { getFileIndex } from "../state/fileIndex"
import { registerBuiltinCommands } from "../commands/builtin"
import { installKeybindings } from "../commands/registry"
import { isTauri, onEvent } from "../lib/tauri"
import { closeToTray, hideToTray, hubAvailable, requestQuit } from "../state/hub"
import { startSync } from "./sync"
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
import { Sash } from "../components/Sash"
import { QuickInput } from "../components/QuickInput"
import { ContextMenuHost } from "../components/ContextMenu"
import { DialogHost } from "../components/Dialog"
import { ImageLightbox } from "../components/ImageLightbox"
import { Toasts } from "../components/Toasts"
import { Icon, Spinner } from "../components/ui"
import { Logo } from "../components/Logo"

const VIEW_COMPONENTS: Record<ViewId, () => React.ReactElement> = {
  explorer: ExplorerView,
  search: SearchView,
  scm: ScmView,
  agents: AgentsView,
  prs: PullRequestsView,
  routines: RoutinesView,
}

let booted = false

function boot() {
  if (booted) return
  booted = true
  registerBuiltinCommands()
  installKeybindings()
  startOutputCapture()
  initAttention()
  void initProject().then(() => {
    const root = useProject.getState().root
    bindAgentProject(root)
    startEventStream()
    void loadAgentMeta()
    startUsagePolling()
    startRoutines()
    if (!root) return
    restoreEditors(root)
    persistEditors(root)
    void initGit(root)
    void initExplorer(root)
    startSync(root)
    void ensureShells()
    setTimeout(() => void getFileIndex(root), 1500)
  })
  if (isTauri) {
    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault()
      if (closeToTray() && (await hubAvailable())) await hideToTray()
      else await requestQuit()
    })
    onEvent("hub://quit", () => void requestQuit())
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
      <Toasts />
    </div>
  )
}
