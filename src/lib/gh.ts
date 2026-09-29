import { call } from "./tauri"

export type GhStatus = { installed: boolean; authenticated: boolean; message: string }

export type PrSummary = {
  number: number
  title: string
  author: string
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  updatedAt: string
  url: string
  additions: number
  deletions: number
  reviewDecision: string
  checks: "" | "success" | "failure" | "pending"
  isCrossRepository: boolean
}

export type PrCheck = {
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

export type PrReview = { author: { login: string }; state: string; body: string; submittedAt: string }
export type PrComment = { author: { login: string }; body: string; createdAt: string; url?: string }
export type PrFile = { path: string; additions: number; deletions: number }

export type PrDetail = {
  number: number
  title: string
  body: string
  author: { login: string }
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
  createdAt: string
  updatedAt: string
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string
  statusCheckRollup: PrCheck[]
  reviews: PrReview[]
  comments: PrComment[]
  files: PrFile[]
  commits: Array<{ oid: string; messageHeadline: string; authors: Array<{ login?: string; name?: string }> }>
  labels: Array<{ name: string; color: string }>
}

export const ghStatus = (repo: string) => call<GhStatus>("gh_status", { repo })
export const prList = (repo: string, state = "open") => call<PrSummary[]>("gh_pr_list", { repo, state })
export const prView = (repo: string, number: number) => call<PrDetail>("gh_pr_view", { repo, number })
export const prDiff = (repo: string, number: number) => call<string>("gh_pr_diff", { repo, number })
export const prCreate = (repo: string, title: string, body: string, base: string | null, draft: boolean) =>
  call<string>("gh_pr_create", { request: { repo, title, body, base, draft } })
export const prMerge = (repo: string, number: number, method: "squash" | "merge" | "rebase", deleteBranch: boolean) =>
  call<string>("gh_pr_merge", { repo, number, method, deleteBranch })
export const prCheckout = (repo: string, number: number) => call<string>("gh_pr_checkout", { repo, number })
export const prComment = (repo: string, number: number, body: string) => call<string>("gh_pr_comment", { repo, number, body })
export const prReview = (repo: string, number: number, action: "approve" | "request-changes" | "comment", body: string) =>
  call<string>("gh_pr_review", { repo, number, action, body })
export const prReady = (repo: string, number: number) => call<string>("gh_pr_ready", { repo, number })
