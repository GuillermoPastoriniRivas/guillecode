import { memo, useEffect, useMemo, useRef, useState } from "react"
import { revealItemInDir } from "@tauri-apps/plugin-opener"
import {
  cancelInlineEdit,
  collapseAll,
  loadDir,
  selectEntry,
  startCreate,
  startRename,
  toggleDir,
  useExplorer,
} from "../state/explorer"
import { decorationIn, useGit } from "../state/git"
import { useProject, pickProject } from "../state/project"
import { openEditor, openFile, useEditors } from "../state/editors"
import { addContext, focusComposer, useAgent } from "../state/agent"
import { useLayout } from "../state/layout"
import { notify } from "../state/toasts"
import { createTerminal } from "../state/terminals"
import { createDir, createFile, deletePaths, rename, type FsEntry } from "../lib/fs"
import { basename, dirname, joinPath, normalizePath, relativePath } from "../lib/paths"
import { decorationLetter, gitIgnoreAdd, ignorePatternFor } from "../lib/git"
import { errorMessage } from "../lib/tauri"
import { closeDocument, renameDocument } from "../editor/documents"
import { closeTabs } from "../editor/tabs"
import { openContextMenu, type MenuItem } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { EmptyState, FileIcon, Icon, IconButton } from "../components/ui"
import { PATH_DRAG_TYPE } from "../agent/Composer"

const k = (p: string) => normalizePath(p).toLowerCase()
const INDENT = 12

function useAgentTouched(): Set<string> {
  const root = useProject((s) => s.root)
  const activeId = useAgent((s) => s.activeSessionId)
  const view = useAgent((s) => (s.activeSessionId ? s.views[s.activeSessionId] : undefined))
  return useMemo(() => {
    const set = new Set<string>()
    if (!root || !activeId || !view) return set
    for (const m of view.messages) {
      for (const p of m.parts) {
        if (p.type !== "tool") continue
        if (!["edit", "write", "multiedit", "patch", "apply_patch"].includes(p.tool)) continue
        const input = (p.state as { input?: Record<string, unknown> }).input ?? {}
        const file = typeof input.filePath === "string" ? input.filePath : null
        if (file) set.add(k(file))
      }
    }
    return set
  }, [root, activeId, view])
}

function InlineInput({ initial, onSubmit, depth, icon }: { initial: string; onSubmit: (value: string | null) => void; depth: number; icon?: string }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf(".")
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * INDENT }}>
      <span className="tree-twistie" />
      {icon ? <Icon name={icon} className="tree-folder-icon" /> : <FileIcon path={value || "archivo"} />}
      <input
        ref={ref}
        className="tree-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(value.trim() || null)
          if (e.key === "Escape") onSubmit(null)
          e.stopPropagation()
        }}
        onBlur={() => onSubmit(value.trim() || null)}
      />
    </div>
  )
}

async function removeEntries(paths: string[]) {
  const names = paths.map((p) => basename(p)).join(", ")
  const ok = await confirmAction(
    paths.length === 1 ? `¿Mandar ${names} a la papelera?` : `¿Mandar ${paths.length} elementos a la papelera?`,
    "Podés recuperarlos desde la Papelera de reciclaje.",
    "Mandar a la papelera",
    true,
  )
  if (!ok) return
  try {
    await closeTabs((t) => t.input.kind === "file" && paths.some((p) => k(t.input.kind === "file" ? t.input.path : "").startsWith(k(p))))
    await deletePaths(paths)
    for (const p of paths) closeDocument(p)
  } catch (e) {
    notify.error("No se pudo borrar", errorMessage(e))
  }
}

function entryMenu(e: React.MouseEvent, entry: FsEntry, root: string) {
  const rel = relativePath(root, entry.path)
  const parent = entry.isDir ? entry.path : dirname(entry.path)
  const items: MenuItem[] = []
  if (!entry.isDir) {
    items.push(
      { label: "Abrir", icon: "go-to-file", run: () => openFile(entry.path) },
      { label: "Abrir a la derecha", icon: "split-horizontal", run: () => {
        const s = useEditors.getState()
        const idx = s.groups.findIndex((g) => g.id === s.activeGroupId)
        const target = s.groups[idx + 1]
        openFile(entry.path, target ? { groupId: target.id } : {})
      } },
      { separator: true },
    )
  }
  items.push(
    { label: "Nuevo archivo…", icon: "new-file", run: () => startCreate(parent, "file") },
    { label: "Nueva carpeta…", icon: "new-folder", run: () => startCreate(parent, "folder") },
    { separator: true },
    {
      label: entry.isDir ? "Agregar carpeta al chat" : "Agregar al chat",
      icon: "sparkle",
      run: () => {
        addContext({ kind: "file", path: entry.path })
        useLayout.getState().toggleAgent(true)
        focusComposer()
      },
    },
  )
  if (!entry.isDir) {
    items.push({
      label: "Pedirle al agente que lo explique",
      icon: "comment-discussion",
      run: () => {
        addContext({ kind: "file", path: entry.path })
        useLayout.getState().toggleAgent(true)
        focusComposer(`Explicame qué hace ${rel} y cómo se usa en el proyecto.`)
      },
    })
  }
  items.push(
    { separator: true },
    { label: "Abrir terminal acá", icon: "terminal", run: () => createTerminal({ cwd: parent }) },
    { label: "Mostrar en el Explorador de Windows", icon: "folder-opened", run: () => void revealItemInDir(entry.path) },
    { label: "Copiar ruta", icon: "copy", run: () => void navigator.clipboard.writeText(entry.path.replace(/\//g, "\\")) },
    { label: "Copiar ruta relativa", run: () => void navigator.clipboard.writeText(rel) },
    { separator: true },
    { label: "Renombrar…", icon: "edit", keys: "f2", run: () => startRename(entry.path) },
    {
      label: "Agregar a .gitignore",
      icon: "circle-slash",
      run: () => {
        const repo = useGit.getState().repos.find((r) => entry.path.toLowerCase().startsWith(r.toLowerCase()))
        if (!repo) return
        void gitIgnoreAdd(repo, [ignorePatternFor(relativePath(repo, entry.path) + (entry.isDir ? "/" : ""))])
          .then(() => notify.success(`${basename(entry.path)} agregado a .gitignore`))
          .catch((err) => notify.error("No se pudo actualizar .gitignore", errorMessage(err)))
      },
    },
    { label: "Mandar a la papelera", icon: "trash", danger: true, keys: "delete", run: () => void removeEntries([entry.path]) },
  )
  openContextMenu(e, items)
}

const TreeRow = memo(function TreeRow({
  entry,
  depth,
  expanded,
  selected,
  decoration,
  folderDirty,
  touched,
  root,
}: {
  entry: FsEntry
  depth: number
  expanded: boolean
  selected: boolean
  decoration: string | undefined
  folderDirty: boolean
  touched: boolean
  root: string
}) {
  return (
    <div
      className={`tree-row${selected ? " selected" : ""}${entry.heavy ? " heavy" : ""}${decoration ? ` git-${decoration}` : ""}`}
      style={{ paddingLeft: 8 + depth * INDENT }}
      data-path={entry.path}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PATH_DRAG_TYPE, entry.path)
        e.dataTransfer.setData("text/plain", relativePath(root, entry.path))
      }}
      onClick={() => {
        selectEntry(entry.path)
        if (entry.isDir) void toggleDir(entry.path)
        else openFile(entry.path, { preview: true, focus: false })
      }}
      onDoubleClick={() => {
        if (!entry.isDir) openFile(entry.path, { preview: false })
      }}
      onContextMenu={(e) => {
        selectEntry(entry.path)
        entryMenu(e, entry, root)
      }}
      title={relativePath(root, entry.path)}
    >
      <span className="tree-twistie">{entry.isDir && <Icon name={expanded ? "chevron-down" : "chevron-right"} />}</span>
      {entry.isDir ? (
        <Icon name={expanded ? "folder-opened" : "folder"} className="tree-folder-icon" />
      ) : (
        <FileIcon path={entry.name} />
      )}
      <span className="tree-label">{entry.name}</span>
      {touched && <Icon name="sparkle" className="tree-agent" title="Lo tocó el agente en esta sesión" />}
      {entry.isDir ? folderDirty && <span className="tree-dot" /> : decoration && <span className="tree-deco">{decorationLetter(decoration as never)}</span>}
    </div>
  )
})

export function ExplorerView() {
  const root = useProject((s) => s.root)
  const { children, expanded, selected, renaming, creating, revealNonce } = useExplorer()
  const decorations = useGit((s) => s.decorations)
  const dirtyFolders = useGit((s) => s.dirtyFolders)
  const untrackedDirs = useGit((s) => s.untrackedDirs)
  const touched = useAgentTouched()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!selected || !listRef.current) return
    const el = listRef.current.querySelector(`[data-path="${CSS.escape(selected)}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [revealNonce, selected])

  if (!root)
    return (
      <EmptyState icon="folder-opened" title="No hay carpeta abierta" action={<button type="button" className="btn btn-primary" onClick={() => void pickProject()}>Abrir carpeta</button>} />
    )

  const submitCreate = async (value: string | null) => {
    const pending = creating
    cancelInlineEdit()
    if (!value || !pending) return
    const target = joinPath(pending.parent, value)
    try {
      if (pending.kind === "folder") await createDir(target)
      else {
        await createFile(target)
        openFile(target)
      }
      await loadDir(pending.parent)
    } catch (e) {
      notify.error("No se pudo crear", errorMessage(e))
    }
  }

  const submitRename = async (entry: FsEntry, value: string | null) => {
    cancelInlineEdit()
    if (!value || value === entry.name) return
    const target = joinPath(dirname(entry.path), value)
    try {
      await rename(entry.path, target)
      renameDocument(entry.path, target)
      useEditors.setState((s) => ({
        groups: s.groups.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) =>
            t.input.kind === "file" && k(t.input.path) === k(entry.path)
              ? { ...t, input: { kind: "file", path: target }, id: `file:${k(target)}` }
              : t,
          ),
          activeId: g.activeId === `file:${k(entry.path)}` ? `file:${k(target)}` : g.activeId,
        })),
      }))
      await loadDir(dirname(entry.path))
    } catch (e) {
      notify.error("No se pudo renombrar", errorMessage(e))
    }
  }

  const rows: React.ReactNode[] = []
  const walk = (dir: string, depth: number) => {
    if (creating && k(creating.parent) === k(dir)) {
      rows.push(
        <InlineInput key={`create-${dir}`} initial="" depth={depth} icon={creating.kind === "folder" ? "folder" : undefined} onSubmit={(v) => void submitCreate(v)} />,
      )
    }
    for (const entry of children[k(dir)] ?? []) {
      const isOpen = !!expanded[k(entry.path)]
      if (renaming && k(renaming) === k(entry.path)) {
        rows.push(<InlineInput key={entry.path} initial={entry.name} depth={depth} icon={entry.isDir ? "folder" : undefined} onSubmit={(v) => void submitRename(entry, v)} />)
      } else {
        rows.push(
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={depth}
            expanded={isOpen}
            selected={!!selected && k(selected) === k(entry.path)}
            decoration={decorationIn(decorations, untrackedDirs, entry.path)}
            folderDirty={!!dirtyFolders[k(entry.path)]}
            touched={touched.has(k(entry.path))}
            root={root}
          />,
        )
      }
      if (entry.isDir && isOpen) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)

  return (
    <div className="view explorer-view">
      <div className="view-header">
        <span className="view-title">{basename(root)}</span>
        <span className="view-actions">
          <IconButton icon="new-file" title="Nuevo archivo" onClick={() => startCreate(selected && !selected.includes(".") ? selected : root, "file")} />
          <IconButton icon="new-folder" title="Nueva carpeta" onClick={() => startCreate(root, "folder")} />
          <IconButton icon="refresh" title="Refrescar" onClick={() => void loadDir(root).then(() => Object.keys(expanded).length)} />
          <IconButton icon="collapse-all" title="Colapsar todo" onClick={collapseAll} />
        </span>
      </div>
      <div
        className="tree"
        ref={listRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!selected) return
          if (e.key === "F2") {
            e.preventDefault()
            startRename(selected)
          } else if (e.key === "Delete") {
            e.preventDefault()
            void removeEntries([selected])
          } else if (e.key === "Enter") {
            e.preventDefault()
            const entry = Object.values(children).flat().find((x) => k(x.path) === k(selected))
            if (entry?.isDir) void toggleDir(entry.path)
            else if (entry) openEditor({ kind: "file", path: entry.path })
          }
        }}
      >
        {rows}
      </div>
    </div>
  )
}
