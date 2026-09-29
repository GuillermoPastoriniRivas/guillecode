import { useEffect } from "react"
import { useLightbox } from "../state/lightbox"
import { Icon } from "./ui"

export function ImageLightbox() {
  const image = useLightbox((s) => s.image)

  useEffect(() => {
    if (!image) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        useLightbox.setState({ image: null })
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [image])

  if (!image) return null
  const close = () => useLightbox.setState({ image: null })
  return (
    <div className="lightbox-backdrop" onMouseDown={close}>
      <img className="lightbox-image" src={image.url} alt={image.alt} onMouseDown={(e) => e.stopPropagation()} />
      <button type="button" className="lightbox-close" title="Cerrar (Esc)" onClick={close}>
        <Icon name="close" />
      </button>
    </div>
  )
}
