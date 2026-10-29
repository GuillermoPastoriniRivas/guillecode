import { useState } from "react"
import { Markdown } from "../agent/Markdown"

// Preserve the complete answer. Only its opening paragraph belongs in the
// conversation by default; instructions, commands and reports remain available.
export function LeadMessage({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const paragraphs = text.trim().split(/\n\s*\n/)
  const first = paragraphs[0] ?? ""
  const compact = paragraphs.length > 1 || first.length > 280
  const excerpt = first.length > 280 ? `${first.slice(0, 277).replace(/\s+\S*$/, "")}…` : first
  return <div className="team-lead-answer">
    <Markdown text={expanded || !compact ? text : excerpt} />
    {compact && <button type="button" className="team-text-action" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Mostrar menos" : "Ver respuesta completa"}</button>}
  </div>
}
