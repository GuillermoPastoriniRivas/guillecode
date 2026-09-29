const PREFIX = "guillecode:"

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    return
  }
}

export function projectKey(project: string | null, key: string): string {
  return `${key}@${(project ?? "none").toLowerCase()}`
}

export type Debounced<A extends unknown[]> = ((...args: A) => void) & { flush: () => void; cancel: () => void }

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: A | null = null
  const run = ((...args: A) => {
    lastArgs = args
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (lastArgs) fn(...lastArgs)
    }, ms)
  }) as Debounced<A>
  run.flush = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
    if (lastArgs) fn(...lastArgs)
  }
  run.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return run
}
