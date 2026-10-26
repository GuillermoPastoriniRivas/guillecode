import { test } from 'node:test'
import assert from 'node:assert/strict'
import { problemBrief, problemHelp, runProblem } from '../src/team/problem.ts'
import type { TeamAttention } from '../src/team/attention.ts'
import type { TeamRun } from '../src/team/types.ts'
const item = (reason: string, kind: TeamAttention['kind'] = 'blocked'): TeamAttention => ({id:'t',agentId:'lead',name:'Lead',task:'Revisar',kind,reason,sessionId:'s',directory:'C:/demo'})
test('explica la ayuda según cuota, permiso, espera y conexión sin recomendar reintentos ciegos', () => {
  const quota = problemHelp(item('La cuenta alcanzó su límite de uso.'))
  assert.equal(quota.model, true)
  assert.match(quota.text,/reintentar por sí solo no cambia/)
  assert.match(problemHelp(item('Permiso','permission')).text,/Abrí el permiso/)
  assert.match(problemHelp(item('Espera al Lead','waiting')).text,/coordina el Lead/)
  assert.match(problemHelp(item('El motor dejó la sesión inactiva')).text,/comprobará lo ya ejecutado/)
})
test('el resumen de chat atribuye al Lead el bloqueo de coordinación incluso si el trabajador figura bloqueado', () => {
  const run = {status:'blocked',error:'quota',team:{leadAgentId:'lead',members:[{id:'lead',name:'Lead'},{id:'front',name:'Frontend'}]},tasks:[{id:'t',assignedAgentId:'front',status:'blocked',attempts:[]}],coordination:[{fromTaskId:'t',status:'blocked',summary:'La cuenta alcanzó su límite de uso.'}]} as unknown as TeamRun
  assert.match(runProblem(run),/^Lead se frenó al ayudar a Frontend:/)
})

test('el resumen breve muestra las tareas propias, cuál frena y la causa sin inventar trabajo ajeno', () => {
  const run = {tasks:[
    {assignedAgentId:'lead',title:'Preparar API'},
    {assignedAgentId:'lead',title:'Conectar formulario'},
    {assignedAgentId:'lead',title:'Probar integración'},
    {assignedAgentId:'other',title:'Trabajo de otro agente'},
  ]} as unknown as TeamRun
  const brief = problemBrief({...item('Falta definir el formato de respuesta. El resto de los detalles queda aparte.'),task:'Conectar formulario'},run)
  assert.equal(brief.work,'Preparar API; Conectar formulario y 1 más')
  assert.equal(brief.blocked,'Conectar formulario')
  assert.equal(brief.because,'Falta definir el formato de respuesta')
  assert.doesNotMatch(brief.work,/Trabajo de otro/)
  const lead = problemBrief({...item('Espera una decisión'),task:'Destrabar a Frontend'}, {tasks:run.tasks.filter(t=>t.assignedAgentId!=='lead')} as TeamRun)
  assert.equal(lead.work,'Destrabar a Frontend')
  const coordinator = problemBrief({...item('La cuenta alcanzó su límite de uso.'),id:'coordination-help',task:'Destrabar a Frontend'}, {team:{leadAgentId:'lead'},tasks:[]} as unknown as TeamRun)
  assert.equal(coordinator.work,'Coordinar el equipo')
  assert.equal(coordinator.blocked,'Destrabar a Frontend')
})

test('el resumen breve limita el texto y recomienda ayuda según la causa sin exponer datos del proveedor', () => {
  const quota = problemBrief(item(JSON.stringify({data:{message:'The usage limit has been reached',responseHeaders:{'set-cookie':'PRIVATE'}}})))
  assert.equal(quota.because,'La cuenta llegó a su límite de uso')
  assert.match(quota.next,/esperá a que se renueve/)
  assert.doesNotMatch(JSON.stringify(quota),/PRIVATE|responseHeaders/)
  const payment = problemBrief(item('El proveedor rechazó la solicitud por falta de saldo (HTTP 402).'))
  assert.match(payment.because,/saldo/)
  assert.doesNotMatch(payment.next,/renueve/)
  assert.doesNotMatch(problemHelp(item('Falta de saldo en la cuenta')).text,/renueve/)
  assert.match(problemBrief(item('Espera tu autorización','permission')).next,/permiso/)
  assert.match(problemBrief(item('¿Qué formato querés?','question')).next,/Respondé/)
  assert.match(problemBrief(item('Espera al Backend','waiting')).next,/Lead está a cargo/)
  assert.match(problemBrief(item('Se perdió la conexión con el motor.')).next,/conexión/)
  const long = problemBrief({...item('Falta un dato '.repeat(80)),task:'Conectar formulario '.repeat(20)})
  assert.ok(long.work.length<=90 && long.blocked.length<=80 && long.because.length<=125)
})
