import { create } from "zustand"

type ImageRequest = { url: string; alt: string }

export const useLightbox = create<{ image: ImageRequest | null }>(() => ({ image: null }))

export function openImage(url: string, alt = "imagen") {
  useLightbox.setState({ image: { url, alt } })
}
