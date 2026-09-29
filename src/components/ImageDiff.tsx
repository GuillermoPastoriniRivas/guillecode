import type { ReactNode } from "react"
import { openImage } from "../state/lightbox"
import { Icon } from "./ui"

function ImagePane({ src, note }: { src: string | null; note: string }) {
  if (!src) {
    return (
      <div className="image-diff-pane empty">
        <Icon name="file-media" />
        <span>{note}</span>
      </div>
    )
  }
  return (
    <div className="image-diff-pane" onClick={() => openImage(src)} title="Clic para ampliar">
      <img src={src} alt="" />
    </div>
  )
}

type Props = {
  path: string
  before: string | null
  after: string | null
  labelA: string
  labelB: string
  noteA?: string
  noteB?: string
  header?: ReactNode
}

export function ImageDiff({ path, before, after, labelA, labelB, noteA, noteB, header }: Props) {
  return (
    <div className="diff-editor image-diff">
      {header && <div className="diff-editor-toolbar">{header}</div>}
      <div className="diff-labels">
        <span>{labelA}</span>
        <span>{labelB}</span>
      </div>
      <div className="image-diff-body">
        <ImagePane src={before} note={noteA ?? `Sin versión anterior de ${path}`} />
        <ImagePane src={after} note={noteB ?? `Sin versión nueva de ${path}`} />
      </div>
    </div>
  )
}
