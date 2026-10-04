import { registerCommands, type Command } from "./registry"
import { useLayout } from "../state/layout"
import { showQuickOpen } from "../state/quickinput"
import {
  openInNewWindow,
  pickProject,
  pickProjectInNewWindow,
  pickRecentInNewWindow,
  pickWindow,
  useProject,
} from "../state/project"
import { activeTab, cycleTab, moveTabToNextGroup, openEditor } from "../state/editors"
import { newSession, cycleSessionTab, useAgent, abortSession, focusComposer } from "../state/agent"
import { gitAction, refreshAllRepos, bumpHead, useGit } from "../state/git"
import { openAiReview } from "../state/aiReview"
import { closeToTray, requestQuit, setCloseToTray, toggleAutostart } from "../state/hub"
import { createTerminal, runInTerminal, useTerminals, focusTerminal } from "../state/terminals"
import { collapseAll, revealInExplorer, startCreate } from "../state/explorer"
import { notify } from "../state/toasts"
import { gitFetch, gitPull, gitPush } from "../lib/git"
import { activeCode, addActiveSelectionToChat, customSaver } from "../editor/bridge"
import { closeActiveTab, closeAllTabs, closeSavedTabs } from "../editor/tabs"
import { saveAll, saveDocument, discardAndReload } from "../editor/documents"
import { focusSearch } from "../views/SearchView"
import { pickBranch } from "../views/ScmView"
import { toggleInlineBlame } from "../editor/cm/blame"
import { wrapCompartment, wrapExtension } from "../editor/cm/setup"
import { relativePath } from "../lib/paths"
import { useZoom } from "../state/zoom"
import { showUpdates, checkUpdates } from "../state/updates"
import {
  activeFeature,
  configureRunCommand,
  openPullRequest,
  pickFeature,
  removeFeature,
  runApp,
  stopApp,
  switchToFeature,
  updateFromBase,
  useFeatures,
} from "../state/features"

let wrapOn = false
let blameOn = true

function activeRepo(): string | null {
  return useGit.getState().activeRepo
}

async function saveActive() {
  const saver = customSaver()
  if (saver) {
    await saver()
    return
  }
  const tab = activeTab()
  if (tab?.input.kind === "file") await saveDocument(tab.input.path)
}

function withActiveFeature(fn: (f: NonNullable<ReturnType<typeof activeFeature>>) => void): void {
  const f = activeFeature()
  if (!f) {
    notify.info("No hay una feature activa", "Las features necesitan un proyecto con git")
    return
  }
  fn(f)
}

function withIsolatedFeature(fn: (f: NonNullable<ReturnType<typeof activeFeature>>) => void): void {
  withActiveFeature((f) => {
    if (f.kind === "main") notify.info("Estás en la copia principal", "Abrí una feature para usar esta acción")
    else fn(f)
  })
}

export function registerBuiltinCommands(): void {
  const cmds: Command[] = [
    { id: "window.new", title: "Nueva ventana", category: "Ventana", icon: "empty-window", keys: ["ctrl+shift+n"], global: true, run: () => void openInNewWindow() },
    { id: "window.openFolder", title: "Abrir carpeta en una ventana nueva…", category: "Ventana", icon: "empty-window", run: () => void pickProjectInNewWindow() },
    { id: "window.openRecent", title: "Abrir un proyecto reciente en una ventana nueva…", category: "Ventana", icon: "root-folder", run: () => void pickRecentInNewWindow() },
    { id: "window.switch", title: "Ir a otra ventana…", category: "Ventana", icon: "multiple-windows", global: true, run: () => void pickWindow() },
    { id: "feature.new", title: "Nueva feature…", category: "Feature", icon: "git-branch-create", global: true, run: () => openEditor({ kind: "featureCreate" }) },
    { id: "feature.switch", title: "Cambiar de feature…", category: "Feature", icon: "worktree", keys: ["ctrl+alt+w"], global: true, run: () => void pickFeature() },
    { id: "feature.run", title: "Correr la app de esta feature", category: "Feature", icon: "play", keys: ["ctrl+f5"], global: true, run: () => void runApp() },
    { id: "feature.stop", title: "Detener la app", category: "Feature", icon: "debug-stop", keys: ["shift+f5"], global: true, run: () => void stopApp() },
    { id: "feature.runConfig", title: "Configurar cómo se corre la app…", category: "Feature", icon: "settings-gear", run: () => void configureRunCommand() },
    { id: "feature.integrate", title: "Integrar esta feature…", category: "Feature", icon: "git-merge", run: () => withIsolatedFeature((f) => openEditor({ kind: "featureIntegrate", path: f.path })) },
    { id: "feature.updateFromBase", title: "Traer la rama base a esta feature", category: "Feature", icon: "git-pull-request-go-to-changes", run: () => withIsolatedFeature((f) => void updateFromBase(f)) },
    { id: "feature.pr", title: "Crear pull request de esta feature", category: "Feature", icon: "git-pull-request-create", run: () => withIsolatedFeature((f) => void openPullRequest(f)) },
    { id: "feature.main", title: "Volver a la copia principal", category: "Feature", icon: "home", run: () => {
      const main = useFeatures.getState().list?.features.find((f) => f.kind === "main")
      if (main) void switchToFeature(main)
    } },
    { id: "feature.remove", title: "Eliminar esta feature…", category: "Feature", icon: "trash", run: () => withIsolatedFeature((f) => void removeFeature(f)) },
    { id: "app.updates", title: "Buscar actualizaciones de GuilleCode", category: "Aplicación", icon: "cloud-download", global: true, run: () => { showUpdates(); void checkUpdates() } },
    { id: "workbench.quickOpen", title: "Ir a archivo…", category: "Ver", icon: "go-to-file", keys: ["ctrl+p", "ctrl+e"], global: true, run: () => showQuickOpen() },
    { id: "workbench.commandPalette", title: "Mostrar todos los comandos", category: "Ver", icon: "symbol-event", keys: ["ctrl+shift+p", "f1"], global: true, run: () => showQuickOpen(">") },
    { id: "workbench.gotoLine", title: "Ir a línea…", category: "Editor", icon: "symbol-number", keys: ["ctrl+g"], run: () => showQuickOpen(":") },
    { id: "workbench.sessions", title: "Ir a sesión del agente…", category: "Agente", icon: "comment-discussion", run: () => showQuickOpen("#") },
    { id: "workbench.toggleSidebar", title: "Mostrar/ocultar barra lateral", category: "Ver", icon: "layout-sidebar-left", keys: ["ctrl+b"], global: true, run: () => useLayout.getState().toggleSidebar() },
    { id: "workbench.togglePanel", title: "Mostrar/ocultar panel inferior", category: "Ver", icon: "layout-panel", keys: ["ctrl+j"], global: true, run: () => useLayout.getState().togglePanel() },
    { id: "workbench.toggleAgent", title: "Mostrar/ocultar panel del agente", category: "Ver", icon: "layout-sidebar-right", keys: ["ctrl+alt+b"], global: true, run: () => useLayout.getState().toggleAgent() },
    { id: "workbench.zoomIn", title: "Aumentar zoom", category: "Ver", icon: "zoom-in", keys: ["ctrl+=", "ctrl+shift+="], global: true, run: () => useZoom.getState().zoomIn() },
    { id: "workbench.zoomOut", title: "Reducir zoom", category: "Ver", icon: "zoom-out", keys: ["ctrl+-"], global: true, run: () => useZoom.getState().zoomOut() },
    { id: "workbench.zoomReset", title: "Restablecer zoom", category: "Ver", icon: "screen-normal", keys: ["ctrl+0"], global: true, run: () => useZoom.getState().reset() },
    { id: "workbench.view.explorer", title: "Explorador", category: "Ver", icon: "files", keys: ["ctrl+shift+e"], run: () => useLayout.getState().showView("explorer", false) },
    {
      id: "workbench.view.search",
      title: "Buscar en el proyecto",
      category: "Ver",
      icon: "search",
      keys: ["ctrl+shift+f"],
      run: () => {
        useLayout.getState().showView("search", false)
        const code = activeCode()
        const sel = code?.view.state.selection.main
        const text = code && sel && !sel.empty ? code.view.state.sliceDoc(sel.from, sel.to) : undefined
        focusSearch(text && !text.includes("\n") ? text : undefined)
      },
    },
    { id: "workbench.view.scm", title: "Control de código", category: "Ver", icon: "source-control", keys: ["ctrl+shift+g"], run: () => useLayout.getState().showView("scm", false) },
    { id: "workbench.view.agents", title: "Sesiones del agente", category: "Ver", icon: "comment-discussion", keys: ["ctrl+shift+a"], run: () => useLayout.getState().showView("agents", false) },
    { id: "workbench.view.prs", title: "Pull requests", category: "Ver", icon: "git-pull-request", run: () => useLayout.getState().showView("prs", false) },
    { id: "layout.balanced", title: "Layout equilibrado (código + agente)", category: "Layout", icon: "layout", run: () => useLayout.getState().applyPreset("balanced") },
    { id: "layout.agent", title: "Layout con foco en el agente", category: "Layout", icon: "hubot", run: () => useLayout.getState().applyPreset("agent") },
    { id: "layout.code", title: "Layout con foco en el código", category: "Layout", icon: "code", run: () => useLayout.getState().applyPreset("code") },
    { id: "layout.review", title: "Layout de revisión", category: "Layout", icon: "diff-multiple", run: () => useLayout.getState().applyPreset("review") },
    {
      id: "layout.focusChat",
      title: "Foco en el chat (ocultar editor)",
      category: "Layout",
      icon: "screen-full",
      keys: ["ctrl+alt+m"],
      global: true,
      run: () => useLayout.getState().toggleFocusChat(),
    },
    { id: "project.open", title: "Abrir carpeta…", category: "Archivo", icon: "folder-opened", keys: ["ctrl+o"], global: true, run: () => void pickProject() },
    { id: "file.save", title: "Guardar", category: "Archivo", icon: "save", keys: ["ctrl+s"], global: true, run: () => void saveActive() },
    {
      id: "file.saveAll",
      title: "Guardar todo",
      category: "Archivo",
      icon: "save-all",
      keys: ["ctrl+alt+s"],
      global: true,
      run: async () => {
        const n = await saveAll()
        if (n > 0) notify.success(`${n} archivo${n === 1 ? "" : "s"} guardado${n === 1 ? "" : "s"}`)
      },
    },
    {
      id: "file.revert",
      title: "Descartar cambios sin guardar del archivo",
      category: "Archivo",
      icon: "discard",
      run: () => {
        const tab = activeTab()
        if (tab?.input.kind === "file") void discardAndReload(tab.input.path)
      },
    },
    {
      id: "file.new",
      title: "Nuevo archivo…",
      category: "Archivo",
      icon: "new-file",
      keys: ["ctrl+n"],
      run: () => {
        const root = useProject.getState().root
        if (!root) return
        useLayout.getState().showView("explorer", false)
        startCreate(root, "file")
      },
    },
    { id: "editor.close", title: "Cerrar pestaña", category: "Editor", icon: "close", keys: ["ctrl+w", "ctrl+f4"], run: () => void closeActiveTab() },
    { id: "editor.closeAll", title: "Cerrar todas las pestañas", category: "Editor", icon: "close-all", run: () => void closeAllTabs() },
    { id: "editor.closeSaved", title: "Cerrar pestañas guardadas", category: "Editor", run: () => void closeSavedTabs() },
    { id: "editor.next", title: "Pestaña siguiente", category: "Editor", keys: ["ctrl+tab", "ctrl+pagedown"], global: true, run: () => cycleTab(1) },
    { id: "editor.prev", title: "Pestaña anterior", category: "Editor", keys: ["ctrl+shift+tab", "ctrl+pageup"], global: true, run: () => cycleTab(-1) },
    {
      id: "editor.split",
      title: "Mover pestaña al grupo de la derecha",
      category: "Editor",
      icon: "split-horizontal",
      keys: ["ctrl+\\", "ctrl+alt+\\"],
      run: () => {
        const tab = activeTab()
        if (tab) moveTabToNextGroup(tab.id)
      },
    },
    {
      id: "editor.toggleWrap",
      title: "Ajuste de línea (word wrap)",
      category: "Editor",
      icon: "word-wrap",
      keys: ["alt+z"],
      run: () => {
        wrapOn = !wrapOn
        activeCode()?.view.dispatch({ effects: wrapCompartment.reconfigure(wrapExtension(wrapOn)) })
      },
    },
    {
      id: "editor.toggleBlame",
      title: "Mostrar/ocultar blame en la línea actual",
      category: "Git",
      icon: "person",
      run: () => {
        blameOn = !blameOn
        activeCode()?.view.dispatch({ effects: toggleInlineBlame.of(blameOn) })
      },
    },
    {
      id: "explorer.reveal",
      title: "Mostrar archivo activo en el explorador",
      category: "Ver",
      icon: "target",
      run: () => {
        const tab = activeTab()
        if (tab?.input.kind !== "file") return
        useLayout.getState().showView("explorer", false)
        void revealInExplorer(tab.input.path)
      },
    },
    { id: "explorer.collapse", title: "Colapsar carpetas del explorador", category: "Ver", icon: "collapse-all", run: collapseAll },
    { id: "agent.addSelection", title: "Agregar selección / archivo al chat", category: "Agente", icon: "sparkle", keys: ["ctrl+l"], run: () => addActiveSelectionToChat() },
    {
      id: "agent.focus",
      title: "Ir al chat del agente",
      category: "Agente",
      icon: "comment-discussion",
      keys: ["ctrl+alt+i"],
      global: true,
      run: () => {
        useLayout.getState().toggleAgent(true)
        focusComposer()
      },
    },
    {
      id: "agent.new",
      title: "Nueva sesión del agente",
      category: "Agente",
      icon: "add",
      keys: ["ctrl+alt+n"],
      global: true,
      run: () => {
        useLayout.getState().toggleAgent(true)
        newSession()
      },
    },
    {
      id: "agent.nextConversation",
      title: "Conversación siguiente",
      category: "Agente",
      icon: "comment-discussion",
      keys: ["ctrl+alt+pagedown"],
      global: true,
      run: () => cycleSessionTab(1),
    },
    {
      id: "agent.prevConversation",
      title: "Conversación anterior",
      category: "Agente",
      icon: "comment-discussion",
      keys: ["ctrl+alt+pageup"],
      global: true,
      run: () => cycleSessionTab(-1),
    },
    { id: "agent.abort", title: "Detener al agente", category: "Agente", icon: "debug-stop", run: () => void abortSession(useAgent.getState().activeSessionId) },
    {
      id: "agent.review",
      title: "Revisar cambios de la sesión actual",
      category: "Agente",
      icon: "diff-multiple",
      run: () => {
        const id = useAgent.getState().activeSessionId
        if (id) openEditor({ kind: "review", sessionId: id })
        else notify.info("No hay una sesión activa")
      },
    },
    {
      id: "agent.openAsTab",
      title: "Abrir la sesión actual en una pestaña",
      category: "Agente",
      icon: "go-to-file",
      run: () => {
        const id = useAgent.getState().activeSessionId
        if (id) openEditor({ kind: "chat", sessionId: id })
      },
    },
    {
      id: "agent.explainFile",
      title: "Pedirle al agente que explique el archivo activo",
      category: "Agente",
      icon: "comment-discussion",
      run: () => {
        const tab = activeTab()
        const root = useProject.getState().root
        if (tab?.input.kind !== "file" || !root) return
        addActiveSelectionToChat(`Explicame ${relativePath(root, tab.input.path)}: qué hace, cómo se conecta con el resto y qué mejorarías.`)
      },
    },
    { id: "git.branch", title: "Cambiar de rama…", category: "Git", icon: "git-branch", run: () => activeRepo() && void pickBranch(activeRepo()!) },
    {
      id: "git.sync",
      title: "Sincronizar (pull + push)",
      category: "Git",
      icon: "sync",
      run: async () => {
        const repo = activeRepo()
        const status = repo ? useGit.getState().byRepo[repo]?.status : null
        if (!repo || !status) return
        if (status.behind > 0) await gitAction("No se pudo hacer pull", () => gitPull(repo), "Pull listo")
        if (status.ahead > 0 || !status.upstream) await gitAction("No se pudo hacer push", () => gitPush(repo), "Push listo")
        if (status.upstream && status.ahead === 0 && status.behind === 0) await gitAction("No se pudo hacer fetch", () => gitFetch(repo), "Todo al día")
      },
    },
    { id: "git.pull", title: "Pull", category: "Git", icon: "arrow-down", run: () => activeRepo() && void gitAction("No se pudo hacer pull", () => gitPull(activeRepo()!), "Pull listo") },
    { id: "git.push", title: "Push", category: "Git", icon: "arrow-up", run: () => activeRepo() && void gitAction("No se pudo hacer push", () => gitPush(activeRepo()!), "Push listo") },
    { id: "git.fetch", title: "Fetch", category: "Git", icon: "sync", run: () => activeRepo() && void gitAction("No se pudo hacer fetch", () => gitFetch(activeRepo()!), "Fetch listo") },
    {
      id: "git.refresh",
      title: "Refrescar estado de git",
      category: "Git",
      icon: "refresh",
      run: () => {
        bumpHead()
        void refreshAllRepos()
      },
    },
    { id: "git.openGraph", title: "Ver historial (grafo de commits)", category: "Git", icon: "git-commit", run: () => activeRepo() && openEditor({ kind: "graph", repo: activeRepo()! }) },
    { id: "git.createPr", title: "Crear pull request", category: "Git", icon: "git-pull-request-create", run: () => activeRepo() && openEditor({ kind: "prCreate", repo: activeRepo()! }) },
    {
      id: "git.aiReview",
      title: "Revisar los cambios con IA",
      category: "Git",
      icon: "sparkle",
      run: () => activeRepo() && openAiReview({ kind: "aiReview", repo: activeRepo()!, scope: "changes" }),
    },
    {
      id: "git.fileHistory",
      title: "Historial de cambios del archivo activo",
      category: "Git",
      icon: "history",
      run: () => {
        const tab = activeTab()
        const root = useProject.getState().root
        if (tab?.input.kind !== "file" || !root) return
        void runInTerminal(`git log --follow --oneline -- "${relativePath(root, tab.input.path)}"`)
      },
    },
    {
      id: "terminal.toggle",
      title: "Mostrar/ocultar terminal",
      category: "Terminal",
      icon: "terminal",
      keys: ["ctrl+`", "ctrl+ñ", "ctrl+'"],
      global: true,
      run: () => {
        const layout = useLayout.getState()
        if (layout.panelVisible && layout.panelTab === "terminal") layout.togglePanel()
        else {
          layout.showPanel("terminal")
          requestAnimationFrame(() => focusTerminal(useTerminals.getState().activeId))
        }
      },
    },
    { id: "terminal.new", title: "Nueva terminal", category: "Terminal", icon: "add", keys: ["ctrl+shift+`", "ctrl+shift+ñ"], global: true, run: () => createTerminal() },
    { id: "output.show", title: "Ver salida de git/gh", category: "Ver", icon: "output", run: () => useLayout.getState().showPanel("output") },
    {
      id: "help.welcome",
      title: "Pantalla de bienvenida",
      category: "Ayuda",
      icon: "home",
      run: () => openEditor({ kind: "welcome" }),
    },
    {
      id: "window.reload",
      title: "Reiniciar editor",
      category: "Editor",
      icon: "refresh",
      run: () => window.location.reload(),
    },
    {
      id: "remote.connect",
      title: "Conectar el celular",
      category: "GuilleCode",
      icon: "device-mobile",
      run: () => openEditor({ kind: "remote" }),
    },
    {
      id: "desktop.control",
      title: "Control de la PC (el agente usa apps y tu Chrome)",
      category: "GuilleCode",
      icon: "vm",
      run: () => openEditor({ kind: "desktop" }),
    },
    {
      id: "accounts.chatgpt",
      title: "Cuentas de IA: conectar ChatGPT, OpenCode o quitar proveedores",
      category: "GuilleCode",
      icon: "account",
      run: () => openEditor({ kind: "accounts" }),
    },
    {
      id: "routines.new",
      title: "Nueva rutina programada",
      category: "GuilleCode",
      icon: "calendar",
      run: () => openEditor({ kind: "routine", id: "new" }),
    },
    {
      id: "hub.autostart",
      title: "Iniciar GuilleCode con Windows (activar/desactivar)",
      category: "GuilleCode",
      icon: "rocket",
      run: () => void toggleAutostart(),
    },
    {
      id: "hub.closeToTray",
      title: "Al cerrar la ventana: mandar a la bandeja / salir",
      category: "GuilleCode",
      icon: "window",
      run: () => setCloseToTray(!closeToTray()),
    },
    {
      id: "hub.quit",
      title: "Salir de GuilleCode",
      category: "GuilleCode",
      icon: "sign-out",
      run: () => void requestQuit(),
    },
  ]
  registerCommands(cmds)
}
