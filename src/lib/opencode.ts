import { createOpencodeClient } from "@opencode-ai/sdk/client"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import { call, isTauri } from "./tauri"

export { isTauri }

export type ServerConfig = { url: string; username: string; password: string; worktree: string }

const DEV_PROXY_BASE = "/oc"

function browserAuthHeader(): Record<string, string> {
  if (!import.meta.env.DEV) return {}
  const user = import.meta.env.VITE_OPENCODE_USER
  const pass = import.meta.env.VITE_OPENCODE_PASSWORD
  if (!user && !pass) return {}
  return { Authorization: `Basic ${btoa(`${user ?? "opencode"}:${pass ?? ""}`)}` }
}

type Connection = { baseUrl: string; headers: Record<string, string>; worktree: string }

async function resolveConnection(): Promise<Connection> {
  if (isTauri) {
    const cfg = await call<ServerConfig>("server_config")
    return {
      baseUrl: cfg.url,
      headers: { Authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}` },
      worktree: cfg.worktree ?? "",
    }
  }
  return {
    baseUrl: import.meta.env.DEV ? DEV_PROXY_BASE : "http://localhost:4096",
    headers: browserAuthHeader(),
    worktree: import.meta.env.DEV ? (import.meta.env.VITE_PROJECT ?? "") : "",
  }
}

let connectionPromise: Promise<Connection> | null = null
const clients = new Map<string, Promise<OpencodeClient>>()
let activeDirectory: string | null = null
const sessionDirectories = new Map<string, string>()

export function connection(): Promise<Connection> {
  connectionPromise ??= resolveConnection()
  return connectionPromise
}

export function setActiveDirectory(directory: string | null): void {
  activeDirectory = directory || null
}

export async function currentDirectory(): Promise<string> {
  if (activeDirectory) return activeDirectory
  return (await connection()).worktree
}

export function rememberSessionDirectory(sessionID: string, directory: string | undefined | null): void {
  if (sessionID && directory) sessionDirectories.set(sessionID, directory)
}

export function sessionDirectory(sessionID: string | null | undefined): string | null {
  return sessionID ? (sessionDirectories.get(sessionID) ?? null) : null
}

function clientFor(directory: string): Promise<OpencodeClient> {
  const key = directory.toLowerCase()
  let found = clients.get(key)
  if (!found) {
    found = connection().then((c) =>
      createOpencodeClient({ baseUrl: c.baseUrl, headers: c.headers, directory: directory || undefined }),
    )
    clients.set(key, found)
  }
  return found
}

export function resetConnection(): void {
  connectionPromise = null
  clients.clear()
}

type CallOptions = { path?: { id?: string }; query?: { directory?: string } } | undefined

async function directoryForCall(options: CallOptions): Promise<string> {
  const explicit = options?.query?.directory
  if (explicit) return explicit
  return sessionDirectory(options?.path?.id) ?? (await currentDirectory())
}

function lazyPath(path: PropertyKey[]): unknown {
  const children = new Map<PropertyKey, unknown>()
  return new Proxy(function () {}, {
    get(_target, p) {
      if (p === "then" || p === "catch" || p === "finally" || typeof p === "symbol") return undefined
      if (!children.has(p)) children.set(p, lazyPath([...path, p]))
      return children.get(p)
    },
    apply(_target, _thisArg, args) {
      return directoryForCall(args[0] as CallOptions)
        .then(clientFor)
        .then((root) => {
          let parent = root as unknown as Record<PropertyKey, unknown>
          for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<PropertyKey, unknown>
          return (parent[path[path.length - 1]] as (...a: unknown[]) => unknown).apply(parent, args)
        })
    },
  })
}

export const client: OpencodeClient = lazyPath([]) as OpencodeClient

export function clientForDirectory(directory: string): Promise<OpencodeClient> {
  return clientFor(directory)
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const SESSION_PATH = /^\/session\/([^/?]+)/

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  opts: { directory?: string } = {},
): Promise<T> {
  const c = await connection()
  const directory = opts.directory ?? sessionDirectory(path.match(SESSION_PATH)?.[1]) ?? (await currentDirectory())
  const params = { ...(directory && method === "GET" ? { directory } : {}), ...query }
  const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : ""
  const res = await fetch(`${c.baseUrl}${path}${qs}`, {
    method,
    headers: {
      ...c.headers,
      ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    let message = text || res.statusText
    try {
      const parsed = JSON.parse(text) as { data?: { message?: string }; message?: string }
      message = parsed.data?.message ?? parsed.message ?? message
    } catch {
      message = text || res.statusText
    }
    throw new ApiError(res.status, message)
  }
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

export type ModelRef = { providerID: string; modelID: string }

export const DEFAULT_MODEL: ModelRef = (() => {
  const raw = import.meta.env.DEV ? (import.meta.env.VITE_OPENCODE_MODEL ?? "") : ""
  const [providerID, ...rest] = raw.split("/")
  return { providerID, modelID: rest.join("/") }
})()

export function modelKey(m: ModelRef): string {
  return `${m.providerID}/${m.modelID}`
}
