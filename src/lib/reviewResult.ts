export type RawFinding = { file?: string; line?: number | string; severity?: string; title?: string; detail?: string; suggestion?: string }
export type ReviewResult = { summary: string; findings: RawFinding[] }

export function parseReview(text: string): ReviewResult {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) throw new Error("La revisión no contiene un veredicto JSON válido")
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(start, end + 1)) }
  catch { throw new Error("La revisión contiene JSON inválido. No se considera aprobada") }
  if (!parsed || typeof parsed !== "object" || !("summary" in parsed) || typeof parsed.summary !== "string" || !parsed.summary.trim() || !("findings" in parsed) || !Array.isArray(parsed.findings) || parsed.findings.some((f: unknown) => !f || typeof f !== "object" || !("title" in f) || typeof f.title !== "string" || !f.title.trim())) throw new Error("La revisión tiene un esquema inválido. Volvé a intentarlo")
  return { summary: parsed.summary, findings: parsed.findings }
}
