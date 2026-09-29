import { create } from "zustand"
import { openUrl } from "@tauri-apps/plugin-opener"
import { api } from "../lib/opencode"
import { chooseAvailableModel } from "../lib/providers"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { loadAgentMeta, setModel, useAgent } from "./agent"
import { notify } from "./toasts"

export const CHATGPT = "openai"
const METHODS = { browser: 0, device: 1 } as const
const BROWSER_CANCEL_URL = "http://localhost:1455/cancel"
const RELOAD_RETRY_MS = 5000

export type LoginMethod = keyof typeof METHODS
export type LoginFlow = { method: LoginMethod; url: string; code: string | null }
export type AuthEntry = { id: string; kind: string }

type AccountsState = { starting: LoginMethod | null; flow: LoginFlow | null; waitingFor: number; authEntries: AuthEntry[] | null; savingKey: boolean }

export const useAccounts = create<AccountsState>(() => ({ starting: null, flow: null, waitingFor: 0, authEntries: null, savingKey: false }))

export async function connectOpencode(key: string): Promise<boolean> {
  const value = key.trim()
  if (!value || /\s/.test(value)) {
    notify.error("Revisá la clave", "Pegá tu API key de OpenCode Go, sin espacios.")
    return false
  }
  useAccounts.setState({ savingKey: true })
  try {
    await call("validate_opencode_key", { key: value })
    await api("PUT", "/auth/opencode-go", { type: "api", key: value })
    await loadAuthEntries()
    await reloadProviders()
    notify.success("OpenCode Go conectado", "Tu clave quedó guardada. No necesitás conectar ChatGPT.")
    return true
  } catch (e) {
    notify.error("No se pudo conectar OpenCode Go", errorMessage(e))
    return false
  } finally {
    useAccounts.setState({ savingKey: false })
  }
}

type Authorization = { url: string; method: "auto" | "code"; instructions: string }

let attempt = 0
let reloadGen = 0
let retry: ReturnType<typeof setTimeout> | null = null

function describeLoginError(e: unknown, method: LoginMethod): string {
  const message = errorMessage(e)
  if (method === "browser" && /EADDRINUSE|1455/i.test(message))
    return "El puerto 1455 está ocupado: seguro hay otro inicio de sesión de ChatGPT abierto (Codex u otro opencode). Cerralo o usá «Con un código»."
  if (/Unexpected server error/i.test(message)) return "No se completó el inicio de sesión: se canceló o pasaron más de 5 minutos. Probá de nuevo."
  return message
}

export async function loginChatgpt(method: LoginMethod): Promise<void> {
  const current = ++attempt
  useAccounts.setState({ starting: method, flow: null })
  try {
    const auth = await api<Authorization>("POST", `/provider/${CHATGPT}/oauth/authorize`, { method: METHODS[method] })
    if (current !== attempt) return
    const code = auth.instructions.match(/code:\s*(\S+)/i)?.[1] ?? null
    useAccounts.setState({ starting: null, flow: { method, url: auth.url, code } })
    if (method === "browser") void openUrl(auth.url)
    await api("POST", `/provider/${CHATGPT}/oauth/callback`, { method: METHODS[method] })
    if (current !== attempt) return
    useAccounts.setState({ flow: null })
    notify.success("ChatGPT conectado", "Ya podés elegir sus modelos en el chat.")
    await loadAuthEntries()
    await reloadProviders()
  } catch (e) {
    if (current !== attempt) return
    useAccounts.setState({ starting: null, flow: null })
    notify.error("No se pudo conectar ChatGPT", describeLoginError(e, method))
  }
}

export function cancelLogin(): void {
  const flow = useAccounts.getState().flow
  attempt++
  useAccounts.setState({ starting: null, flow: null })
  if (flow?.method === "browser") void fetch(BROWSER_CANCEL_URL, { mode: "no-cors" }).catch(() => undefined)
}

export async function loadAuthEntries(): Promise<void> {
  if (!isTauri) return
  try {
    useAccounts.setState({ authEntries: await call<AuthEntry[]>("auth_entries") })
  } catch {
    useAccounts.setState({ authEntries: null })
  }
}

function moveModelAwayFrom(providerID: string): void {
  const s = useAgent.getState()
  if (s.model.providerID !== providerID) return
  const candidates = s.models.filter((m) => m.providerID !== providerID)
  const next = chooseAvailableModel(candidates, s.model, s.favoriteModels)
  setModel(next)
  notify.info(next.modelID ? `El chat ahora usa ${next.modelID}` : "Conectá una cuenta para usar el agente", "El proveedor del modelo anterior se quitó.")
}

export async function removeProvider(id: string, name: string): Promise<void> {
  try {
    await api("DELETE", `/auth/${encodeURIComponent(id)}`)
    useAgent.setState((s) => ({ models: s.models.filter((m) => m.providerID !== id), providers: s.providers.filter((p) => p.id !== id) }))
    moveModelAwayFrom(id)
    notify.info(`${name} quitado`)
    await loadAuthEntries()
    await reloadProviders()
  } catch (e) {
    notify.error(`No se pudo quitar ${name}`, errorMessage(e))
  }
}

async function workingSessions(): Promise<number> {
  const ids = new Set(
    Object.entries(useAgent.getState().statuses)
      .filter(([, s]) => s.type !== "idle")
      .map(([id]) => id),
  )
  if (isTauri) for (const id of await call<string[]>("live_busy_sessions").catch(() => [])) ids.add(id)
  return ids.size
}

export async function reloadProviders(force = false): Promise<void> {
  const gen = ++reloadGen
  if (retry) clearTimeout(retry)
  retry = null
  const busy = force ? 0 : await workingSessions()
  if (gen !== reloadGen) return
  if (busy > 0) {
    if (useAccounts.getState().waitingFor === 0)
      notify.info("Los modelos nuevos aparecen en un rato", `Espero a que ${busy === 1 ? "termine el agente que está" : `terminen los ${busy} agentes que están`} trabajando para no cortarlos.`)
    useAccounts.setState({ waitingFor: busy })
    retry = setTimeout(() => void reloadProviders(), RELOAD_RETRY_MS)
    return
  }
  useAccounts.setState({ waitingFor: 0 })
  try {
    await api("POST", "/global/dispose")
    await loadAgentMeta()
  } catch (e) {
    notify.error("No se pudieron recargar los modelos", errorMessage(e))
  }
}
