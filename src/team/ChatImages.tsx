import { useEffect, useState } from "react"
import { call } from "../lib/tauri"
import { openImage } from "../state/lightbox"
import { readableTeamError } from "../lib/provider-error"
import type { TeamImage, TeamImageInput } from "./types"

export const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif"
export async function readTeamImages(files: File[]): Promise<TeamImageInput[]> {
  if (files.length > 5) throw new Error("Podés adjuntar hasta 5 imágenes por mensaje.")
  if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error("Las imágenes pueden sumar hasta 20 MB.")
  return Promise.all(files.map(file => {
    if (!IMAGE_TYPES.split(",").includes(file.type)) throw new Error("Adjuntá imágenes PNG, JPEG, WebP o GIF.")
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error("Cada imagen puede pesar hasta 10 MB.")
    return new Promise<TeamImageInput>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ filename: file.name || "imagen", mime: file.type, url: String(reader.result) })
      reader.onerror = () => reject(new Error("No se pudo leer la imagen. Volvé a adjuntarla."))
      reader.readAsDataURL(file)
    })
  }))
}

function SavedImage({ image }: { image: TeamImage }) {
  const [url, setUrl] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    let disposed = false
    void call<string>("team_image_read", { imageId: image.id }).then(data => { if (!disposed) { if (data) setUrl(data); else setError("No se pudo recuperar esta imagen del historial.") } }).catch(e => { if (!disposed) setError(readableTeamError(e)) })
    return () => { disposed = true }
  }, [image.id])
  return <figure>{url && !error ? <button type="button" onClick={() => openImage(url, image.filename)} title={`Ampliar ${image.filename}`}><img src={url} alt={image.filename} onError={() => setError("La imagen guardada no se puede abrir. Volvé a adjuntar el original.")} /></button> : <span>{error || "Cargando imagen…"}</span>}<figcaption>{image.filename}</figcaption></figure>
}

export function ChatImages({ images }: { images?: TeamImage[] }) {
  return images?.length ? <div className="team-chat-images">{images.map(image => <SavedImage key={image.id} image={image} />)}</div> : null
}
