import { Fragment, useMemo, useRef, useState } from "react"
import {
  inputTitle,
  moveTabToNextGroup,
  moveTabToPreviousGroup,
  openEditor,
  pinTab,
  setActiveGroup,
  setActiveTab,
  useEditors,
  type EditorInput,
  type Group,
  type Tab,
} from "../state/editors"
import { useAgent, addContext, focusComposer } from "../state/agent"
import { decorationFor, repoForPath, statusEntryFor, useGit } from "../state/git"
import { useLayout } from "../state/layout"
import { useProject } from "../state/project"
import { useRoutines } from "../state/routines"
import { useSessionMark } from "../state/unseen"
import { revealInExplorer } from "../state/explorer"
import { basename, dirname, relativePath } from "../lib/paths"
import { decorationLetter } from "../lib/git"
import { docKey, useDocs } from "./documents"
import { closeAllTabs, closeOtherTabs, closeSavedTabs, closeTab, closeTabsToRight } from "./tabs"
import { FileEditor } from "./FileEditor"
import { GitDiffEditor, CommitFileEditor } from "./GitDiffEditor"
import { ReviewEditor } from "./ReviewEditor"
import { GraphEditor } from "./GraphEditor"
import { CommitEditor } from "./CommitEditor"
import { PrCreateEditor, PrEditor } from "./PrEditor"
import { WelcomeEditor } from "./WelcomeEditor"
import { AiReviewEditor } from "./AiReviewEditor"
import { RoutineEditor } from "./RoutineEditor"
import { RemoteEditor } from "./RemoteEditor"
import { DesktopEditor } from "./DesktopEditor"
import { AccountsEditor } from "./AccountsEditor"
import { FeatureCreateEditor, FeatureIntegrateEditor } from "./FeatureEditor"
import { SessionPane } from "../agent/AgentPanel"
import { openContextMenu, openMenuAt, type MenuItem } from "../components/ContextMenu"
import { Sash } from "../components/Sash"
import { FileIcon, Icon, IconButton } from "../components/ui"
import { PATH_DRAG_TYPE } from "../agent/Composer"

function tabIcon(input: EditorInput) {
  switch (input.kind) {
    case "file":
      return <FileIcon path={input.path} />
    case "diff":
      return <Icon name="diff" className="tab-icon diff" />
    case "commit":
    case "graph":
      return <Icon name="git-commit" className="tab-icon git" />
    case "commitFile":
      return <Icon name="diff-single" className="tab-icon git" />
    case "review":
      return <Icon name="diff-multiple" className="tab-icon review" />
    case "pr":
    case "prCreate":
      return <Icon name="git-pull-request" className="tab-icon pr" />
    case "chat":
      return <Icon name="comment-discussion" className="tab-icon chat" />
    case "aiReview":
      return <Icon name="sparkle" className="tab-icon review" />
    case "routine":
      return <Icon name="calendar" className="tab-icon" />
    case "remote":
      return <Icon name="device-mobile" className="tab-icon" />
    case "desktop":
      return <Icon name="vm" className="tab-icon" />
    case "accounts":
      return <Icon name="account" className="tab-icon" />
    case "featureCreate":
      return <Icon name="git-branch-create" className="tab-icon git" />
    case "featureIntegrate":
      return <Icon name="git-merge" className="tab-icon git" />
    case "welcome":
      return <Icon name="home" className="tab-icon" />
  }
}

function useTabTitle(input: EditorInput): string {
  const sessionTitle = useAgent((s) =>
    input.kind === "chat" || input.kind === "review" ? s.sessions.find((x) => x.id === input.sessionId)?.title : undefined,
  )
  const routineName = useRoutines((s) => (input.kind === "routine" ? s.items.find((r) => r.id === input.id)?.name : undefined))
  if (input.kind === "chat") return sessionTitle || "Chat"
  if (input.kind === "review") return `Revisión · ${sessionTitle || "sesión"}`
  if (input.kind === "routine" && routineName) return routineName
  return inputTitle(input)
}

function TabView({
  tab,
  group,
  active,
  duplicate,
}: {
  tab: Tab
  group: Group
  active: boolean
  duplicate: boolean
}) {
  const title = useTabTitle(tab.input)
  const root = useProject((s) => s.root)
  const dirty = useDocs((s) => (tab.input.kind === "file" ? !!s.dirty[docKey(tab.input.path)] : false))
  useGit((s) => s.revision)
  const decoration = tab.input.kind === "file" ? decorationFor(tab.input.path) : undefined
  const mark = useSessionMark(tab.input.kind === "chat" ? tab.input.sessionId : "")
  const hint =
    duplicate && tab.input.kind === "file" && root ? basename(dirname(relativePath(root, tab.input.path))) : null

  const menu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: "Cerrar", icon: "close", keys: "ctrl+w", run: () => void closeTab(tab.id) },
      { label: "Cerrar las demás", run: () => void closeOtherTabs(tab.id) },
      { label: "Cerrar las de la derecha", run: () => void closeTabsToRight(tab.id) },
      { label: "Cerrar las guardadas", run: () => void closeSavedTabs(group.id) },
      { label: "Cerrar todas", run: () => void closeAllTabs(group.id) },
      { separator: true },
      { label: "Mover al grupo de la derecha", icon: "split-horizontal", run: () => moveTabToNextGroup(tab.id) },
      { label: "Mover al grupo de la izquierda", run: () => moveTabToPreviousGroup(tab.id) },
    ]
    if (tab.input.kind === "file") {
      const path = tab.input.path
      items.push(
        { separator: true },
        { label: "Copiar ruta", icon: "copy", run: () => void navigator.clipboard.writeText(path) },
        { label: "Copiar ruta relativa", run: () => void navigator.clipboard.writeText(root ? relativePath(root, path) : path) },
        {
          label: "Mostrar en el explorador",
          icon: "files",
          run: () => {
            useLayout.getState().showView("explorer", false)
            void revealInExplorer(path)
          },
        },
        {
          label: "Agregar al chat",
          icon: "sparkle",
          run: () => {
            addContext({ kind: "file", path })
            useLayout.getState().toggleAgent(true)
            focusComposer()
          },
        },
      )
    }
    openContextMenu(e, items)
  }

  return (
    <div
      className={`tab${active ? " active" : ""}${tab.preview ? " preview" : ""}${dirty ? " dirty" : ""}${decoration ? ` git-${decoration}` : ""}${mark === "attention" || mark === "unseen" ? ` state-${mark}` : ""}`}
      title={tab.input.kind === "file" ? tab.input.path : title}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          void closeTab(tab.id)
        } else if (e.button === 0) setActiveTab(group.id, tab.id)
      }}
      onDoubleClick={() => pinTab(tab.id)}
      onContextMenu={menu}
      draggable={tab.input.kind === "file"}
      onDragStart={(e) => {
        if (tab.input.kind === "file") e.dataTransfer.setData(PATH_DRAG_TYPE, tab.input.path)
      }}
    >
      {mark === "attention" ? (
        <Icon name="bell-dot" className="tab-icon attention" />
      ) : mark === "busy" ? (
        <Icon name="loading" spin className="tab-icon" />
      ) : mark === "unseen" ? (
        <Icon name="pass-filled" className="tab-icon done" />
      ) : (
        tabIcon(tab.input)
      )}
      <span className="tab-label">{title}</span>
      {hint && <span className="tab-hint">{hint}</span>}
      {decoration && <span className="tab-decoration">{decorationLetter(decoration)}</span>}
      <button
        type="button"
        className="tab-close"
        title="Cerrar (Ctrl+W)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          void closeTab(tab.id)
        }}
      >
        <Icon name={dirty ? "circle-filled" : "close"} className={dirty ? "dirty-dot" : ""} />
      </button>
    </div>
  )
}

function GroupActions({ group, tab }: { group: Group; tab: Tab | null }) {
  useGit((s) => s.revision)
  const path = tab?.input.kind === "file" ? tab.input.path : null
  const status = path ? statusEntryFor(path) : null
  return (
    <div className="tabs-actions">
      {path && status && (
        <IconButton
          icon="git-compare"
          title="Ver cambios de git de este archivo"
          onClick={() => {
            const repo = repoForPath(path)
            if (repo) openEditor({ kind: "diff", repo, path: relativePath(repo, path), staged: false })
          }}
        />
      )}
      {path && (
        <IconButton
          icon="sparkle"
          title="Agregar al chat (Ctrl+L)"
          onClick={() => {
            addContext({ kind: "file", path })
            useLayout.getState().toggleAgent(true)
            focusComposer()
          }}
        />
      )}
      {tab && <IconButton icon="split-horizontal" title="Mover al grupo de la derecha" onClick={() => moveTabToNextGroup(tab.id)} />}
      <IconButton
        icon="ellipsis"
        title="Más"
        onClick={(e) =>
          openMenuAt(e.currentTarget, [
            { label: "Cerrar todas", run: () => void closeAllTabs(group.id) },
            { label: "Cerrar las guardadas", run: () => void closeSavedTabs(group.id) },
          ])
        }
      />
    </div>
  )
}

function EditorGroupView({ group, isActiveGroup }: { group: Group; isActiveGroup: boolean }) {
  const active = group.tabs.find((t) => t.id === group.activeId) ?? null
  const filePath = active?.input.kind === "file" ? active.input.path : null
  const names = useMemo(() => {
    const count = new Map<string, number>()
    for (const t of group.tabs) if (t.input.kind === "file") count.set(basename(t.input.path), (count.get(basename(t.input.path)) ?? 0) + 1)
    return count
  }, [group.tabs])
  const tabsRef = useRef<HTMLDivElement>(null)

  return (
    <div className={`editor-group${isActiveGroup ? " active" : ""}`} onMouseDownCapture={() => setActiveGroup(group.id)}>
      {group.tabs.length > 0 && (
        <div className="tabs-bar">
          <div
            className="tabs"
            ref={tabsRef}
            onWheel={(e) => {
              if (tabsRef.current && e.deltaY !== 0) tabsRef.current.scrollLeft += e.deltaY
            }}
          >
            {group.tabs.map((t) => (
              <TabView
                key={t.id}
                tab={t}
                group={group}
                active={t.id === group.activeId}
                duplicate={t.input.kind === "file" && (names.get(basename(t.input.path)) ?? 0) > 1}
              />
            ))}
          </div>
          <GroupActions group={group} tab={active} />
        </div>
      )}
      <div className="editor-body">
        <FileEditor groupId={group.id} path={filePath} visible={!!filePath} />
        {active && active.input.kind !== "file" && <EditorContent tab={active} />}
        {!active && <WelcomeEditor />}
      </div>
    </div>
  )
}

function EditorContent({ tab }: { tab: Tab }) {
  const input = tab.input
  switch (input.kind) {
    case "diff":
      return <GitDiffEditor key={tab.id} repo={input.repo} path={input.path} staged={input.staged} tabId={tab.id} />
    case "commitFile":
      return <CommitFileEditor key={tab.id} repo={input.repo} hash={input.hash} parent={input.parent} path={input.path} orig={input.orig} label={input.label} />
    case "commit":
      return <CommitEditor key={tab.id} repo={input.repo} hash={input.hash} />
    case "review":
      return <ReviewEditor key={tab.id} sessionId={input.sessionId} />
    case "graph":
      return <GraphEditor key={tab.id} repo={input.repo} />
    case "pr":
      return <PrEditor key={tab.id} repo={input.repo} number={input.number} />
    case "prCreate":
      return <PrCreateEditor key={tab.id} repo={input.repo} />
    case "chat":
      return (
        <div className="chat-editor">
          <SessionPane key={tab.id} sessionId={input.sessionId} variant="editor" />
        </div>
      )
    case "aiReview":
      return <AiReviewEditor key={tab.id} input={input} />
    case "routine":
      return <RoutineEditor key={tab.id} id={input.id} />
    case "remote":
      return <RemoteEditor />
    case "desktop":
      return <DesktopEditor />
    case "accounts":
      return <AccountsEditor />
    case "featureCreate":
      return <FeatureCreateEditor key={tab.id} repo={input.repo ?? null} />
    case "featureIntegrate":
      return <FeatureIntegrateEditor key={tab.id} path={input.path} />
    case "welcome":
      return <WelcomeEditor />
    default:
      return null
  }
}

export function EditorArea() {
  const groups = useEditors((s) => s.groups)
  const activeGroupId = useEditors((s) => s.activeGroupId)
  const [ratios, setRatios] = useState<Record<string, number>>({})
  const areaRef = useRef<HTMLDivElement>(null)
  const startRatios = useRef<Record<string, number>>({})

  return (
    <div className="editor-area" ref={areaRef}>
      {groups.map((g, i) => (
        <Fragment key={g.id}>
          {i > 0 && (
            <Sash
              orientation="vertical"
              onDrag={(delta) => {
                const width = areaRef.current?.clientWidth ?? 1
                const left = groups[i - 1].id
                const right = g.id
                const base = startRatios.current
                const l0 = base[left] ?? ratios[left] ?? 1
                const r0 = base[right] ?? ratios[right] ?? 1
                if (!(left in base)) startRatios.current = { ...base, [left]: l0, [right]: r0 }
                const total = l0 + r0
                const shift = (delta / width) * groups.length
                const l = Math.max(0.15, Math.min(total - 0.15, l0 + shift))
                setRatios((prev) => ({ ...prev, [left]: l, [right]: total - l }))
              }}
              onDragEnd={() => {
                startRatios.current = {}
              }}
              onDoubleClick={() => setRatios({})}
            />
          )}
          <div className="editor-group-slot" style={{ flex: `${ratios[g.id] ?? 1} 1 0` }}>
            <EditorGroupView group={g} isActiveGroup={g.id === activeGroupId && groups.length > 1} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}
