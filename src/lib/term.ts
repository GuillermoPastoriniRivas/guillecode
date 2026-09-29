import { call, Channel } from "./tauri"

export type ShellInfo = { id: string; name: string; path: string }
export type TermEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null }

export const terminalShells = () => call<ShellInfo[]>("terminal_shells")

export function terminalSpawn(
  id: string,
  cwd: string,
  shell: string | null,
  cols: number,
  rows: number,
  onEvent: (e: TermEvent) => void,
): Promise<void> {
  const channel = new Channel<TermEvent>()
  channel.onmessage = onEvent
  return call<void>("terminal_spawn", { args: { id, cwd, shell, cols, rows }, onEvent: channel })
}

export const terminalWrite = (id: string, data: string) => call<void>("terminal_write", { id, data })
export const terminalResize = (id: string, cols: number, rows: number) => call<void>("terminal_resize", { id, cols, rows })
export const terminalKill = (id: string) => call<void>("terminal_kill", { id })
export const terminalKillAll = () => call<void>("terminal_kill_all")
