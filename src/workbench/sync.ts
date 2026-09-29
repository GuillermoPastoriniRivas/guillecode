import { call, onEvent } from "../lib/tauri"
import { normalizePath } from "../lib/paths"
import { debounce } from "../lib/persist"
import { refreshForPaths } from "../state/explorer"
import { markIndexStale } from "../state/fileIndex"
import { bumpHead, scheduleGitRefresh } from "../state/git"
import { handleExternalChange, refreshAllGitDecorations } from "../editor/documents"
import {
  selectSession,
  subscribeAgentFileEdits,
  subscribeBranchChanges,
  subscribeSessionFinished,
  useAgent,
} from "../state/agent"
import { useToasts } from "../state/toasts"
import { openEditor } from "../state/editors"
import { useLayout } from "../state/layout"

type FsChanged = { root: string; paths: string[]; git: boolean }

const refreshDecorationsSoon = debounce(() => refreshAllGitDecorations(), 600)

export function startSync(root: string): () => void {
  void call("watch_start", { root }).catch(() => undefined)
  const offFs = onEvent<FsChanged>("fs://changed", (e) => {
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
    if (!session) return
    const visible = useLayout.getState().agentVisible && agent.activeSessionId === sessionID && document.hasFocus()
    if (visible) return
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
    void call("watch_stop").catch(() => undefined)
  }
}
