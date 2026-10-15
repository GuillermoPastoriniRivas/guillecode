export const INTERNAL_SCREENSHOT_FILENAME = "aplicacion-actual.jpg"

export function isInternalScreenshot(part: { type: string; filename?: string }): boolean {
  return part.type === "file" && part.filename === INTERNAL_SCREENSHOT_FILENAME
}

export function isDesktopContextText(text: string): boolean {
  return /^Contexto (observado de la aplicación|de escritorio)\b/.test(text)
}
