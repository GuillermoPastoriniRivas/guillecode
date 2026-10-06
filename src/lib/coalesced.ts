// Requests arriving during a refresh share its promise and schedule at most one
// trailing refresh. Different projects do not block one another.
export function coalescedByKey(work: (key: string) => Promise<void>): (key: string) => Promise<void> {
  const running = new Map<string, { again: boolean; promise: Promise<void> }>()
  return (key) => {
    const existing = running.get(key)
    if (existing) {
      existing.again = true
      return existing.promise
    }
    const entry = { again: false, promise: Promise.resolve() }
    running.set(key, entry)
    entry.promise = Promise.resolve().then(async () => {
      do {
        entry.again = false
        await work(key)
      } while (entry.again)
    }).finally(() => running.delete(key))
    return entry.promise
  }
}
