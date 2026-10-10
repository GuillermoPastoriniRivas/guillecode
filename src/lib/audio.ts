// El motor de transcripción local (whisper.cpp) solo entiende WAV sin ffmpeg,
// así que decodificamos la grabación del navegador y la reescribimos como PCM
// mono 16-bit. Pedimos un AudioContext a 16 kHz: decodeAudioData remuestrea a
// la tasa del contexto, que es justo la que espera Whisper.

const TARGET_RATE = 16000

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels
  const length = buffer.length
  const rate = buffer.sampleRate || TARGET_RATE
  const mono = new Float32Array(length)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) mono[i] += data[i]
  }
  if (channels > 1) for (let i = 0; i < length; i++) mono[i] /= channels
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, mono[i]))
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  const dataBytes = pcm.byteLength
  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, "data")
  view.setUint32(40, dataBytes, true)
  return new Blob([header, pcm], { type: "audio/wav" })
}

export async function toWav(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer()
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return blob
  const ctx = new Ctor({ sampleRate: TARGET_RATE })
  try {
    const decoded = await ctx.decodeAudioData(bytes)
    return encodeWav(decoded)
  } catch {
    return blob
  } finally {
    void ctx.close().catch(() => undefined)
  }
}
