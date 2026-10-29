export type Command = {
  id: string
  title: string
  category?: string
  icon?: string
  keys?: string[]
  global?: boolean
  hidden?: boolean
  when?: () => boolean
  run: (...args: unknown[]) => unknown
}

const commands = new Map<string, Command>()
const recent: string[] = []
const MAX_RECENT = 8

export function registerCommands(list: Command[]): void {
  for (const c of list) commands.set(c.id, c)
}

export function allCommands(): Command[] {
  return [...commands.values()].filter((c) => !c.hidden && (!c.when || c.when()))
}

export function recentCommandIds(): string[] {
  return recent
}

export async function executeCommand(id: string, ...args: unknown[]): Promise<void> {
  const cmd = commands.get(id)
  if (!cmd) return
  if (cmd.when && !cmd.when()) return
  const i = recent.indexOf(id)
  if (i !== -1) recent.splice(i, 1)
  recent.unshift(id)
  if (recent.length > MAX_RECENT) recent.pop()
  await cmd.run(...args)
}

type ParsedKey = { ctrl: boolean; shift: boolean; alt: boolean; key: string }

// El mismo símbolo llega con distinto nombre según el layout y el teclado
// numérico: "+" y "=" comparten tecla en varios layouts, y el "+" del bloque
// numérico no tiene alias de código. Se igualan para que acentos como Ctrl+= o
// Ctrl+- funcionen en cualquier teclado.
const SYMBOL_EQUIVALENTS: Record<string, string> = { "+": "=", "_": "-" }

// El símbolo que produce una tecla depende del layout (y de Shift), así que no
// se exige Shift exacto cuando la acción se define por el símbolo.
const SHIFT_AGNOSTIC = new Set(["=", "-"])

function parseKey(spec: string): ParsedKey {
  const parts = spec.toLowerCase().split("+")
  const raw = parts.pop() ?? ""
  const key = raw === "space" ? " " : raw
  return {
    ctrl: parts.includes("ctrl") || parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key: SYMBOL_EQUIVALENTS[key] ?? key,
  }
}

const CODE_ALIASES: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Equal: "=",
  Minus: "-",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadMultiply: "*",
  NumpadDivide: "/",
  NumpadDecimal: ".",
  NumpadEqual: "=",
}

function eventKeys(e: KeyboardEvent): string[] {
  const keys = new Set<string>()
  const add = (value: string) => {
    if (!value) return
    keys.add(value)
    const equivalent = SYMBOL_EQUIVALENTS[value]
    if (equivalent) keys.add(equivalent)
  }
  add(e.key.toLowerCase())
  if (e.code.startsWith("Key")) add(e.code.slice(3).toLowerCase())
  else if (e.code.startsWith("Digit")) add(e.code.slice(5))
  else if (CODE_ALIASES[e.code]) add(CODE_ALIASES[e.code])
  return [...keys]
}

export function matchesKey(e: KeyboardEvent, spec: string): boolean {
  const k = parseKey(spec)
  if (k.ctrl !== (e.ctrlKey || e.metaKey)) return false
  if (!SHIFT_AGNOSTIC.has(k.key) && k.shift !== e.shiftKey) return false
  if (k.alt !== e.altKey) return false
  return eventKeys(e).includes(k.key)
}

export function formatKeys(spec: string | undefined): string {
  if (!spec) return ""
  return spec
    .split("+")
    .map((p) => {
      const l = p.toLowerCase()
      if (l === "ctrl" || l === "mod") return "Ctrl"
      if (l === "shift") return "Shift"
      if (l === "alt") return "Alt"
      if (l === "enter") return "Enter"
      if (l === "escape") return "Esc"
      if (l === "tab") return "Tab"
      if (l.length === 1) return l.toUpperCase()
      return p.charAt(0).toUpperCase() + p.slice(1)
    })
    .join("+")
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest(".xterm")
}

export function installKeybindings(): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return
    const terminal = inTerminal(e.target)
    for (const cmd of commands.values()) {
      if (!cmd.keys || (terminal && !cmd.global)) continue
      if (cmd.when && !cmd.when()) continue
      if (cmd.keys.some((k) => matchesKey(e, k))) {
        e.preventDefault()
        e.stopPropagation()
        void executeCommand(cmd.id)
        return
      }
    }
  }
  window.addEventListener("keydown", handler, true)
  return () => window.removeEventListener("keydown", handler, true)
}
