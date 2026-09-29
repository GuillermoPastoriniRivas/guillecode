import { basename, extname } from "./paths"

export type FileKind = { icon: string; color: string; label: string }

const BY_NAME: Record<string, FileKind> = {
  "package.json": { icon: "json", color: "#cbcb41", label: "JSON" },
  "tsconfig.json": { icon: "json", color: "#519aba", label: "JSON" },
  "cargo.toml": { icon: "settings-gear", color: "#dea584", label: "TOML" },
  "cargo.lock": { icon: "lock", color: "#8b949e", label: "Lock" },
  "package-lock.json": { icon: "lock", color: "#8b949e", label: "JSON" },
  dockerfile: { icon: "vm", color: "#2496ed", label: "Dockerfile" },
  ".gitignore": { icon: "git-commit", color: "#f14e32", label: "Ignore" },
  ".env": { icon: "key", color: "#e5c07b", label: "Env" },
  "readme.md": { icon: "book", color: "#519aba", label: "Markdown" },
  "agents.md": { icon: "hubot", color: "#a78bfa", label: "Markdown" },
  "claude.md": { icon: "hubot", color: "#d97757", label: "Markdown" },
}

const BY_EXT: Record<string, FileKind> = {
  ts: { icon: "symbol-class", color: "#3b8eea", label: "TypeScript" },
  tsx: { icon: "symbol-class", color: "#3b8eea", label: "TypeScript React" },
  js: { icon: "symbol-namespace", color: "#e8d44d", label: "JavaScript" },
  jsx: { icon: "symbol-namespace", color: "#e8d44d", label: "JavaScript React" },
  mjs: { icon: "symbol-namespace", color: "#e8d44d", label: "JavaScript" },
  cjs: { icon: "symbol-namespace", color: "#e8d44d", label: "JavaScript" },
  json: { icon: "json", color: "#cbcb41", label: "JSON" },
  jsonc: { icon: "json", color: "#cbcb41", label: "JSON" },
  md: { icon: "markdown", color: "#519aba", label: "Markdown" },
  mdx: { icon: "markdown", color: "#519aba", label: "MDX" },
  rs: { icon: "symbol-misc", color: "#dea584", label: "Rust" },
  py: { icon: "symbol-method", color: "#4b8bbe", label: "Python" },
  go: { icon: "symbol-interface", color: "#00add8", label: "Go" },
  css: { icon: "symbol-color", color: "#7d6bd6", label: "CSS" },
  scss: { icon: "symbol-color", color: "#c6538c", label: "SCSS" },
  less: { icon: "symbol-color", color: "#5b7fbf", label: "Less" },
  html: { icon: "code", color: "#e8663d", label: "HTML" },
  vue: { icon: "code", color: "#41b883", label: "Vue" },
  svelte: { icon: "code", color: "#ff3e00", label: "Svelte" },
  yml: { icon: "list-tree", color: "#e0525b", label: "YAML" },
  yaml: { icon: "list-tree", color: "#e0525b", label: "YAML" },
  toml: { icon: "settings-gear", color: "#c9804f", label: "TOML" },
  sh: { icon: "terminal", color: "#89e051", label: "Shell" },
  ps1: { icon: "terminal-powershell", color: "#5391fe", label: "PowerShell" },
  bat: { icon: "terminal-cmd", color: "#c1f12e", label: "Batch" },
  sql: { icon: "database", color: "#e38c00", label: "SQL" },
  java: { icon: "symbol-class", color: "#cf8a3b", label: "Java" },
  kt: { icon: "symbol-class", color: "#a97bff", label: "Kotlin" },
  cs: { icon: "symbol-class", color: "#3fa33f", label: "C#" },
  c: { icon: "symbol-structure", color: "#8f9bb3", label: "C" },
  h: { icon: "symbol-structure", color: "#8f9bb3", label: "C Header" },
  cpp: { icon: "symbol-structure", color: "#f34b7d", label: "C++" },
  php: { icon: "symbol-class", color: "#8892bf", label: "PHP" },
  rb: { icon: "ruby", color: "#cc342d", label: "Ruby" },
  swift: { icon: "symbol-class", color: "#f05138", label: "Swift" },
  dart: { icon: "symbol-class", color: "#00b4ab", label: "Dart" },
  tf: { icon: "cloud", color: "#8c5cd6", label: "Terraform" },
  png: { icon: "file-media", color: "#b18bd6", label: "Imagen" },
  jpg: { icon: "file-media", color: "#b18bd6", label: "Imagen" },
  jpeg: { icon: "file-media", color: "#b18bd6", label: "Imagen" },
  gif: { icon: "file-media", color: "#b18bd6", label: "Imagen" },
  webp: { icon: "file-media", color: "#b18bd6", label: "Imagen" },
  svg: { icon: "file-media", color: "#ffb13b", label: "SVG" },
  ico: { icon: "file-media", color: "#b18bd6", label: "Icono" },
  pdf: { icon: "file-pdf", color: "#e8663d", label: "PDF" },
  zip: { icon: "file-zip", color: "#8b949e", label: "ZIP" },
  lock: { icon: "lock", color: "#8b949e", label: "Lock" },
  log: { icon: "output", color: "#8b949e", label: "Log" },
  txt: { icon: "file", color: "#8b949e", label: "Texto" },
  env: { icon: "key", color: "#e5c07b", label: "Env" },
}

const DEFAULT_KIND: FileKind = { icon: "file", color: "#8b949e", label: "Texto" }

export function fileKind(path: string): FileKind {
  const name = basename(path).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith(".env")) return BY_NAME[".env"]
  return BY_EXT[extname(name)] ?? DEFAULT_KIND
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "svg"])

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extname(path))
}

export function isRasterImage(path: string): boolean {
  return isImagePath(path) && extname(path) !== "svg"
}

export function imageMime(path: string): string {
  const ext = extname(path)
  if (ext === "svg") return "image/svg+xml"
  if (ext === "jpg") return "image/jpeg"
  if (ext === "ico") return "image/x-icon"
  return `image/${ext}`
}

export function imageDataUrl(path: string, base64: string): string {
  return `data:${imageMime(path)};base64,${base64}`
}
