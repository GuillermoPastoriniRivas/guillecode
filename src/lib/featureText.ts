export type Changes = { staged: number; unstaged: number; untracked: number; conflicts: number }

export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "feature"
  )
}

export function changeCount(c: Changes | null | undefined): number {
  if (!c) return 0
  return c.staged + c.unstaged + c.untracked + c.conflicts
}
