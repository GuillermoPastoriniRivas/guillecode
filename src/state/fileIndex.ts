import { create } from "zustand"
import { listFiles } from "../lib/fs"
import { debounce } from "../lib/persist"

type FileIndexState = {
  root: string | null
  files: string[]
  loading: boolean
  loadedAt: number
}

export const useFileIndex = create<FileIndexState>(() => ({ root: null, files: [], loading: false, loadedAt: 0 }))

let inflight: Promise<string[]> | null = null
let stale = true

export function getFileIndex(root: string): Promise<string[]> {
  const s = useFileIndex.getState()
  if (!stale && s.root === root && s.loadedAt > 0) return Promise.resolve(s.files)
  if (inflight) return inflight
  useFileIndex.setState({ loading: true, root })
  inflight = listFiles(root)
    .then((files) => {
      if (useFileIndex.getState().root !== root) return files
      stale = false
      useFileIndex.setState({ files, loading: false, loadedAt: Date.now(), root })
      return files
    })
    .catch(() => {
      useFileIndex.setState({ loading: false })
      return useFileIndex.getState().files
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

const rebuild = debounce((root: string) => {
  void getFileIndex(root)
}, 1500)

export function markIndexStale(root: string | null): void {
  stale = true
  if (root && useFileIndex.getState().loadedAt > 0) rebuild(root)
}

export function resetFileIndex(): void {
  stale = true
  inflight = null
  rebuild.cancel()
  useFileIndex.setState({ root: null, files: [], loading: false, loadedAt: 0 })
}
