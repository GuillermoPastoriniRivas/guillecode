// Memoria local de GuilleCode: inyecta el contexto recordado antes de cada llamada
// al modelo y bloquea las herramientas de memoria cuando el toggle está apagado.
// Se ejecuta dentro del motor de opencode y solo lee la carpeta local.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

function slug(value) {
  const base = String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .pop() || "workspace"
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || "workspace"
}

export const GuilleCodeMemory = async ({ client, directory }, options) => {
  const root = options?.root
  if (!root) return {}
  const configPath = options?.config || join(root, "config.json")

  const enabled = (sessionID) => {
    if (!sessionID) return true
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      return config?.sessions?.[sessionID] !== false
    } catch {
      return true
    }
  }

  const digestFor = (dir) => {
    try {
      const path = join(root, "workspaces", slug(dir), "_digest.md")
      return existsSync(path) ? readFileSync(path, "utf8").trim() : ""
    } catch {
      return ""
    }
  }

  const preferences = () => {
    try {
      const path = join(root, "global", "_preferences.md")
      return existsSync(path) ? readFileSync(path, "utf8").trim() : ""
    } catch {
      return ""
    }
  }

  const sessionDirectory = async (sessionID) => {
    try {
      const response = await client.session.get({ path: { id: sessionID } })
      return response?.data?.directory || directory || ""
    } catch {
      return directory || ""
    }
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input?.sessionID || !enabled(input.sessionID)) return
      const dir = await sessionDirectory(input.sessionID)
      const text = digestFor(dir) || preferences()
      if (text) output.system.push(text)
    },
    "tool.execute.before": async (input) => {
      if (!input?.sessionID) return
      if (String(input.tool || "").startsWith("memory_") && !enabled(input.sessionID)) {
        throw new Error("La memoria está apagada en esta conversación. Activala con el interruptor «Memoria» del compositor.")
      }
    },
  }
}
