import type { Part, Session } from "@opencode-ai/sdk"
import { api, client } from "./opencode"
import { gitRangeContext, gitStagedContext } from "./git"
import { HELPER_TITLE_PREFIX, selectedVariant, useAgent } from "../state/agent"

let toolIds: string[] | null = null

async function loadToolIds(): Promise<string[]> {
  if (!toolIds) toolIds = await api<string[]>("GET", "/experimental/tool/ids").catch(() => [])
  return toolIds
}

async function disabledTools(): Promise<Record<string, boolean>> {
  return Object.fromEntries((await loadToolIds()).map((t) => [t, false]))
}

function cleanReply(text: string): string {
  let out = text.trim()
  const fence = out.match(/^```[\w-]*\n([\s\S]*?)\n```$/)
  if (fence) out = fence[1].trim()
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) out = out.slice(1, -1).trim()
  return out
}

export async function oneShot(label: string, prompt: string, system: string): Promise<string> {
  const { model } = useAgent.getState()
  const created = await client.session.create({ body: { title: `${HELPER_TITLE_PREFIX}${label}` } })
  const session = created.data as Session | undefined
  if (!session) throw new Error("no se pudo crear la sesión auxiliar")
  try {
    const tools = await disabledTools()
    const res = await client.session.prompt({
      path: { id: session.id },
      body: { model, system, tools, parts: [{ type: "text", text: prompt }] },
    })
    const data = res.data as { parts?: Part[] } | undefined
    const text = (data?.parts ?? [])
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n")
    const reply = cleanReply(text)
    if (!reply) throw new Error("el modelo no devolvió texto")
    return reply
  } finally {
    void client.session.delete({ path: { id: session.id } }).catch(() => undefined)
  }
}

const COMMIT_SYSTEM = [
  "Escribís mensajes de commit para git.",
  "Respondé SOLO con el mensaje de commit, sin comillas, sin markdown y sin explicaciones.",
  "Primera línea: resumen en imperativo de hasta 72 caracteres.",
  "Si el cambio lo amerita, dejá una línea en blanco y un cuerpo breve con viñetas.",
  "Seguí el idioma y la convención (por ejemplo conventional commits) de los commits recientes del repo.",
].join(" ")

export async function generateCommitMessage(repo: string): Promise<string> {
  const ctx = await gitStagedContext(repo)
  if (!ctx.diff.trim()) throw new Error("No hay cambios en el stage")
  const prompt = [
    "Commits recientes del repo (para copiar el estilo):",
    ctx.log || "(sin historial)",
    "",
    "Resumen del stage:",
    ctx.stat,
    "",
    `Diff del stage${ctx.truncated ? " (recortado)" : ""}:`,
    ctx.diff,
  ].join("\n")
  return oneShot("commit", prompt, COMMIT_SYSTEM)
}

const PR_SYSTEM = [
  "Escribís pull requests de GitHub.",
  "Respondé con este formato exacto y nada más:",
  "La primera línea es el título del PR (hasta 70 caracteres, sin prefijo 'Título:').",
  "Después una línea en blanco y el cuerpo en markdown con secciones '## Qué cambia' y '## Cómo probarlo'.",
  "Usá el idioma de los commits.",
].join(" ")

export async function generatePullRequest(repo: string, base: string): Promise<{ title: string; body: string }> {
  const ctx = await gitRangeContext(repo, base)
  if (!ctx.log.trim() && !ctx.diff.trim()) throw new Error(`No hay commits nuevos respecto de ${base}`)
  const prompt = [
    `Commits de la rama respecto de ${base}:`,
    ctx.log,
    "",
    "Archivos:",
    ctx.stat,
    "",
    `Diff${ctx.truncated ? " (recortado)" : ""}:`,
    ctx.diff,
  ].join("\n")
  const reply = await oneShot("pull request", prompt, PR_SYSTEM)
  const [first, ...rest] = reply.split("\n")
  return { title: first.replace(/^#+\s*/, "").trim(), body: rest.join("\n").trim() }
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "list"])

async function readOnlyTools(): Promise<Record<string, boolean>> {
  return Object.fromEntries((await loadToolIds()).map((t) => [t, READ_ONLY_TOOLS.has(t)]))
}

const REVIEW_SYSTEM = [
  "Sos un revisor de código senior. Te pasan un diff y reportás solo problemas reales:",
  "bugs, errores de lógica, casos borde sin cubrir, problemas de seguridad, condiciones de carrera,",
  "fugas de recursos, manejo de errores roto, regresiones y errores de tipos.",
  "No reportes estilo, formato, nombres ni preferencias personales.",
  "Podés leer archivos del repo con las herramientas para confirmar un problema antes de reportarlo; si no lo podés confirmar, no lo reportes.",
  "Respondé SOLO con JSON válido, sin markdown ni texto alrededor, con esta forma:",
  '{"summary": "una o dos oraciones con el veredicto", "findings": [{"file": "ruta relativa a la raíz del repo, como aparece en el diff",',
  '"line": número de línea en la versión nueva del archivo, "severity": "alta" | "media" | "baja", "title": "problema en una línea",',
  '"detail": "por qué es un problema y cuándo falla", "suggestion": "cómo arreglarlo"}]}.',
  "Si no hay problemas, devolvé findings vacío. Escribí en español.",
].join(" ")

export type RawFinding = {
  file?: string
  line?: number | string
  severity?: string
  title?: string
  detail?: string
  suggestion?: string
}

export type ReviewResult = { summary: string; findings: RawFinding[] }

function parseReview(text: string): ReviewResult {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { summary?: unknown; findings?: unknown }
      return {
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        findings: Array.isArray(parsed.findings) ? (parsed.findings as RawFinding[]) : [],
      }
    } catch {
      return { summary: text.trim(), findings: [] }
    }
  }
  return { summary: text.trim(), findings: [] }
}

export async function reviewCode(label: string, prompt: string): Promise<ReviewResult> {
  const state = useAgent.getState()
  const variant = selectedVariant(state)
  const created = await client.session.create({ body: { title: `${HELPER_TITLE_PREFIX}${label}` } })
  const session = created.data as Session | undefined
  if (!session) throw new Error("no se pudo crear la sesión de revisión")
  try {
    const res = await api<{ parts?: Part[] }>("POST", `/session/${session.id}/message`, {
      model: state.model,
      ...(variant ? { variant } : {}),
      system: REVIEW_SYSTEM,
      tools: await readOnlyTools(),
      parts: [{ type: "text", text: prompt }],
    })
    const text = (res?.parts ?? [])
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n")
    if (!text.trim()) throw new Error("el modelo no devolvió la revisión")
    return parseReview(text)
  } finally {
    void client.session.delete({ path: { id: session.id } }).catch(() => undefined)
  }
}
