export const INTERNAL_SCREENSHOT_FILENAME = "aplicacion-actual.jpg"

// Filenames disappear in Responses serialization. Bind the automatic capture
// to its content so the transport guard never guesses from image order/type.
export async function desktopCaptureMarker(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `[Flufy desktop capture sha256:${hash}]`
}

export function isInternalScreenshot(part: { type: string; filename?: string }): boolean {
  return part.type === "file" && part.filename === INTERNAL_SCREENSHOT_FILENAME
}

export function isDesktopContextText(text: string): boolean {
  return /^(Contexto (observado de la aplicación|de escritorio|(?:Chrome|Browser) asignado)\b|Espacio (?:Chrome|Browser) de esta conversación\b)/.test(text)
}
