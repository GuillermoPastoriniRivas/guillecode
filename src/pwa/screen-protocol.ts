export type ScreenMeta = { version: number; id: string; width: number; height: number; format: "h264" | "jpeg"; codec: string | null }
export type InputEvent = { t: string; x?: number; y?: number; b?: string; k?: string; s?: string; dx?: number; dy?: number }

// A TCP/fetch chunk is not a video frame: both the header and payload may be split.
export class ScreenPackets {
  private buffer = new Uint8Array(0)
  push(chunk: Uint8Array): Array<{ kind: number; seq: number; data: Uint8Array }> {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    const packets = []
    let offset = 0
    while (merged.length - offset >= 9) {
      const view = new DataView(merged.buffer, offset, 9)
      const kind = view.getUint8(0)
      const seq = view.getUint32(1)
      const length = view.getUint32(5)
      if (length > 16 * 1024 * 1024 || kind > 6) throw new Error("Cuadro de video inválido")
      if (merged.length - offset < length + 9) break
      packets.push({ kind, seq, data: merged.slice(offset + 9, offset + 9 + length) })
      offset += 9 + length
    }
    this.buffer = merged.slice(offset)
    return packets
  }
}

// Return null for letterboxing, never turn a tap on a black bar into a PC click.
export function screenPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) return null
  const scale = Math.min(rect.width / width, rect.height / height)
  const w = width * scale, h = height * scale
  const x = (clientX - rect.left - (rect.width - w) / 2) / w
  const y = (clientY - rect.top - (rect.height - h) / 2) / h
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
}
