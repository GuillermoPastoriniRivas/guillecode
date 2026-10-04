import { call } from "./tauri"
import { normalizePath } from "./paths"

export type FsEntry = {
  name: string
  path: string
  isDir: boolean
  heavy: boolean
  size: number
  repo: string | null
}

type RawEntry = { name: string; path: string; is_dir: boolean; heavy: boolean; size: number; repo?: string | null }

export type FileContent = {
  content: string
  bom: boolean
  size: number
  mtime: number
}

export type FsStat = { exists: boolean; is_dir: boolean; size: number; mtime: number }

export const BINARY_FILE_ERROR = "binary"

export async function readDir(dir: string): Promise<FsEntry[]> {
  const raw = await call<RawEntry[]>("fs_read_dir", { dir })
  return raw.map((e) => ({ name: e.name, path: normalizePath(e.path), isDir: e.is_dir, heavy: e.heavy, size: e.size, repo: e.repo ?? null }))
}

export function readFile(file: string): Promise<FileContent> {
  return call<FileContent>("fs_read_file", { file })
}

export function readBase64(file: string): Promise<string> {
  return call<string>("fs_read_base64", { file })
}

export function writeFile(file: string, content: string, bom = false): Promise<number> {
  return call<number>("fs_write_file", { file, content, bom })
}

export function stat(file: string): Promise<FsStat> {
  return call<FsStat>("fs_stat", { file })
}

export function createFile(file: string): Promise<void> {
  return call<void>("fs_create_file", { file })
}

export function createDir(dir: string): Promise<void> {
  return call<void>("fs_create_dir", { dir })
}

export function rename(from: string, to: string): Promise<void> {
  return call<void>("fs_rename", { from, to })
}

export function deletePaths(paths: string[]): Promise<void> {
  return call<void>("fs_delete", { paths })
}

export function listFiles(root: string): Promise<string[]> {
  return call<string[]>("fs_list_files", { root })
}
