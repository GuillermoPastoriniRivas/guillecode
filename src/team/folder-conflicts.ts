import { runActive, type TeamChatRecord, type TeamRun } from "./types.ts"

const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
export function foldersOverlap(left: string, right: string) {
  const a=normalize(left), b=normalize(right)
  return a===b || a.startsWith(b+"/") || b.startsWith(a+"/")
}
export function occupiesFolder(run: TeamRun) {
  return runActive(run.status) || run.coordination?.some(c=>c.status==="checking")
    || run.tasks.some(t=>t.attempts.some(a=>a.finishedAt==null && !!(a.sessionId || a.reviewSessionId)))
}
export function folderConflicts(chats: TeamChatRecord[], chatId: string) {
  const target=chats.find(c=>c.id===chatId)
  if (!target) return []
  return chats.flatMap(chat=>chat.runs.filter(run=>occupiesFolder(run)
    && !(chat.id===chatId && run.id===target.runs.at(-1)?.id && runActive(run.status))
    && target.team.allowedRepositories.some(a=>run.team.allowedRepositories.some(b=>foldersOverlap(a,b))))
    .map(run=>({chat,run}))).sort((a,b)=>b.run.startedAt-a.run.startedAt)
}
