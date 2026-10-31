import { invoke } from "@tauri-apps/api/core"

export async function desktopTranscribe(wav: Blob): Promise<string> {
  const bytes = new Uint8Array(await wav.arrayBuffer())
  try {
    return await invoke<string>("voice_transcribe", bytes)
  } catch {
    return await invoke<string>("voice_transcribe", { audio: Array.from(bytes) })
  }
}
