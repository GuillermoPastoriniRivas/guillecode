import { createHash } from "node:crypto"

// Tauri encodes its bundle type in an otherwise identical executable. NSIS
// changes UNK to NSS; normalize exactly that documented marker, never code/data.
export function canonicalBinaryHash(bytes) {
  const copy = Buffer.from(bytes)
  const prefix = Buffer.from("URI_BUNDLE_TYPE_VAR_")
  const position = copy.indexOf(prefix)
  if (position < 0 || copy.indexOf(prefix, position + 1) >= 0) throw new Error("No hay un único marcador de bundle Tauri")
  const start = position + prefix.length
  const type = copy.subarray(start, start + 3).toString("ascii")
  if (!["UNK", "NSS"].includes(type)) throw new Error("Tipo de bundle inesperado")
  copy.write("UNK", start, "ascii")
  return createHash("sha256").update(copy).digest("hex")
}
