import type { Part } from "@opencode-ai/sdk"

export type PlanTurnMessage = { info: { id: string; role: string }; parts: Part[] }

// OpenCode keeps one todo list per session, so after the plan belongs to a task
// that already ended it would stay pinned in the composer as if it were still in
// progress. The plan shown must be the one written during the current turn: if
// the user already started a newer task, the old list is history.
export function planIsCurrent(messages: PlanTurnMessage[], queued: Set<string> = new Set()): boolean {
  let lastUser = -1
  let lastPlan = -1
  messages.forEach((message, index) => {
    if (message.info.role === "user") {
      if (!queued.has(message.info.id)) lastUser = index
    } else if (message.parts.some((part) => part.type === "tool" && part.tool === "todowrite")) {
      lastPlan = index
    }
  })
  return lastUser === -1 || lastPlan > lastUser
}
