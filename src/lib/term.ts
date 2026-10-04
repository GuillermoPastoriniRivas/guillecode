import { call, Channel } from "./tauri"

export type ShellInfo = { id: string; name: string; path: string }
export type TermEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null }

export const terminalShells = () => call<ShellInfo[]>("terminal_shells")

export type TermSpawnOptions = { id: string; cwd: string; shell: string | null; cols: number; rows: number; title: string | null; agent: boolean }

export function terminalSpawn(args: TermSpawnOptions, onEvent: (e: TermEvent) => void): Promise<void> {
  const channel = new Channel<TermEvent>()
  channel.onmessage = onEvent
  return call<void>("terminal_spawn", { args, onEvent: channel })
}

export const terminalWrite = (id: string, data: string) => call<void>("terminal_write", { id, data })
export const terminalResize = (id: string, cols: number, rows: number) => call<void>("terminal_resize", { id, cols, rows })
export const terminalKill = (id: string) => call<void>("terminal_kill", { id })
export const terminalKillAll = () => call<void>("terminal_kill_all")
