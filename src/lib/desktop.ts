import { useCallback, useEffect, useState } from "react"
import { call, onEvent } from "./tauri"

export type MachineStatus = {
  locked: boolean
  interactive: boolean
  onBattery: boolean
  battery: number | null
  hasBattery: boolean
  keepAwake: boolean
  lidSleeps: boolean
}

export type BridgeStatus = { state: "off" | "starting" | "ready" | "error"; error: string | null; tools: number; connected: boolean; connecting: boolean }

export type DesktopActivity = { at: number; channel: "desktop" | "browser"; tool: string; summary: string; ok: boolean }

export type DesktopStatus = {
  enabled: boolean
  paused: boolean
  browser: boolean
  browserActive: boolean
  subagent: boolean
  subagentActive: boolean
  bridge: BridgeStatus
  blocked: string[]
  activity: DesktopActivity[]
  machine: MachineStatus
  available: boolean
}

export type DesktopPatch = Partial<{ enabled: boolean; paused: boolean; browser: boolean; blocked: string[]; subagent: boolean }>

const ACTIVE_MS = 20000

export function recentlyActive(status: DesktopStatus | null): boolean {
  const last = status?.activity[0]
  return !!last && last.tool !== "stop" && Date.now() - last.at < ACTIVE_MS
}

export function useDesktopStatus(pollMs = 15000) {
  const [status, setStatus] = useState<DesktopStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<DesktopStatus>("desktop_status"))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), pollMs)
    const offActivity = onEvent<DesktopActivity>("desktop://activity", (entry) =>
      setStatus((prev) => (prev ? { ...prev, activity: [entry, ...prev.activity].slice(0, 80) } : prev)),
    )
    const offChanged = onEvent("desktop://changed", () => void refresh())
    return () => {
      window.clearInterval(timer)
      offActivity()
      offChanged()
    }
  }, [refresh, pollMs])

  const update = useCallback(async (patch: DesktopPatch) => {
    const next = await call<DesktopStatus>("desktop_update", { patch })
    setStatus(next)
    return next
  }, [])

  return { status, error, refresh, update, setStatus }
}
