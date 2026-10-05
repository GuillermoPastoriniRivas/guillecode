import { call, onWindowEvent } from "../lib/tauri"
import { normalizePath, samePath } from "../lib/paths"
import { debounce } from "../lib/persist"
import { refreshForPaths } from "../state/explorer"
import { markIndexStale } from "../state/fileIndex"
import { bumpHead, scheduleGitRefresh } from "../state/git"
import { handleExternalChange, refreshAllGitDecorations } from "../editor/documents"
import {
  foreignDirectory,
  selectSession,
  subscribeAgentFileEdits,
  subscribeBranchChanges,
  subscribeSessionFinished,
  useAgent,
} from "../state/agent"
import { featureTitle, findFeature } from "../state/features"
import { useToasts } from "../state/toasts"
import { openEditor } from "../state/editors"
import { useLayout } from "../state/layout"
import { watchingSession } from "../state/unseen"

type FsChanged = { root: string; paths: string[]; git: boolean }

const refreshDecorationsSoon = debounce(() => refreshAllGitDecorations(), 600)

export function startSync(root: string): () => void {
  void call("watch_start", { root }).catch(() => undefined)
  const offFs = onWindowEvent<FsChanged>("fs://changed", (e) => {
    if (!samePath(e.root, root)) return
    const paths = e.paths.map(normalizePath)
    if (paths.length > 0) {
      refreshForPaths(paths)
      markIndexStale(root)
      for (const p of paths) void handleExternalChange(p)
    }
    scheduleGitRefresh()
    if (e.git) {
      bumpHead()
      refreshDecorationsSoon()
    }
  })
  const offEdits = subscribeAgentFileEdits((path) => {
    void handleExternalChange(path)
    scheduleGitRefresh()
  })
  const offBranch = subscribeBranchChanges(() => {
    scheduleGitRefresh()
    refreshDecorationsSoon()
  })
  const offFinished = subscribeSessionFinished((sessionID) => {
    scheduleGitRefresh()
    const agent = useAgent.getState()
    const session = agent.sessions.find((s) => s.id === sessionID)
    if (!session) {
      const other = agent.allSessions.find((s) => s.id === sessionID)
      if (!other || other.parentID || !foreignDirectory(sessionID)) return
      const feature = findFeature(normalizePath(other.directory))
      useToasts.getState().push({
        kind: "success",
        title: `El agente terminó en ${feature ? featureTitle(feature) : "otra feature"}: ${other.title || "sesión"}`,
        actions: [{ label: "Abrir", primary: true, run: () => selectSession(sessionID) }],
      })
      return
    }
    if (watchingSession(sessionID)) return
    useToasts.getState().push({
      kind: "success",
      title: `El agente terminó: ${session.title || "sesión"}`,
      actions: [
        {
          label: "Ver chat",
          run: () => {
            useLayout.getState().toggleAgent(true)
            selectSession(sessionID)
          },
        },
        { label: "Revisar cambios", primary: true, run: () => openEditor({ kind: "review", sessionId: sessionID }) },
      ],
    })
  })
  return () => {
    offFs()
    offEdits()
    offBranch()
    offFinished()
    void call("watch_stop", { root }).catch(() => undefined)
  }
}
