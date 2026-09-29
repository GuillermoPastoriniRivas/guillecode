import { call } from "./tauri"
import { normalizePath } from "./paths"

export type StatusEntry = {
  path: string
  orig: string | null
  index: string
  worktree: string
}

export type GitStatus = {
  branch: string
  detached: boolean
  upstream: string | null
  gone: boolean
  ahead: number
  behind: number
  entries: StatusEntry[]
  truncated: boolean
}

export type Commit = {
  hash: string
  parents: string[]
  author: string
  email: string
  time: number
  refs: string[]
  subject: string
}

export type CommitFile = {
  path: string
  orig: string | null
  status: string
  additions: number
  deletions: number
}

export type CommitDetail = {
  commit: Commit
  body: string
  parent: string
  files: CommitFile[]
}

export type Branch = {
  name: string
  full: string
  remote: boolean
  current: boolean
  upstream: string | null
  time: number
  subject: string
}

export type BlameLine = {
  line: number
  hash: string
  author: string
  email: string
  time: number
  subject: string
}

export type DiffContext = { stat: string; log: string; diff: string; truncated: boolean }

export const UNCOMMITTED_HASH = /^0+$/

export const gitRoot = (path: string) => call<string>("git_root", { path }).then(normalizePath)
export const gitStatus = (worktree: string) => call<GitStatus>("git_status", { worktree })
export const gitLog = (worktree: string, opts: { limit?: number; skip?: number; all?: boolean; file?: string } = {}) =>
  call<Commit[]>("git_log", { worktree, limit: opts.limit, skip: opts.skip, all: opts.all, file: opts.file })
export const gitCommitDetail = (worktree: string, hash: string) => call<CommitDetail>("git_commit_detail", { worktree, hash })
export const gitShowFile = (worktree: string, rev: string, file: string) => call<string>("git_show_file", { worktree, rev, file })
export const gitShowFileBase64 = (worktree: string, rev: string, file: string) =>
  call<string>("git_show_file_base64", { worktree, rev, file })
export const gitDiffFile = (worktree: string, file: string, staged: boolean) =>
  call<string>("git_diff_file", { worktree, file, staged })
export const gitBranches = (worktree: string) => call<Branch[]>("git_branches", { worktree })
export const gitCheckout = (worktree: string, branch: string, create = false, from?: string) =>
  call<void>("git_checkout", { worktree, branch, create, from })
export const gitSubrepos = (worktree: string) => call<string[]>("git_subrepos", { worktree }).then((r) => r.map(normalizePath))
export const gitStage = (worktree: string, files: string[]) => call<void>("git_stage", { worktree, files })
export const gitStageAll = (worktree: string) => call<void>("git_stage_all", { worktree })
export const gitUnstage = (worktree: string, files: string[]) => call<void>("git_unstage", { worktree, files })
export const gitUnstageAll = (worktree: string) => call<void>("git_unstage_all", { worktree })
export const gitDiscard = (worktree: string, tracked: string[], untracked: string[]) =>
  call<void>("git_discard", { worktree, tracked, untracked })
export const gitApplyPatch = (worktree: string, patch: string, cached: boolean, reverse: boolean) =>
  call<void>("git_apply_patch", { worktree, patch, cached, reverse })
export const gitIgnoreAdd = (worktree: string, patterns: string[]) => call<void>("git_ignore_add", { worktree, patterns })
export const gitCommit = (worktree: string, message: string, amend = false) =>
  call<string>("git_commit", { worktree, message, amend })
export const gitPush = (worktree: string, force = false) => call<string>("git_push", { worktree, force })
export const gitPull = (worktree: string) => call<string>("git_pull", { worktree })
export const gitFetch = (worktree: string) => call<string>("git_fetch", { worktree })
export const gitStash = (worktree: string, pop: boolean, message?: string) =>
  call<string>("git_stash", { worktree, pop, message })
export const gitBlame = (worktree: string, file: string, contents?: string) =>
  call<BlameLine[]>("git_blame", { worktree, file, contents })
export const gitDefaultBranch = (worktree: string) => call<string>("git_default_branch", { worktree })
export const gitStagedContext = (worktree: string) => call<DiffContext>("git_staged_context", { worktree })
export const gitRangeContext = (worktree: string, base: string) => call<DiffContext>("git_range_context", { worktree, base })
export type ChangesContext = { stat: string; diff: string; untracked: string[]; truncated: boolean }
export const gitChangesContext = (worktree: string) => call<ChangesContext>("git_changes_context", { worktree })

export type RefKind = "head" | "local" | "remote" | "tag" | "other"

export function parseRef(raw: string): { name: string; kind: RefKind } {
  const head = raw.startsWith("HEAD -> ")
  const ref = head ? raw.slice(8) : raw
  if (ref.startsWith("tag: ")) return { name: ref.slice(5).replace(/^refs\/tags\//, ""), kind: "tag" }
  if (ref.startsWith("refs/heads/")) return { name: ref.slice(11), kind: head ? "head" : "local" }
  if (ref.startsWith("refs/remotes/")) return { name: ref.slice(13), kind: "remote" }
  if (ref === "HEAD") return { name: "HEAD", kind: "head" }
  return { name: ref.replace(/^refs\//, ""), kind: head ? "head" : "other" }
}

export function isUntracked(e: StatusEntry): boolean {
  return e.index === "?" && e.worktree === "?"
}

export function hasStaged(e: StatusEntry): boolean {
  return e.index !== " " && e.index !== "?" && e.index !== "!"
}

export function hasUnstaged(e: StatusEntry): boolean {
  return isUntracked(e) || (e.worktree !== " " && e.worktree !== "!")
}

export function isConflict(e: StatusEntry): boolean {
  const pair = e.index + e.worktree
  return pair === "UU" || pair === "AA" || pair === "DD" || e.index === "U" || e.worktree === "U"
}

export type Decoration = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflict" | "ignored"

export function decorationOf(e: StatusEntry): Decoration {
  if (isConflict(e)) return "conflict"
  if (isUntracked(e)) return "untracked"
  const code = e.worktree !== " " ? e.worktree : e.index
  if (code === "A") return "added"
  if (code === "D") return "deleted"
  if (code === "R" || code === "C") return "renamed"
  return "modified"
}

export function decorationLetter(d: Decoration): string {
  switch (d) {
    case "modified":
      return "M"
    case "added":
      return "A"
    case "deleted":
      return "D"
    case "untracked":
      return "U"
    case "renamed":
      return "R"
    case "conflict":
      return "!"
    case "ignored":
      return ""
  }
}

const GENERATED_DIRS = new Set(["node_modules", "target", "dist", "build", ".next", "coverage", ".turbo", "vendor", "__pycache__"])

export function ignorePatternFor(file: string): string {
  const segs = file.replace(/\\/g, "/").split("/")
  if (segs.length > 1 && GENERATED_DIRS.has(segs[0])) return `${segs[0]}/`
  return file
}
