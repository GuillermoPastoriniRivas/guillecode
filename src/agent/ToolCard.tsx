import { useState } from "react"
import type { Part } from "@opencode-ai/sdk"
import { Icon, Spinner } from "../components/ui"
import { summarize, type ToolState } from "./toolSummary"

type ToolPart = Extract<Part, { type: "tool" }>

function duration(state: ToolState): string {
  if (!state.time?.start || !state.time.end) return ""
  const ms = state.time.end - state.time.start
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function ToolCard({ part }: { part: ToolPart }) {
  const state = part.state as unknown as ToolState
  const [open, setOpen] = useState(false)
  const s = summarize(part.tool, state)
  const running = state.status === "running" || state.status === "pending"
  const failed = state.status === "error"
  const hasBody = !!s.body || failed
  return (
    <div className={`tool-card tool-${state.status}${open ? " open" : ""}`}>
      <div className="tool-head" onClick={() => hasBody && setOpen((o) => !o)} role={hasBody ? "button" : undefined}>
        <span className="tool-icon">{running ? <Spinner size={12} /> : <Icon name={failed ? "error" : s.icon} />}</span>
        <span className="tool-verb">{s.verb}</span>
        <span className="tool-target">{s.target}</span>
        {s.stats}
        <span className="tool-spacer" />
        {s.actions}
        {!running && <span className="tool-time">{duration(state)}</span>}
        {hasBody && <Icon name={open ? "chevron-down" : "chevron-right"} className="tool-chevron" />}
      </div>
      {open && (
        <div className="tool-body">
          {failed && <div className="tool-error">{state.error}</div>}
          {s.body}
        </div>
      )}
    </div>
  )
}
