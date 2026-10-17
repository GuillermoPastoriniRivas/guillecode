// A view handoff must drain audio/transcription and an in-flight submit before
// unmounting its composer. Work stays in the source until it is acknowledged.
const inputs = new Map<string, Set<() => Promise<void>>>()
export function registerPendingInput(key: string, finish: () => Promise<void>) {
  const entries = inputs.get(key) ?? new Set()
  inputs.set(key, entries)
  entries.add(finish)
  return () => { entries.delete(finish); if (!entries.size) inputs.delete(key) }
}
export async function finishPendingInput(key: string) {
  await Promise.all([...(inputs.get(key) ?? [])].map(finish => finish()))
}
