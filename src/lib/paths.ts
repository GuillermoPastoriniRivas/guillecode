const DRIVE = /^([a-zA-Z]):/

export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, "/")
  if (p.startsWith("file:///")) p = decodeURIComponent(p.slice(8))
  p = p.replace(DRIVE, (_, d: string) => `${d.toUpperCase()}:`)
  if (p.length > 1 && p.endsWith("/") && !/^[A-Z]:\/$/.test(p)) p = p.slice(0, -1)
  return p
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase()
}

export function isInside(root: string, path: string): boolean {
  const r = normalizePath(root).toLowerCase()
  const p = normalizePath(path).toLowerCase()
  return p === r || p.startsWith(r + "/")
}

export function joinPath(root: string, ...parts: string[]): string {
  let out = normalizePath(root)
  for (const part of parts) {
    const clean = part.replace(/\\/g, "/").replace(/^\/+/, "")
    if (!clean) continue
    out = out.endsWith("/") ? out + clean : `${out}/${clean}`
  }
  return out
}

export function isAbsolute(path: string): boolean {
  return DRIVE.test(path) || path.startsWith("/") || path.startsWith("\\\\")
}

export function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? normalizePath(path) : joinPath(root, path)
}

export function relativePath(root: string, path: string): string {
  const r = normalizePath(root)
  const p = normalizePath(path)
  if (p.toLowerCase() === r.toLowerCase()) return ""
  if (p.toLowerCase().startsWith(r.toLowerCase() + "/")) return p.slice(r.length + 1)
  return p
}

export function basename(path: string): string {
  const p = normalizePath(path)
  const i = p.lastIndexOf("/")
  return i === -1 ? p : p.slice(i + 1)
}

export function dirname(path: string): string {
  const p = normalizePath(path)
  const i = p.lastIndexOf("/")
  if (i <= 0) return p
  if (i === 2 && DRIVE.test(p)) return p.slice(0, 3)
  return p.slice(0, i)
}

export function extname(path: string): string {
  const name = basename(path)
  const i = name.lastIndexOf(".")
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase()
}

export function toFileUrl(path: string): string {
  const p = normalizePath(path)
  return "file:///" + p.split("/").map(encodeURIComponent).join("/").replace(/^([A-Z])%3A/, "$1:")
}

export function ancestors(root: string, path: string): string[] {
  const rel = relativePath(root, path)
  if (!rel || rel === normalizePath(path)) return []
  const segs = rel.split("/")
  const out: string[] = []
  for (let i = 1; i < segs.length; i++) out.push(joinPath(root, segs.slice(0, i).join("/")))
  return out
}

export function projectName(root: string | null): string {
  if (!root) return "sin proyecto"
  return basename(root) || root
}
