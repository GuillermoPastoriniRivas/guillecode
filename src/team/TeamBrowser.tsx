import { BrowserPane } from "./BrowserPane"

export function TeamBrowser({ chatId, names }: { chatId: string; names: Record<string,string> }) {
  return <BrowserPane session={`team:${chatId}`} names={names} />
}
