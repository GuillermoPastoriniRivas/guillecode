import { applyPatch, parsePatch, reversePatch, structuredPatch, type StructuredPatch } from "diff"

export type FileDiffInput = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type Row =
  | { kind: "context"; old: number; new: number; text: string }
  | { kind: "add"; old: null; new: number; text: string }
  | { kind: "del"; old: number; new: null; text: string }
  | { kind: "hunk"; old: null; new: null; text: string }

export const MAX_ROWS = 3000

type Hunk = StructuredPatch["hunks"][number]

export function fileStatus(fd: FileDiffInput): "added" | "deleted" | "modified" | "binary" {
  if (fd.status) return fd.status
  if (fd.before === undefined || fd.after === undefined) return "modified"
  if (fd.before === "" && fd.after === "") return "binary"
  if (fd.before === "") return "added"
  if (fd.after === "") return "deleted"
  return "modified"
}

export function collapseHunks(hunksIn: Hunk[], ctx = 3): Hunk[] {
  const out: Hunk[] = []
  for (const h of hunksIn) {
    const windows: Array<[number, number]> = []
    h.lines.forEach((l, i) => {
      if (l[0] !== "+" && l[0] !== "-") return
      const s = Math.max(0, i - ctx)
      const e = Math.min(h.lines.length - 1, i + ctx)
      const last = windows[windows.length - 1]
      if (last && s <= last[1] + 1) last[1] = e
      else windows.push([s, e])
    })
    for (const [s, e] of windows) {
      let oldStart = h.oldStart
      let newStart = h.newStart
      for (let k = 0; k < s; k++) {
        const m = h.lines[k][0]
        if (m === "\\") continue
        if (m !== "+") oldStart++
        if (m !== "-") newStart++
      }
      let oldLines = 0
      let newLines = 0
      for (let k = s; k <= e; k++) {
        const m = h.lines[k][0]
        if (m === "\\") continue
        if (m !== "+") oldLines++
        if (m !== "-") newLines++
      }
      out.push({ oldStart, oldLines, newStart, newLines, lines: h.lines.slice(s, e + 1) })
    }
  }
  if (out.length === 0 && hunksIn.length > 0) out.push(hunksIn[0])
  return out
}

export function rowsFromHunks(hunks: Hunk[]): Row[] {
  const rows: Row[] = []
  for (const hunk of hunks) {
    rows.push({
      kind: "hunk",
      old: null,
      new: null,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    })
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const line of hunk.lines) {
      const marker = line[0]
      const text = line.slice(1)
      if (marker === "\\") continue
      if (marker === "+") rows.push({ kind: "add", old: null, new: newLine++, text })
      else if (marker === "-") rows.push({ kind: "del", old: oldLine++, new: null, text })
      else rows.push({ kind: "context", old: oldLine++, new: newLine++, text })
    }
  }
  return rows
}

export function computeRows(fd: FileDiffInput): Row[] | null {
  try {
    if (fd.patch && fd.patch.trim()) {
      const parsed = parsePatch(fd.patch)
      return rowsFromHunks(collapseHunks(parsed.flatMap((p) => p.hunks)))
    }
    if (fd.before !== undefined && fd.after !== undefined && fd.before !== fd.after) {
      const p = structuredPatch(fd.file, fd.file, fd.before, fd.after, undefined, undefined, {
        context: 3,
        stripTrailingCr: true,
      })
      return rowsFromHunks(p.hunks)
    }
    return null
  } catch {
    return null
  }
}

export function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

export function reverseApply(text: string, patch: string): string | null {
  try {
    const parsed = parsePatch(patch)
    if (parsed.length === 0) return text
    const reversed = reversePatch(parsed[0])
    const out = applyPatch(text, reversed, { fuzzFactor: 1 })
    return out === false ? null : out
  } catch {
    return null
  }
}

export function forwardApply(text: string, patch: string): string | null {
  try {
    const parsed = parsePatch(patch)
    if (parsed.length === 0) return text
    const out = applyPatch(text, parsed[0], { fuzzFactor: 1 })
    return out === false ? null : out
  } catch {
    return null
  }
}

export function sideFromPatch(patch: string, side: "old" | "new"): string | null {
  try {
    const parsed = parsePatch(patch)[0]
    if (!parsed || parsed.hunks.length !== 1) return null
    const hunk = parsed.hunks[0]
    if ((side === "old" ? hunk.oldStart : hunk.newStart) > 1) return null
    const keep = side === "old" ? "-" : "+"
    const lines = hunk.lines.filter((l) => l[0] === " " || l[0] === keep).map((l) => l.slice(1))
    const noNewline = hunk.lines.some((l) => l.startsWith("\\"))
    return lines.join("\n") + (lines.length > 0 && !noNewline ? "\n" : "")
  } catch {
    return null
  }
}

export type ReconstructedSides = { before: string; after: string; exact: boolean }

export function reconstructSides(
  roundPatches: string[],
  current: string | null,
  firstStatus: "added" | "deleted" | "modified" | undefined,
  lastStatus: "added" | "deleted" | "modified" | undefined,
): ReconstructedSides | null {
  const after = lastStatus === "deleted" ? "" : (current ?? "")
  if (firstStatus === "added") return { before: "", after, exact: true }
  let text: string | null = after
  for (let i = roundPatches.length - 1; i >= 0 && text !== null; i--) {
    text = reverseApply(text, roundPatches[i])
  }
  if (text !== null) return { before: text, after, exact: true }
  const fallback = roundPatches.length > 0 ? sideFromPatch(roundPatches[0], "old") : null
  if (fallback !== null) return { before: fallback, after, exact: false }
  return null
}

export type FilePatch = { file: string; oldFile: string; patch: string; additions: number; deletions: number; status: string }

export function splitMultiFilePatch(diff: string): FilePatch[] {
  const chunks = diff.split(/(?=^diff --git )/m).filter((c) => c.startsWith("diff --git "))
  return chunks.map((chunk) => {
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m)
    const plusFile = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1]
    const minusFile = chunk.match(/^--- a\/(.+)$/m)?.[1]
    const file = plusFile ?? header?.[2] ?? minusFile ?? "?"
    const oldFile = minusFile ?? header?.[1] ?? file
    const status = /^new file mode/m.test(chunk)
      ? "added"
      : /^deleted file mode/m.test(chunk)
        ? "deleted"
        : /^rename from/m.test(chunk)
          ? "renamed"
          : "modified"
    return { file: file.trim(), oldFile: oldFile.trim(), patch: chunk, status, ...countChanges(chunk) }
  })
}

export type ParsedHunk = { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

export function parseFileHunks(patch: string): { header: string; hunks: ParsedHunk[] } {
  const lines = patch.split("\n")
  const headerLines: string[] = []
  const hunks: ParsedHunk[] = []
  let current: ParsedHunk | null = null
  const lastIndex = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  for (let i = 0; i < lastIndex; i++) {
    const line = lines[i]
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (m) {
      current = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current) {
      current.lines.push(line)
    } else {
      headerLines.push(line)
    }
  }
  return { header: headerLines.join("\n"), hunks }
}

export function singleHunkPatch(header: string, hunk: ParsedHunk): string {
  return `${header}\n${hunk.header}\n${hunk.lines.join("\n")}\n`
}
