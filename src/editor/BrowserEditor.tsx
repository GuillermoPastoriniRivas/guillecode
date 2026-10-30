import { BrowserPane } from "../team/BrowserPane"

export function BrowserEditor({ sessionId }: { sessionId: string }) {
  return (
    <div className="browser-editor">
      <BrowserPane session={sessionId} />
    </div>
  )
}
