import type { TeamRun } from "./types"
import { firstTeamSentence } from "../lib/team-response"
import { formatDateTime } from "../lib/time"

export function SupportReports({run,onOpen}:{run:TeamRun;onOpen:(session:string,directory:string)=>void}) {
  return <>{run.supportReports?.map(report=><article className="team-card team-support-report" key={report.id}>
    <h4>{report.agent.name} · {report.kind==="investigation"?"Investiga para el Lead":report.kind==="goal_analysis"?"Objetivo inicial y resultado final":"Revisa entrega e integración"}</h4>
    <p className="team-note">{report.finishedAt ? report.status==="completed"?"Informe enviado":"Investigación interrumpida" : "Trabajando"} · {formatDateTime(report.startedAt)}</p>
    <p>{report.summary ? firstTeamSentence(report.summary) : "Está revisando los archivos, contratos y resultados disponibles."}</p>
    <details><summary>Ver informe y comunicación con el Lead</summary><p className="selectable">{report.summary}</p>{report.result?.findings?.map((fact,i)=><p key={i}>{fact}</p>)}{report.result?.nextStep && <p><strong>Propuesta al Lead:</strong> {report.result?.nextStep}</p>}<GoalCriteria run={run} reportId={report.id}/></details>
    <button className="btn btn-xs" onClick={()=>onOpen(report.sessionId,report.repository)}>Ver sesión de {report.agent.name}</button>
  </article>)}</>
}

function GoalCriteria({run,reportId}:{run:TeamRun;reportId:string}) {
  const criteria=run.supportReports?.find(r=>r.id===reportId)?.result?.criteria ?? []
  return <dl className="team-goal-criteria">{criteria.map((c,i)=><div key={i}><dt>{c.requirement} · {c.status==="met"?"Comprobado":c.status==="missing"?"Falta implementar":"Falta verificar"}</dt><dd>{c.evidence}</dd></div>)}</dl>
}

export function GoalAnalysis({run}:{run:TeamRun}) {
  const report=run.supportReports?.findLast(r=>r.kind==="goal_analysis" && r.status==="completed")
  if (!report) return null
  const verified=report.result?.criteriaSatisfied===true && !!report.result.criteria?.length && report.result.criteria.every(c=>c.status==="met" && !!c.evidence.trim())
  return <section className="team-card team-goal-analysis"><h3>Objetivo inicial y resultado final</h3><p>{verified?"El Supervisor contrastó los requisitos con la evidencia y confirmó su cumplimiento.":"El Supervisor encontró requisitos pendientes. El Lead debe resolverlos antes de cerrar."}</p><p>{firstTeamSentence(report.summary)}</p><details><summary>Ver requisitos y comprobaciones ({report.result?.criteria?.length ?? 0})</summary><GoalCriteria run={run} reportId={report.id}/></details></section>
}
