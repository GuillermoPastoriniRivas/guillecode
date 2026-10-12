import { call } from "./tauri"
import { normalizePath } from "./paths"
import type { Commit, CommitFile } from "./git"
import type { Changes } from "./featureText"

export type { Changes } from "./featureText"
export { changeCount, slugify } from "./featureText"

export type FeatureKind = "main" | "managed" | "external"

export type Feature = {
  id: string | null
  path: string
  root: string
  repo: string
  group: string | null
  label: string
  kind: FeatureKind
  branch: string | null
  head: string | null
  detached: boolean
  locked: string | null
  prunable: string | null
  missing: boolean
  archived: boolean
  base: string | null
  baseSource: "registered" | "reflog" | "upstream" | "inferred" | "unknown"
  baseOid: string | null
  createdAt: number | null
  changes: Changes | null
  merging: boolean
  ahead: number | null
  behind: number | null
}

export type ProjectSettings = { run: string | null; setup: string | null; copy: string[] }

export type WorkspaceRepo = {
  repo: string
  name: string
  path: string
  root: string
  branch: string | null
  head: string | null
  detached: boolean
  base: string | null
  baseSource: string
  kind: "main" | "feature"
  missing: boolean
  changes: Changes | null
  merging: boolean
  ahead: number | null
  behind: number | null
}

export type Workspace = {
  id: string
  label: string
  kind: "main" | "feature"
  repos: WorkspaceRepo[]
  createdAt: number | null
  archived: boolean
}

export type RepoGroup = {
  path: string
  main: string
  name: string
  branch: string | null
  head: string | null
  detached: boolean
  defaultBase: string | null
  worktreesDir: string
  settings: ProjectSettings
  changes: Changes | null
  merging: boolean
}

export type FeatureList = {
  git: boolean
  multi: boolean
  project: string
  repo: string
  defaultBase: string | null
  worktreesDir: string
  features: Feature[]
  repos: RepoGroup[]
  workspaces: Workspace[]
  settings: ProjectSettings
}

export type WorkspaceCreateResult = {
  workspace: string
  label: string
  repos: CreateResult[]
  failed: Array<{ repo: string; name: string; error: string }>
}

export type CopyCandidate = { path: string; dir: boolean; suggested: boolean }

export type CreateResult = { feature: Feature; copied: string[]; skipped: string[] }

export type RemoveCheck = {
  main: boolean
  missing: boolean
  locked: string | null
  branch: string | null
  base: string | null
  changes: Changes
  dirty: string[]
  unmerged: number
  merging: boolean
  ignored: string[]
  ignoredTotal: number
}

export type RemoveResult = { branchDeleted: boolean; warning: string | null }

export type MergePreview = {
  source: string
  sourceHead: string
  target: string
  targetHead: string
  targetCheckout: string | null
  targetChanges: Changes | null
  targetMerging: boolean
  sourceChanges: Changes
  commits: Commit[]
  totalCommits: number
  stat: string
  conflicts: string[]
  upToDate: boolean
  fastForward: boolean
}

export type MergeResult = { status: "merged" | "conflicts" | "up_to_date"; head: string | null; checkout: string | null; conflicts: string[] }

function normalizeFeature(f: Feature): Feature {
  return { ...f, baseSource: f.baseSource || "unknown", path: normalizePath(f.path), root: normalizePath(f.root), repo: f.repo ? normalizePath(f.repo) : f.repo }
}

function normalizeGroup(g: RepoGroup): RepoGroup {
  return { ...g, path: normalizePath(g.path), main: normalizePath(g.main), worktreesDir: normalizePath(g.worktreesDir) }
}

function normalizeWorkspace(w: Workspace): Workspace {
  return {
    ...w,
    repos: (w.repos ?? []).map((r) => ({
      ...r,
      repo: normalizePath(r.repo),
      path: normalizePath(r.path),
      root: normalizePath(r.root),
    })),
  }
}

export async function featuresList(project: string): Promise<FeatureList> {
  const list = await call<FeatureList>("features_list", { project })
  return {
    ...list,
    project: list.project ? normalizePath(list.project) : list.project,
    repo: list.repo ? normalizePath(list.repo) : list.repo,
    worktreesDir: list.worktreesDir ? normalizePath(list.worktreesDir) : list.worktreesDir,
    features: list.features.map(normalizeFeature),
    repos: list.repos.map(normalizeGroup),
    workspaces: (list.workspaces ?? []).map(normalizeWorkspace),
  }
}

export async function featuresCreate(args: {
  project: string
  label: string
  branch: string
  base: string
  existing: boolean
  copy: string[]
}): Promise<CreateResult> {
  const result = await call<CreateResult>("features_create", { args })
  return { ...result, feature: normalizeFeature(result.feature) }
}

export const featuresUpdate = (args: { project: string; path: string; label?: string; archived?: boolean; base?: string }) =>
  call<void>("features_update", { args })

export const featuresSetSettings = (project: string, settings: ProjectSettings) =>
  call<void>("features_set_settings", { project, settings })

export const featuresCopyCandidates = (project: string) => call<CopyCandidate[]>("features_copy_candidates", { project })

export const featuresRemoveCheck = (project: string, path: string) =>
  call<RemoveCheck>("features_remove_check", { project, path })

export const featuresRemove = (args: { project: string; path: string; deleteBranch: boolean; force: boolean; forceBranch: boolean }) =>
  call<RemoveResult>("features_remove", { args })

export const featuresMergePreview = (project: string, sourcePath: string, target: string) =>
  call<MergePreview>("features_merge_preview", { project, sourcePath, target })

export const featuresMerge = (args: {
  project: string
  sourcePath: string
  target: string
  expectedSource: string
  expectedTarget: string
  message: string
}) => call<MergeResult>("features_merge", { args })

export const featuresUpdateFromBase = (project: string, path: string) =>
  call<MergeResult>("features_update_from_base", { project, path })

export type FeatureDiff = { base: string | null; mergeBase: string | null; head: string | null; commits: number; files: CommitFile[] }

export const featuresDiff = (project: string, path: string, base?: string) => call<FeatureDiff>("features_diff", { project, path, base: base || null })

export type WorkspaceCreateInput = {
  project: string
  label: string
  branch?: string | null
  base?: string | null
  bases?: Record<string, string>
  repos?: string[]
  existing?: boolean
  copy?: string[] | null
}

export async function workspaceCreate(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult> {
  const result = await call<WorkspaceCreateResult>("workspace_create", { args: input })
  return { ...result, repos: result.repos.map((r) => ({ ...r, feature: normalizeFeature(r.feature) })) }
}

export type WorkspaceRemoveCheck = {
  repos: RemoveCheck[]
  tracked: number
  untracked: number
  dirty: string[]
  ignoredTotal: number
  ignored: string[]
  unmerged: number
  merging: boolean
}

export const workspaceRemoveCheck = (project: string, workspace: string) =>
  call<WorkspaceRemoveCheck>("workspace_remove_check", { project, workspace })

export const workspaceRemove = (args: { project: string; workspace: string; deleteBranch: boolean; force: boolean; forceBranch: boolean }) =>
  call<RemoveResult[]>("workspace_remove", {
    project: args.project,
    workspace: args.workspace,
    deleteBranch: args.deleteBranch,
    force: args.force,
    forceBranch: args.forceBranch,
  })

export const gitMergeAbort = (worktree: string) => call<void>("git_merge_abort", { worktree })
export const gitMergeContinue = (worktree: string) => call<string>("git_merge_continue", { worktree })
