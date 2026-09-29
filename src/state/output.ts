import { create } from "zustand"
import { onEvent } from "../lib/tauri"

export type OutputEntry = {
  id: number
  time: number
  tool: string
  args: string[]
  cwd: string
  ok: boolean
  ms: number
  output: string
}

type ProcLog = Omit<OutputEntry, "id" | "time">

type OutputState = {
  entries: OutputEntry[]
  unseenErrors: number
  clear: () => void
  markSeen: () => void
}

const MAX_ENTRIES = 400
let nextId = 1

export const useOutput = create<OutputState>((set) => ({
  entries: [],
  unseenErrors: 0,
  clear: () => set({ entries: [], unseenErrors: 0 }),
  markSeen: () => set({ unseenErrors: 0 }),
}))

export function startOutputCapture(): () => void {
  return onEvent<ProcLog>("proc://log", (log) => {
    useOutput.setState((s) => ({
      entries: [...s.entries.slice(-(MAX_ENTRIES - 1)), { ...log, id: nextId++, time: Date.now() }],
      unseenErrors: s.unseenErrors + (log.ok ? 0 : 1),
    }))
  })
}
