import { compactTeamReply, type ChatSummary } from "../lib/team-response"
import type { ReactNode } from "react"

export function LeadReply({ brief, fallback, children }: { brief?: unknown; fallback: ChatSummary; children: ReactNode }) {
  const reply = compactTeamReply(brief, fallback)
  return <div className="lead-reply">
    <dl className="lead-brief">
      <div><dt>Qué hice</dt><dd>{reply.done}</dd></div>
      <div><dt>Qué probé</dt><dd>{reply.tested}</dd></div>
      <div><dt>Qué falta</dt><dd>{reply.pending}</dd></div>
    </dl>
    <details className="lead-details"><summary>Detalles técnicos</summary>{children}</details>
  </div>
}
