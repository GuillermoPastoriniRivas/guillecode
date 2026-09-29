import { imageDataUrl } from "./files"
import { readBase64 } from "./fs"
import { gitShowFileBase64 } from "./git"

export async function gitImageDataUrl(repo: string, rev: string, path: string): Promise<string | null> {
  try {
    return imageDataUrl(path, await gitShowFileBase64(repo, rev, path))
  } catch {
    return null
  }
}

export async function fileImageDataUrl(abs: string, path: string): Promise<string | null> {
  try {
    return imageDataUrl(path, await readBase64(abs))
  } catch {
    return null
  }
}
