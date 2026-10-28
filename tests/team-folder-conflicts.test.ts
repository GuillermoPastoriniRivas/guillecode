import {test} from "node:test"
import assert from "node:assert/strict"
import {folderConflicts,foldersOverlap,occupiesFolder} from "../src/team/folder-conflicts.ts"
import type {TeamChatRecord,TeamRun} from "../src/team/types.ts"

function fixture() {
  const team={id:"t",name:"t",projectRoot:"D:/demo",allowedRepositories:["D:/demo"],members:[],leadAgentId:"lead",maxParallelTasks:2,maxRetriesPerTask:1,updatedAt:0}
  const run:TeamRun={id:"held",goal:"Integrar la API",team,skills:[],status:"running",startedAt:1,finishedAt:null,planSessionId:null,tasks:[],summary:"",error:null,evidenceDir:"",artifacts:[],notified:false}
  const request:TeamChatRecord={id:"request",title:"Nuevo",team,skills:[],archived:false,createdAt:0,runs:[]}
  const owner:TeamChatRecord={...request,id:"owner",title:"Frontend y Backend",archived:true,runs:[run]}
  return {request,owner,run}
}
test("identifica equipos archivados, carpetas hijas y sesiones pendientes sin confundir carpetas vecinas",()=>{
  const {request,owner,run}=fixture()
  assert.equal(folderConflicts([request,owner],request.id)[0].chat.title,"Frontend y Backend")
  assert.ok(foldersOverlap("D:\\Demo\\","d:/demo/backend"))
  assert.equal(foldersOverlap("D:/demo","D:/demo-copy"),false)
  run.status="completed"
  assert.equal(occupiesFolder(run),false)
  run.coordination=[{id:"q",fromTaskId:"t",message:"",taskIds:[],status:"checking",summary:"",createdAt:0,sessions:[]}]
  assert.equal(occupiesFolder(run),true)
  run.team={...run.team,allowedRepositories:["D:/demo-copy"]}
  assert.equal(folderConflicts([request,owner],request.id).length,0)
})
test("el botón enumera otros equipos y conserva una ejecución propia antigua sin ocultar sesiones huérfanas",()=>{
  const {request,owner,run}=fixture()
  request.runs=[run]
  assert.equal(folderConflicts([request],request.id).length,0)
  run.status="failed"
  run.coordination=[{id:"q",fromTaskId:"t",message:"",taskIds:[],status:"checking",summary:"",createdAt:0,sessions:[]}]
  assert.equal(folderConflicts([request],request.id).length,1)
  run.coordination[0].status="resolved"
  assert.equal(folderConflicts([request],request.id).length,0)
  assert.equal(folderConflicts([owner],"missing").length,0)
})

test("una investigación pendiente también conserva la reserva de la carpeta",()=>{
  const {run}=fixture();run.status="completed";run.supportReports=[{finishedAt:null}] as NonNullable<TeamRun["supportReports"]>
  assert.equal(occupiesFolder(run),true)
  run.supportReports[0].finishedAt=2
  assert.equal(!!occupiesFolder(run),false)
})
