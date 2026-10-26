import { test } from 'node:test'
import assert from 'node:assert/strict'
import { problemHelp, runProblem } from '../src/team/problem.ts'
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
