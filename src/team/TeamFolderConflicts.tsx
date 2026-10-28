import { useEffect, useRef, useState } from "react"
import { Icon } from "../components/ui"
import { selectTeamChat, teamCall, useTeams } from "../state/teams"
import { folderConflicts } from "./folder-conflicts"
import { runStatusLabel } from "./types"
import { formatDateTime } from "../lib/time"

type StopResult = {runId:string;title:string;stopped:boolean;message:string}

export function TeamFolderConflicts({chatId,failure}:{chatId:string;failure:string}) {
  const chats=useTeams(s=>s.chats)
  const conflicts=folderConflicts(chats,chatId)
  const dialog=useRef<HTMLDialogElement>(null)
  const [busy,setBusy]=useState(false)
  const [results,setResults]=useState<StopResult[]>([])
  const stopping=useRef(false)
  useEffect(()=>{
    if (/carpeta.*ocupada|equipo o una sesión pendiente|otro equipo.*carpetas/i.test(failure)
      && !dialog.current?.open) dialog.current?.showModal()
  },[failure])
  const stop=async (runIds:string[])=>{
    if (stopping.current || !runIds.length) return
    stopping.current=true;setBusy(true)
    try {
      const result=await teamCall<StopResult[]>("team_runs_stop_conflicts",{chatId,runIds})
      if(result) setResults(result)
    } finally {stopping.current=false;setBusy(false)}
  }
  const targets=conflicts.filter(c=>c.run.status!=="cancelling")
  return <>
    <button type="button" className="btn btn-xs team-folder-conflicts-trigger" onClick={()=>dialog.current?.showModal()}><Icon name="organization" /> Ver equipos que ocupan la carpeta{conflicts.length ? ` (${conflicts.length})` : ""}</button>
    <dialog ref={dialog} className="team-problem-dialog" aria-label="Equipos que ocupan la carpeta">
      <div className="team-problems-title"><h2>Equipos que ocupan la carpeta</h2><button className="btn btn-sm" onClick={()=>dialog.current?.close()}>Cerrar</button></div>
      <p>Podés abrir cada ejecución o detener las que impiden continuar. Sus cambios, conversaciones y evidencias se conservan.</p>
      {!conflicts.length && <p role="status">No hay otros equipos ocupando esta carpeta.</p>}
      {conflicts.map(({chat,run})=><article className="team-card" key={run.id}>
        <strong>{chat.title}{chat.archived ? " · Archivado" : ""}</strong><p>{runStatusLabel(run.status)} · {formatDateTime(run.startedAt)}</p>
        <p>{run.tasks.find(t=>t.status!=="completed")?.title || run.goal.trim().split("\n")[0].slice(0,180)}</p>
        <p className="team-note">{run.team.allowedRepositories.join(" · ")}</p>
        <div className="team-actions"><button className="btn btn-sm" onClick={()=>{dialog.current?.close();selectTeamChat(chat.id,run.id)}}>Abrir equipo</button>
          <button className="btn btn-sm" disabled={busy || run.status==="cancelling"} onClick={()=>void stop([run.id])}>{run.status==="cancelling" ? "Deteniendo…" : "Detener este equipo"}</button></div>
        <details><summary>Referencia técnica</summary><code>{run.id}</code></details>
      </article>)}
      {targets.length>1 && <button className="btn btn-primary" disabled={busy} onClick={()=>void stop(targets.map(c=>c.run.id))}>{busy ? "Deteniendo…" : `Detener todos estos equipos (${targets.length})`}</button>}
      {results.length>0 && <div aria-live="polite">{results.map(result=><p key={result.runId}><strong>{result.title}:</strong> {result.message}</p>)}</div>}
    </dialog>
  </>
}
