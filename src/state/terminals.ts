import { create } from "zustand"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  terminalKill,
  terminalKillAll,
  terminalResize,
  terminalShells,
  terminalSpawn,
  terminalWrite,
  type ShellInfo,
} from "../lib/term"
import { basename } from "../lib/paths"
import { loadJson, saveJson } from "../lib/persist"
import { errorMessage } from "../lib/tauri"
import { useLayout } from "./layout"
import { useProject } from "./project"
import { notify } from "./toasts"

export type TerminalInfo = {
  id: string
  shell: string | null
  cwd: string
  exited: boolean
  exitCode: number | null
}

type TerminalsState = {
  terminals: TerminalInfo[]
  activeId: string | null
  shells: ShellInfo[]
  defaultShell: string | null
}

const DEFAULT_SHELL_KEY = "terminal.defaultShell"

export const useTerminals = create<TerminalsState>(() => ({
  terminals: [],
  activeId: null,
  shells: [],
  defaultShell: loadJson<string | null>(DEFAULT_SHELL_KEY, null),
}))

export function setDefaultShell(shell: string | null): void {
  useTerminals.setState({ defaultShell: shell })
  saveJson(DEFAULT_SHELL_KEY, shell)
}

type Instance = {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  ready: Promise<void>
  opened: boolean
}

const instances = new Map<string, Instance>()
let counter = 1

const THEME = {
  background: "#0d1117",
  foreground: "#d6dbe4",
  cursor: "#8ea4ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#2f3d6b",
  black: "#1b1f27",
  red: "#ff7b72",
  green: "#6fdd8b",
  yellow: "#e3b341",
  blue: "#79a8ff",
  magenta: "#c59bff",
  cyan: "#56d4dd",
  white: "#c9d1d9",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#8fe8a6",
  brightYellow: "#f0cf65",
  brightBlue: "#a5c3ff",
  brightMagenta: "#dcbdfb",
  brightCyan: "#7ee2e8",
  brightWhite: "#f0f6fc",
}

let shellsLoading: Promise<void> | null = null

export function terminalTitle(info: TerminalInfo, shells: ShellInfo[]): string {
  const shell = shells.find((s) => s.id === info.shell) ?? shells[0]
  return `${shell?.name ?? "Terminal"} · ${basename(info.cwd)}`
}

export function ensureShells(): Promise<void> {
  shellsLoading ??= terminalKillAll()
    .catch(() => undefined)
    .then(loadShells)
  return shellsLoading
}

export async function loadShells(): Promise<void> {
  try {
    useTerminals.setState({ shells: await terminalShells() })
  } catch {
    useTerminals.setState({ shells: [] })
  }
}

export function getInstance(id: string): Instance | undefined {
  return instances.get(id)
}

function patchInfo(id: string, patch: Partial<TerminalInfo>) {
  useTerminals.setState((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}

export function createTerminal(opts: { shell?: string | null; cwd?: string; show?: boolean } = {}): string {
  const root = useProject.getState().root
  const cwd = opts.cwd ?? root
  if (!cwd) {
    notify.warning("Abrí un proyecto para usar la terminal")
    return ""
  }
  const id = `term-${Date.now()}-${counter}`
  const shell = opts.shell ?? useTerminals.getState().defaultShell
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    lineHeight: 1.2,
    fontFamily: "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
    theme: THEME,
    scrollback: 8000,
    allowProposedApi: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)))
  const host = document.createElement("div")
  host.className = "terminal-host"
  const info: TerminalInfo = {
    id,
    shell,
    cwd,
    exited: false,
    exitCode: null,
  }
  counter += 1
  const ready = terminalSpawn(id, cwd, shell, term.cols, term.rows, (event) => {
    if (event.kind === "data") term.write(event.data)
    else {
      term.write(`\r\n\x1b[2m[proceso terminado${event.code !== null ? ` · código ${event.code}` : ""}]\x1b[0m\r\n`)
      patchInfo(id, { exited: true, exitCode: event.code })
    }
  })
    .then(() => terminalResize(id, term.cols, term.rows).catch(() => undefined))
    .catch((e) => {
      term.write(`\x1b[31mNo se pudo iniciar el shell: ${errorMessage(e)}\x1b[0m\r\n`)
      patchInfo(id, { exited: true })
    })
  term.onData((data) => {
    void terminalWrite(id, data).catch(() => undefined)
  })
  term.onResize(({ cols, rows }) => {
    void terminalResize(id, cols, rows).catch(() => undefined)
  })
  instances.set(id, { term, fit, host, ready, opened: false })
  useTerminals.setState((s) => ({ terminals: [...s.terminals, info], activeId: id }))
  if (opts.show !== false) useLayout.getState().showPanel("terminal")
  return id
}

export function attachTerminal(id: string, container: HTMLElement): () => void {
  const inst = instances.get(id)
  if (!inst) return () => undefined
  container.appendChild(inst.host)
  if (!inst.opened) {
    inst.term.open(inst.host)
    inst.opened = true
  }
  const refit = () => {
    if (container.clientWidth < 20 || container.clientHeight < 20) return
    try {
      inst.fit.fit()
    } catch {
      return
    }
  }
  requestAnimationFrame(refit)
  const ro = new ResizeObserver(refit)
  ro.observe(container)
  return () => {
    ro.disconnect()
    if (inst.host.parentElement === container) container.removeChild(inst.host)
  }
}

export function focusTerminal(id: string | null): void {
  if (!id) return
  instances.get(id)?.term.focus()
}

export async function killTerminal(id: string): Promise<void> {
  const inst = instances.get(id)
  instances.delete(id)
  await terminalKill(id).catch(() => undefined)
  inst?.term.dispose()
  useTerminals.setState((s) => {
    const terminals = s.terminals.filter((t) => t.id !== id)
    const activeId = s.activeId === id ? (terminals[terminals.length - 1]?.id ?? null) : s.activeId
    return { terminals, activeId }
  })
}

export function setActiveTerminal(id: string): void {
  useTerminals.setState({ activeId: id })
}

export async function runInTerminal(command: string, opts: { newTerminal?: boolean; cwd?: string } = {}): Promise<void> {
  const s = useTerminals.getState()
  let id = opts.newTerminal ? null : (s.terminals.find((t) => t.id === s.activeId && !t.exited)?.id ?? null)
  if (!id) id = createTerminal({ cwd: opts.cwd })
  if (!id) return
  useLayout.getState().showPanel("terminal")
  setActiveTerminal(id)
  const inst = instances.get(id)
  if (!inst) return
  await inst.ready
  await terminalWrite(id, command.replace(/\r?\n/g, "\r") + "\r").catch((e) => notify.error("No se pudo escribir en la terminal", errorMessage(e)))
  focusTerminal(id)
}

export function clearTerminal(id: string | null): void {
  if (id) instances.get(id)?.term.clear()
}

export function disposeAllTerminals(): void {
  for (const id of [...instances.keys()]) void killTerminal(id)
}
