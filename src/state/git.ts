import { create } from "zustand"
import {
  decorationOf,
  gitStatus,
  gitSubrepos,
  type Decoration,
  type GitStatus,
  type StatusEntry,
} from "../lib/git"
import { ancestors, isInside, joinPath, normalizePath } from "../lib/paths"
import { debounce } from "../lib/persist"
import { errorMessage } from "../lib/tauri"
import { notify } from "./toasts"

export type RepoState = {
  status: GitStatus | null
  error: string | null
  loading: boolean
  loadedAt: number
}

type GitStore = {
  repos: string[]
  activeRepo: string | null
  byRepo: Record<string, RepoState>
  decorations: Record<string, Decoration>
  dirtyFolders: Record<string, true>
  untrackedDirs: string[]
  busy: string | null
  revision: number
  headRevision: number
}

export const useGit = create<GitStore>(() => ({
  repos: [],
  activeRepo: null,
  byRepo: {},
  decorations: {},
  dirtyFolders: {},
  untrackedDirs: [],
  busy: null,
  revision: 0,
  headRevision: 0,
}))

export function bumpHead(): void {
  useGit.setState((s) => ({ headRevision: s.headRevision + 1 }))
}

const key = (p: string) => normalizePath(p).toLowerCase()

function rebuildDecorations(byRepo: Record<string, RepoState>) {
  const decorations: Record<string, Decoration> = {}
  const dirtyFolders: Record<string, true> = {}
  const untrackedDirs: string[] = []
  for (const [repo, state] of Object.entries(byRepo)) {
    for (const entry of state.status?.entries ?? []) {
      const isDir = entry.path.endsWith("/")
      const abs = joinPath(repo, isDir ? entry.path.slice(0, -1) : entry.path)
      const d = decorationOf(entry)
      decorations[key(abs)] = d
      if (isDir) untrackedDirs.push(key(abs) + "/")
      for (const dir of ancestors(repo, abs)) dirtyFolders[key(dir)] = true
    }
  }
  return { decorations, dirtyFolders, untrackedDirs }
}

export function decorationIn(
  decorations: Record<string, Decoration>,
  untrackedDirs: string[],
  path: string,
): Decoration | undefined {
  const k = key(path)
  const direct = decorations[k]
  if (direct) return direct
  return untrackedDirs.some((d) => k.startsWith(d)) ? "untracked" : undefined
}

let projectRoot: string | null = null

export async function initGit(root: string): Promise<void> {
  projectRoot = root
  try {
    const repos = await gitSubrepos(root)
    const activeRepo = repos.find((r) => key(r) === key(root)) ?? repos[0] ?? null
    useGit.setState({ repos, activeRepo })
    await Promise.all(repos.map((r) => refreshRepo(r)))
  } catch {
    useGit.setState({ repos: [], activeRepo: null })
  }
}

export async function refreshRepo(repo: string): Promise<void> {
  useGit.setState((s) => ({
    byRepo: { ...s.byRepo, [repo]: { ...(s.byRepo[repo] ?? { status: null, error: null, loadedAt: 0 }), loading: true } },
  }))
  try {
    const status = await gitStatus(repo)
    useGit.setState((s) => {
      const byRepo = { ...s.byRepo, [repo]: { status, error: null, loading: false, loadedAt: Date.now() } }
      return { byRepo, ...rebuildDecorations(byRepo), revision: s.revision + 1 }
    })
  } catch (e) {
    useGit.setState((s) => ({
      byRepo: { ...s.byRepo, [repo]: { status: null, error: errorMessage(e), loading: false, loadedAt: Date.now() } },
    }))
  }
}

export function refreshAllRepos(): Promise<void> {
  return Promise.all(useGit.getState().repos.map((r) => refreshRepo(r))).then(() => undefined)
}

export const scheduleGitRefresh = debounce(() => {
  void refreshAllRepos()
}, 350)

export function repoForPath(path: string): string | null {
  const repos = useGit.getState().repos
  let best: string | null = null
  for (const r of repos) if (isInside(r, path) && (!best || r.length > best.length)) best = r
  return best
}

export function setActiveRepo(repo: string): void {
  useGit.setState({ activeRepo: repo })
}

export function decorationFor(path: string): Decoration | undefined {
  const s = useGit.getState()
  return decorationIn(s.decorations, s.untrackedDirs, path)
}

export function statusEntryFor(path: string): { repo: string; entry: StatusEntry } | null {
  const repo = repoForPath(path)
  if (!repo) return null
  const rel = normalizePath(path).slice(normalizePath(repo).length + 1).toLowerCase()
  const entry = useGit.getState().byRepo[repo]?.status?.entries.find((e) => e.path.toLowerCase() === rel)
  return entry ? { repo, entry } : null
}

let actionQueue: Promise<unknown> = Promise.resolve()

export function gitAction<T>(label: string, work: () => Promise<T>, success?: string): Promise<T | undefined> {
  const run = actionQueue.then(() => runGitAction(label, work, success))
  actionQueue = run.catch(() => undefined)
  return run
}

async function runGitAction<T>(label: string, work: () => Promise<T>, success?: string): Promise<T | undefined> {
  useGit.setState({ busy: label })
  try {
    const result = await work()
    if (success) notify.success(success)
    return result
  } catch (e) {
    notify.error(label, errorMessage(e))
    return undefined
  } finally {
    useGit.setState({ busy: null })
    bumpHead()
    await refreshAllRepos()
  }
}

export function currentProjectRoot(): string | null {
  return projectRoot
}
