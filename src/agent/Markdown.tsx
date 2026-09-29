import { memo, useMemo } from "react"
import { marked } from "marked"
import hljs from "highlight.js/lib/core"
import ts from "highlight.js/lib/languages/typescript"
import js from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import bash from "highlight.js/lib/languages/bash"
import python from "highlight.js/lib/languages/python"
import css from "highlight.js/lib/languages/css"
import xml from "highlight.js/lib/languages/xml"
import markdown from "highlight.js/lib/languages/markdown"
import yaml from "highlight.js/lib/languages/yaml"
import diffLang from "highlight.js/lib/languages/diff"
import rust from "highlight.js/lib/languages/rust"
import go from "highlight.js/lib/languages/go"
import sql from "highlight.js/lib/languages/sql"
import powershell from "highlight.js/lib/languages/powershell"
import DOMPurify from "dompurify"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useFileIndex } from "../state/fileIndex"
import { useProject } from "../state/project"
import { openFile } from "../state/editors"
import { runInTerminal } from "../state/terminals"
import { resolvePath } from "../lib/paths"

hljs.registerLanguage("typescript", ts)
hljs.registerLanguage("ts", ts)
hljs.registerLanguage("tsx", ts)
hljs.registerLanguage("javascript", js)
hljs.registerLanguage("js", js)
hljs.registerLanguage("jsx", js)
hljs.registerLanguage("json", json)
hljs.registerLanguage("bash", bash)
hljs.registerLanguage("sh", bash)
hljs.registerLanguage("shell", bash)
hljs.registerLanguage("python", python)
hljs.registerLanguage("py", python)
hljs.registerLanguage("css", css)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("html", xml)
hljs.registerLanguage("markdown", markdown)
hljs.registerLanguage("md", markdown)
hljs.registerLanguage("yaml", yaml)
hljs.registerLanguage("yml", yaml)
hljs.registerLanguage("diff", diffLang)
hljs.registerLanguage("rust", rust)
hljs.registerLanguage("rs", rust)
hljs.registerLanguage("go", go)
hljs.registerLanguage("sql", sql)
hljs.registerLanguage("powershell", powershell)
hljs.registerLanguage("ps1", powershell)
hljs.registerLanguage("pwsh", powershell)

const RUNNABLE = new Set(["bash", "sh", "shell", "powershell", "ps1", "pwsh", "cmd", "console", "bat"])
const PATH_LIKE = /^(?:[A-Za-z]:)?[\w@.\-/\\]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

let knownFiles: Set<string> = new Set()
let knownFilesStamp = -1

function isKnownFile(candidate: string): boolean {
  const index = useFileIndex.getState()
  if (index.loadedAt !== knownFilesStamp) {
    knownFiles = new Set(index.files.map((f) => f.toLowerCase()))
    knownFilesStamp = index.loadedAt
  }
  const clean = candidate.replace(/:\d+(?::\d+)?$/, "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
  if (knownFiles.has(clean)) return true
  const root = useProject.getState().root?.toLowerCase()
  return !!root && clean.startsWith(root + "/") && knownFiles.has(clean.slice(root.length + 1))
}

const renderer = {
  code({ text, lang }: { text: string; lang?: string }) {
    const language = (lang ?? "").split(/\s+/)[0].toLowerCase()
    let body: string
    try {
      body =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text)
    } catch {
      body = escapeHtml(text)
    }
    const run = RUNNABLE.has(language)
      ? `<button type="button" class="code-action" data-run><i class="codicon codicon-play"></i>Ejecutar</button>`
      : ""
    return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(
      language || "código",
    )}</span><span class="code-actions">${run}<button type="button" class="code-action" data-copy><i class="codicon codicon-copy"></i>Copiar</button></span></div><pre><code class="hljs">${body}</code></pre></div>`
  },
  codespan({ text }: { text: string }) {
    const raw = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    if (PATH_LIKE.test(raw) && isKnownFile(raw)) {
      return `<code class="md-path" data-open-path="${escapeHtml(raw)}" title="Abrir en el editor">${text}</code>`
    }
    return `<code>${text}</code>`
  },
  link({ href, title, text }: { href: string; title?: string | null; text: string }) {
    const t = title ? ` title="${escapeHtml(title)}"` : ""
    return `<a href="${escapeHtml(href)}"${t} data-external target="_blank" rel="noreferrer">${text}</a>`
  },
}

marked.use({ renderer, gfm: true, breaks: true } as Parameters<typeof marked.use>[0])

function handleClick(e: React.MouseEvent) {
  const target = e.target as HTMLElement
  const copy = target.closest("[data-copy]")
  const run = target.closest("[data-run]")
  const path = target.closest("[data-open-path]")
  const link = target.closest("a[data-external]")
  if (copy || run) {
    const code = target.closest(".code-block")?.querySelector("code")?.textContent ?? ""
    if (copy) {
      void navigator.clipboard.writeText(code)
      const label = copy.lastChild
      if (label) {
        label.textContent = "¡Copiado!"
        setTimeout(() => (label.textContent = "Copiar"), 1400)
      }
    } else void runInTerminal(code.trim())
    return
  }
  if (path) {
    e.preventDefault()
    const raw = path.getAttribute("data-open-path") ?? ""
    const m = raw.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
    const root = useProject.getState().root
    if (!m || !root) return
    openFile(resolvePath(root, m[1]), m[2] ? { line: Number(m[2]), column: m[3] ? Number(m[3]) : 1 } : {})
    return
  }
  if (link) {
    e.preventDefault()
    const href = link.getAttribute("href")
    if (href) void openUrl(href).catch(() => window.open(href, "_blank"))
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text) as string
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["data-copy", "data-run", "data-open-path", "data-external", "target"] })
  }, [text])
  return <div className="md" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />
})
