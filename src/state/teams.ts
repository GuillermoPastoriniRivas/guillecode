import { create } from "zustand"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { openEditor } from "./editors"
import { useProject } from "./project"
import { useLayout } from "./layout"
import { selectedVariant, useAgent } from "./agent"
import { promptInput } from "./quickinput"
import { confirmAction } from "../components/Dialog"
import { notify } from "./toasts"
import type { Skill, Team, TeamChatRecord, TeamStore } from "../team/types"
import { indexTeamSessions } from "../team/session-index"
import { readableTeamError } from "../lib/provider-error"

type State = TeamStore & { loaded: boolean; error: string | null; activeChatId: string | null; openChatIds: string[] }
export const useTeams = create<State>(() => ({ schemaVersion: 1, teams: [], skills: [], chats: [], loaded: false, error: null, activeChatId: null, openChatIds: loadJson<string[]>("team.tabs", []) }))

export async function refreshTeams() {
  if (!isTauri) return
  try {
    const data = await call<TeamStore | null>("teams_state")
    // Older test hosts do not implement this command. Never invent native data.
    if (data) { indexTeamSessions(data.chats); useTeams.setState({ ...data, loaded: true, error: null }) }
  } catch (e) { useTeams.setState({ loaded: true, error: errorMessage(e) }) }
}

let listening = false
export function startTeams() {
  if (listening || !isTauri) return
  listening = true
  void refreshTeams()
  let timer: ReturnType<typeof setTimeout> | null = null
  onEvent("team://changed", () => { if (!timer) timer = setTimeout(() => { timer = null; void refreshTeams() }, 100) })
  onEvent<{ runId: string }>("team://run-completed", ({ runId }) => {
    void refreshTeams().then(() => {
      const chat = useTeams.getState().chats.find((c) => c.runs.some((r) => r.id === runId))
      if (chat) notify.success(`${chat.team.name}: Terminamos`, "Entrega guardada. Queda pendiente tu QA manual.")
    })
  })
  useProject.subscribe((s, prev) => { if (s.root !== prev.root) useTeams.setState({ activeChatId: null }) })
  useAgent.subscribe((s, prev) => { if (s.activeSessionId !== prev.activeSessionId || s.composerFocus !== prev.composerFocus) useTeams.setState({ activeChatId: null }) })
  // Refresh after foregrounding: covers a lost IPC event without running a UI scheduler.
  window.addEventListener("focus", () => void refreshTeams())
}

export async function teamCall<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  try { const result = await call<T>(command, args); await refreshTeams(); return result }
  catch (e) { notify.error("Equipos IA", readableTeamError(e)); return null }
}

export function openTeam(id = `new:${crypto.randomUUID()}`) { openEditor({ kind: "team", id }) }
export function selectTeamChat(id: string) {
  useTeams.setState((s) => ({ activeChatId: id, openChatIds: [...new Set([...s.openChatIds, id])] }))
  saveJson("team.tabs", useTeams.getState().openChatIds)
  useLayout.getState().toggleAgent(true)
}
export function closeTeamChat(id: string) {
  useTeams.setState((s) => ({ openChatIds: s.openChatIds.filter((v) => v !== id), activeChatId: s.activeChatId === id ? null : s.activeChatId }))
  saveJson("team.tabs", useTeams.getState().openChatIds)
}
export async function newTeamChat(teamId?: string) {
  if (!teamId) {
    const root = useProject.getState().root
    if (!root) { notify.info("Abrí una carpeta para usar el modo equipo"); return }
    const state = useAgent.getState()
    const { model } = state
    const variant = selectedVariant(state) ?? null
    const chat = await teamCall<TeamChatRecord>("team_chats_auto", { projectRoot: root, model: { ...model }, variant })
    if (chat) selectTeamChat(chat.id)
    return
  }
  const chat = await teamCall<TeamChatRecord>("team_chats_create", { teamId })
  if (chat) selectTeamChat(chat.id)
}
export async function deleteTeam(team: Team) {
  if (await confirmAction("Eliminar equipo", `Se elimina la plantilla «${team.name}». Sus chats y evidencias se conservan.`, "Eliminar", true)) await teamCall("teams_delete", { id: team.id })
}
export async function duplicateTeam(team: Team) {
  const name = await promptInput({ title: "Duplicar equipo", value: `${team.name} · copia` })
  if (name?.trim()) {
    const saved = await teamCall<Team>("teams_save", { team: { ...team, id: "", name } })
    if (saved) openTeam(saved.id)
  }
}
export async function renameChat(chat: TeamChatRecord) {
  const title = await promptInput({ title: "Renombrar chat de equipo", value: chat.title })
  if (title?.trim()) await teamCall("team_chats_edit", { id: chat.id, title, archived: chat.archived })
}
export async function saveSkill(skill: Skill) { return teamCall<Skill>("team_skills_save", { skill }) }
