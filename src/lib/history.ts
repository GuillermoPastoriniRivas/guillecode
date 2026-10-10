type HistoryMessage = { info: { id: string; time: { created: number } } }

// Both clients reconcile snapshots against events received since the GET began.
// A changed ID absent from current is a tombstone, never a message to resurrect.
export function reconcileHistory<T extends HistoryMessage>(
  snapshot: T[], current: T[], changed: (id: string) => boolean,
  pending: (id: string) => boolean = () => false,
): T[] {
  const latest = new Map(current.map((message) => [message.info.id, message]))
  const fetched = new Set(snapshot.map((message) => message.info.id))
  return [
    ...snapshot.flatMap((message) => changed(message.info.id) ? (latest.has(message.info.id) ? [latest.get(message.info.id)!] : []) : [message]),
    ...current.filter((message) => !fetched.has(message.info.id) && (changed(message.info.id) || pending(message.info.id))),
  ].sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
}
