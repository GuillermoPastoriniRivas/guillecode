import { create } from "zustand"
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { isTauri } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { selectSession, subscribeSessionFinished, useAgent, type PermissionRequest, type QuestionRequest } from "./agent"
import { useLayout } from "./layout"
import { useToasts } from "./toasts"

type PendingSource = { permissions: PermissionRequest[]; questions: QuestionRequest[] }

const TITLE = "GuilleCode"
const TITLE_FLASH_MS = 1100
const SOUND_MS = 5000
const SOUND_REPEATS = 3
const TASKBAR_MS = 4000
const FOCUS_GRACE_MS = 1500

type AttentionState = {
  sound: boolean
  desktop: boolean
  alerting: boolean
  silenced: boolean
  count: number
  setSound: (on: boolean) => void
  setDesktop: (on: boolean) => void
}

const PREFS_KEY = "attention.prefs"

const saved = loadJson<{ sound?: boolean; desktop?: boolean }>(PREFS_KEY, {})

export const useAttention = create<AttentionState>((set) => ({
  sound: saved.sound ?? true,
  desktop: saved.desktop ?? true,
  alerting: false,
  silenced: false,
  count: 0,
  setSound: (on) => set({ sound: on }),
  setDesktop: (on) => set({ desktop: on }),
}))

useAttention.subscribe((s, prev) => {
  if (s.sound !== prev.sound || s.desktop !== prev.desktop) saveJson(PREFS_KEY, { sound: s.sound, desktop: s.desktop })
})

export function pendingCount(s: PendingSource): number {
  return s.permissions.length + s.questions.length
}

export function pendingSessionId(s: PendingSource): string | null {
  return s.permissions[0]?.sessionID ?? s.questions[0]?.sessionID ?? null
}

export function focusPending(): void {
  const s = useAgent.getState()
  const sessionID = pendingSessionId(s)
  useLayout.getState().toggleAgent(true)
  if (sessionID) selectSession(sessionID)
}

export function silenceSound(): void {
  if (!useAttention.getState().alerting) return
  if (soundTimer) {
    clearInterval(soundTimer)
    soundTimer = null
  }
  offInteraction?.()
  useAttention.setState({ silenced: true })
}

let titleTimer: ReturnType<typeof setInterval> | null = null
let soundTimer: ReturnType<typeof setInterval> | null = null
let taskbarTimer: ReturnType<typeof setInterval> | null = null
let toastId: number | null = null
let offStore: (() => void) | null = null
let offInteraction: (() => void) | null = null
let engagedAt = 0

// Si el usuario ya está interactuando (clic/tecla o al recuperar el foco, p.ej.
// al hacer clic en la notificación de Windows), no tiene sentido seguir sonando.
function armInteractionSilence(): void {
  if (offInteraction) return
  engagedAt = Date.now()
  const onUserInput = () => silenceSound()
  const onWindowFocus = () => {
    if (Date.now() - engagedAt < FOCUS_GRACE_MS) return
    silenceSound()
  }
  window.addEventListener("focus", onWindowFocus)
  window.addEventListener("pointerdown", onUserInput, true)
  window.addEventListener("keydown", onUserInput, true)
  offInteraction = () => {
    window.removeEventListener("focus", onWindowFocus)
    window.removeEventListener("pointerdown", onUserInput, true)
    window.removeEventListener("keydown", onUserInput, true)
    offInteraction = null
  }
}

let audio: AudioContext | null = null
function audioContext(): AudioContext | null {
  if (audio) return audio
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audio = new Ctor()
  } catch {
    audio = null
  }
  return audio
}

function playChime(): void {
  if (!useAttention.getState().sound) return
  const ctx = audioContext()
  if (!ctx) return
  void ctx.resume().catch(() => undefined)
  const now = ctx.currentTime
  const notes = [880, 1174.7]
  for (const [i, freq] of notes.entries()) {
    const start = now + i * 0.18
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = "sine"
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + 0.5)
  }
}

// Aviso de "trabajo terminado": un único chime corto cuando una sesión de
// nivel superior pasa de trabajar a inactiva. Los subagentes no suenan, y si el
// agente quedó esperando respuesta manda el aviso de atención (que repite).
function onAgentFinished(sessionID: string): void {
  const agent = useAgent.getState()
  const session = agent.sessions.find((s) => s.id === sessionID)
  if (!session || session.parentID) return
  if (agent.permissions.some((p) => p.sessionID === sessionID) || agent.questions.some((q) => q.sessionID === sessionID)) return
  const watching = useLayout.getState().agentVisible && agent.activeSessionId === sessionID && document.hasFocus()
  if (watching) return
  playChime()
}

function pendingBody(): string {
  const { permissions, questions } = useAgent.getState()
  const parts: string[] = []
  if (permissions.length > 0) parts.push(`${permissions.length} permiso${permissions.length === 1 ? "" : "s"}`)
  if (questions.length > 0) parts.push(`${questions.length} pregunta${questions.length === 1 ? "" : "s"}`)
  return `${parts.join(" y ")} sin responder. El agente está esperando.`
}

async function notifyDesktop(body: string): Promise<void> {
  if (!useAttention.getState().desktop) return
  try {
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === "granted"
    if (granted) sendNotification({ title: "GuilleCode necesita tu respuesta", body })
  } catch {
    try {
      if (!("Notification" in window)) return
      if (Notification.permission === "granted") new Notification("GuilleCode necesita tu respuesta", { body })
      else if (Notification.permission !== "denied")
        void Notification.requestPermission().then((p) => {
          if (p === "granted") new Notification("GuilleCode necesita tu respuesta", { body })
        })
    } catch {
      return
    }
  }
}

async function escalateWindow(): Promise<void> {
  audioContext()
  if (!isTauri) return
  const win = getCurrentWindow()
  try {
    if (await win.isMinimized()) {
      await win.unminimize()
      await win.show()
      await win.setFocus()
    }
  } catch {
    // sin permiso para desminimizar: seguimos igual con el resto del aviso
  }
  try {
    await win.requestUserAttention(UserAttentionType.Critical)
  } catch {
    // sin permiso para el flash de la barra de tareas: el resto sigue
  }
}

function setTitle(text: string): void {
  if (isTauri) void getCurrentWindow().setTitle(text).catch(() => undefined)
  else document.title = text
}

function showToast(): void {
  const { permissions, questions } = useAgent.getState()
  const parts: string[] = []
  if (permissions.length > 0) parts.push(`${permissions.length} permiso${permissions.length === 1 ? "" : "s"}`)
  if (questions.length > 0) parts.push(`${questions.length} pregunta${questions.length === 1 ? "" : "s"}`)
  const detail = parts.length > 0 ? `${parts.join(" y ")} sin responder. El agente está esperando.` : "El agente está esperando."
  const id = useToasts.getState().push({
    kind: "warning",
    title: "El agente necesita tu respuesta",
    detail,
    sticky: true,
    actions: [
      { label: "Responder", primary: true, run: focusPending },
      { label: "Silenciar", run: () => silenceSound() },
    ],
  })
  toastId = id
}

function engage(): void {
  if (useAttention.getState().alerting) return
  useAttention.setState({ alerting: true, silenced: false })
  showToast()
  void escalateWindow()
  void notifyDesktop(pendingBody())
  playChime()
  let on = false
  titleTimer = setInterval(() => {
    on = !on
    const n = pendingCount(useAgent.getState())
    setTitle(on ? `● ${n} esperando · ${TITLE}` : TITLE)
  }, TITLE_FLASH_MS)
  let chimes = 1
  soundTimer = setInterval(() => {
    chimes += 1
    playChime()
    if (chimes >= SOUND_REPEATS && soundTimer) {
      clearInterval(soundTimer)
      soundTimer = null
    }
  }, SOUND_MS)
  taskbarTimer = setInterval(() => {
    if (isTauri) void getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => undefined)
  }, TASKBAR_MS)
  armInteractionSilence()
}

function disengage(): void {
  if (!useAttention.getState().alerting) return
  useAttention.setState({ alerting: false, silenced: false })
  offInteraction?.()
  if (titleTimer) clearInterval(titleTimer)
  if (soundTimer) clearInterval(soundTimer)
  if (taskbarTimer) clearInterval(taskbarTimer)
  titleTimer = soundTimer = taskbarTimer = null
  setTitle(TITLE)
  if (toastId !== null) {
    useToasts.getState().dismiss(toastId)
    toastId = null
  }
  if (isTauri) void getCurrentWindow().requestUserAttention(null).catch(() => undefined)
}

export function testAlert(): void {
  playChime()
  void escalateWindow()
  void notifyDesktop("Prueba del aviso: así te llama GuilleCode cuando el agente espera tu respuesta.")
  let on = false
  let ticks = 0
  const timer = setInterval(() => {
    on = !on
    ticks += 1
    setTitle(on ? `● ${Math.max(useAttention.getState().count, 1)} esperando · ${TITLE}` : TITLE)
    if (ticks >= 6) {
      clearInterval(timer)
      if (!useAttention.getState().alerting) setTitle(TITLE)
    }
  }, TITLE_FLASH_MS)
}

export function initAttention(): () => void {
  if (offStore) return offStore
  const sync = (count: number) => {
    useAttention.setState({ count })
    if (count > 0) engage()
    else disengage()
  }
  sync(pendingCount(useAgent.getState()))
  const unsubscribe = useAgent.subscribe((s, prev) => {
    const count = pendingCount(s)
    if (count !== pendingCount(prev)) sync(count)
  })
  const offFinished = subscribeSessionFinished(onAgentFinished)
  offStore = () => {
    unsubscribe()
    offFinished()
    offStore = null
    disengage()
  }
  return offStore
}
