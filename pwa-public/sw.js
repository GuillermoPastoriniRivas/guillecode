const CACHE = "guillecode-v2"
const SHELL = ["/", "/manifest.webmanifest", "/icon-256.png", "/icon-512.png"]

async function openCache() {
  try {
    return await caches.open(CACHE)
  } catch {
    return null
  }
}

async function remember(cache, key, response) {
  try {
    if (cache && response.ok) await cache.put(key, response.clone())
  } catch {
    return
  }
}

async function lookup(cache, key) {
  try {
    return cache ? await cache.match(key) : undefined
  } catch {
    return undefined
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    openCache()
      .then((cache) => cache && Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .catch(() => undefined)
      .then(() => self.clients.claim()),
  )
})

async function shellFirst(request) {
  const cache = await openCache()
  try {
    const response = await fetch(request)
    if (response.ok) {
      await remember(cache, "/", response)
      return response
    }
    return (await lookup(cache, "/")) ?? response
  } catch (error) {
    const cached = await lookup(cache, "/")
    if (cached) return cached
    throw error
  }
}

async function cacheFirst(request) {
  const cache = await openCache()
  const cached = await lookup(cache, request)
  if (cached) return cached
  const response = await fetch(request)
  await remember(cache, request, response)
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await openCache()
  const cached = await lookup(cache, request)
  const network = fetch(request)
    .then(async (response) => {
      await remember(cache, request, response)
      return response
    })
    .catch(() => cached)
  return cached ?? network
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/hub/") || url.pathname.startsWith("/oc/") || url.pathname === "/sw.js") return
  if (request.mode === "navigate") return event.respondWith(shellFirst(request))
  if (url.pathname.startsWith("/assets/")) return event.respondWith(cacheFirst(request))
  event.respondWith(staleWhileRevalidate(request))
})

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: "GuilleCode", body: event.data ? event.data.text() : "" }
  }
  const title = data.title || "GuilleCode"
  const url = data.url || "/"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const active = clients.find((c) => c.visibilityState === "visible" && c.focused)
      if (active && data.kind !== "test") {
        active.postMessage({ type: "push", title, body: data.body || "", url })
        return
      }
      return self.registration.showNotification(title, {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: !!data.tag,
        icon: "/icon-256.png",
        badge: "/badge.png",
        data: { url },
        requireInteraction: data.kind === "attention",
      })
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || "/"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => new URL(c.url).origin === self.location.origin)
      if (client) {
        client.postMessage({ type: "open", url })
        return client.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
