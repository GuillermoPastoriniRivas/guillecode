import { decodeTeamResponse } from "../lib/team-response"
import { Markdown } from "./Markdown"
import { LeadReply } from "./LeadReply"

export function TeamResponse({ text, live }: { text: string; live: boolean }) {
  try {
    const reply = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))
    if (["reply", "work"].includes(reply?.action) && typeof reply.reply === "string") return <Markdown text={reply.reply} />
  } catch { /* The normal team protocol or a partial streaming reply follows. */ }
  const result = decodeTeamResponse(text)
  if (!result) {
    if (!/^\s*(?:```(?:json)?\s*)?\{/.test(text)) return <Markdown text={text} />
    return <p role="status">{live ? "El equipo está preparando su respuesta…" : "El equipo devolvió una respuesta que no se pudo interpretar. Revisá el estado en el chat del equipo antes de continuar; esta respuesta no confirma que el trabajo esté terminado."}</p>
  }
  return <div className="team-response">
    <strong>{live ? "Respuesta del equipo en preparación" : result.title}</strong>
    <LeadReply brief={result.chatSummary} fallback={result.chatSummary}>
    <Markdown text={result.summary} />
    {result.tasks.length > 0 && <><strong>Tareas del equipo</strong><ul>{result.tasks.map((task, i) => <li key={i}><strong>{task.title}</strong><Markdown text={task.objective} /></li>)}</ul></>}
    {result.checks.length > 0 && <details><summary>Comprobaciones informadas por el agente</summary><p>La revisión del Lead y el estado del equipo determinan si la entrega está aprobada.</p><ul>{result.checks.map((check, i) => <li key={i}><code>{check}</code></li>)}</ul></details>}
    {result.request && <><strong>Pedido al Lead</strong><Markdown text={result.request} /></>}
    {result.limitations.length > 0 && <><strong>Pendientes y limitaciones</strong><ul>{result.limitations.map((item, i) => <li key={i}><Markdown text={item} /></li>)}</ul></>}
    </LeadReply>
  </div>
}
