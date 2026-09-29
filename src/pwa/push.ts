import { hub } from "./api"

export type PushPrefs = { attention: boolean; done: boolean; error: boolean }

export type PushStatus =
  | { kind: "insecure" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on"; prefs: PushPrefs; endpoint: string }

function toBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=")
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing) return existing
  await navigator.serviceWorker.register("/sw.js")
  return navigator.serviceWorker.ready
}

async function register(sub: PushSubscription, prefs?: PushPrefs): Promise<PushPrefs> {
  const res = await hub<{ prefs: PushPrefs }>("POST", "/push/subscribe", { ...sub.toJSON(), ...(prefs ? { prefs } : {}) })
  return res.prefs
}

export async function pushStatus(): Promise<PushStatus> {
  if (!window.isSecureContext) return { kind: "insecure" }
  if (!supported()) return { kind: "unsupported" }
  if (Notification.permission === "denied") return { kind: "denied" }
  const reg = await registration()
  const sub = await reg.pushManager.getSubscription()
  if (!sub || Notification.permission !== "granted") return { kind: "off" }
  const { key } = await hub<{ key: string }>("GET", "/push/key")
  if (!sameKey(sub.options.applicationServerKey, toBytes(key))) {
    await sub.unsubscribe().catch(() => false)
    return { kind: "off" }
  }
  return { kind: "on", prefs: await register(sub), endpoint: sub.endpoint }
}

export async function enablePush(): Promise<PushStatus> {
  if (!window.isSecureContext) return { kind: "insecure" }
  if (!supported()) return { kind: "unsupported" }
  const permission = await Notification.requestPermission()
  if (permission === "denied") return { kind: "denied" }
  if (permission !== "granted") return { kind: "off" }
  const reg = await registration()
  const { key } = await hub<{ key: string }>("GET", "/push/key")
  const serverKey = toBytes(key)
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options.applicationServerKey, serverKey)) {
    await sub.unsubscribe().catch(() => false)
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey })
  return { kind: "on", prefs: await register(sub), endpoint: sub.endpoint }
}

export async function savePushPrefs(prefs: PushPrefs): Promise<PushPrefs> {
  const sub = await (await registration()).pushManager.getSubscription()
  if (!sub) throw new Error("Las notificaciones no están activas en este dispositivo")
  return register(sub, prefs)
}

export async function testPush(endpoint: string): Promise<void> {
  await hub("POST", "/push/test", { endpoint })
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription()
  if (!sub) return
  await hub("POST", "/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined)
  await sub.unsubscribe().catch(() => false)
}
