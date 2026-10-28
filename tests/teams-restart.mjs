import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const delay=(ms)=>new Promise((done)=>setTimeout(done,ms))
const noGit=process.argv.includes('--no-git')
const coordination=process.argv.includes('--coordination')
const autonomous=process.argv.includes('--auto')
const profile=await mkdtemp(join(tmpdir(),'guille-teams-restart-'))
await mkdir(join(profile,'repo'))
const repo=await realpath(join(profile,'repo'));if(!noGit)execFileSync('git',['init',repo],{windowsHide:true,stdio:'ignore'})
await writeFile(join(repo,'user.txt'),'uncommitted user work\n')
const identifier=`com.guillecode.recovery-${randomUUID()}`
const node=`& '${process.execPath.replaceAll("'","''")}'`
const command=(engine)=>`${node} -e "const recoveryId='${identifier}';const fs=require('fs');fs.writeFileSync('${engine?'engine':'app'}-process.txt',String(process.pid));fs.appendFileSync('${engine?'engine':'app'}-effects.log','once\\n');${coordination?'':`const timer=setInterval(()=>{if(fs.existsSync('${engine?'engine':'app'}-continue.flag')){clearInterval(timer);process.exit(0)}},100)`}"`
const verify=`${node} -e "process.exit(require('fs').readFileSync('engine-effects.log','utf8')==='once\\n'?0:1)"`
const verifyApp=verify.replace('engine-effects.log','app-effects.log')
let workerCalls=0, engineCalls=0, continuationCalls=0, engineOriginalRetries=0
const mock=createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk
  if(!request.url.endsWith('/responses'))return response.end('{}')
  const body=JSON.parse(raw),text=JSON.stringify(body.input)
  const latest=[...body.input].reverse().find((i)=>i.role==='user')
  const latestPrompt=typeof latest?.content==='string'?latest.content:(latest?.content??[]).map((p)=>p.text??'').join('\n')
  const leadPhase=['Actuás como Team Lead.','Sos el Lead revisor','Sos el Lead de cierre','Sos el Lead de coordinación','Sos el Solucionador del equipo','Sos el Supervisor revisor','Sos el Supervisor de cumplimiento'].some((marker)=>latestPrompt.includes(marker))
  const engine=text.includes('engine-crash'),outputs=body.input.filter((i)=>i.type==='function_call_output')
  const isReview=text.includes('Sos el Lead revisor')||text.includes('Sos el Lead de cierre')
  let item
  const message=(value)=>({type:'message',id:`msg-${randomUUID()}`,role:'assistant',content:[{type:'output_text',text:JSON.stringify(value),annotations:[]}],status:'completed'})
  if(coordination&&(body.model==='qa-recovery-front'||autonomous&&text.includes('Frontend 1 (Frontend)'))){
    const continuing=text.includes('COORDINACIÓN ACTUAL DEL LEAD')
    if(!continuing)item=message({status:'waiting_dependency',summary:'Preparación independiente terminada; necesito el efecto del backend',checks:[],limitations:[],request:{message:'Lead, revisá la entrega effect antes de integrar',taskIds:['effect']}})
    else if(outputs.length)item=message({status:'completed',summary:'Integración comprobada tras respuesta del Lead',checks:[verifyApp],limitations:[]})
    else item={type:'function_call',id:`fc-${randomUUID()}`,call_id:`call-${randomUUID()}`,name:'bash',arguments:JSON.stringify({command:verifyApp,description:'Comprobar contrato de Backend',timeout:10000}),status:'completed'}
  }
  else if(body.model==='qa-recovery-lead'&&(!autonomous||leadPhase)){
    const input=[...body.input].reverse().find((i)=>i.role==='user')
    const prompt=typeof input?.content==='string'?input.content:(input?.content??[]).map((p)=>p.text??'').join('\n')
    if(prompt.includes('Sos el Solucionador del equipo')) item=message({summary:'El efecto ya se aplicó una sola vez',findings:['app-effects.log contiene una línea once','La sesión del trabajador conserva su historial'],nextStep:'Verificá el archivo antes de volver a ejecutar y continuá la misma sesión'})
    else if(prompt.includes('Sos el Supervisor revisor')) item=message({status:'approved',summary:'El efecto y su comprobación están presentes una sola vez',criteriaSatisfied:true,tasks:[]})
    else if(prompt.includes('Sos el Supervisor de cumplimiento')) item=message({summary:'Todos los requisitos del objetivo están cubiertos',criteriaSatisfied:true,criteria:[{requirement:'Aplicar el efecto exactamente una vez',status:'met',evidence:'app-effects.log y comprobación observada'}]})
    else if(coordination&&prompt.includes('Sos el Lead de coordinación')){
      const states=JSON.parse(prompt.split('ESTADO ACTUAL DEL EQUIPO: ')[1].split('\nHISTORIAL DE COORDINACIÓN:')[0])
      const delivered=states.find((t)=>t.id==='effect').status==='completed'
      item=message({status:delivered?'resume':'wait',summary:delivered?'Entrega effect completada y revisada; integrá ahora':'Backend continúa activo; esperá conservando tu sesión',waitForTaskIds:delivered?[]:['effect'],tasks:[]})
    }else item=message(isReview?{status:'approved',summary:'Efecto único comprobado',criteriaSatisfied:true,tasks:[],chatSummary:{done:'Recuperé la entrega.',tested:'El efecto ocurrió una sola vez.',pending:'Nada pendiente.'}}:{...(autonomous?{agents:[{id:'worker',role:'Backend'},...(coordination?[{id:'front',role:'Frontend'}]:[])]}:{}),tasks:[{id:'effect',title:'Efecto único',objective:'Aplicar el efecto una sola vez y verificar su existencia',assignedAgentId:'worker',repository:repo,dependencies:[],expectedFiles:[],writePaths:coordination?['app-effects.log','app-process.txt','app-continue.flag']:[],acceptanceCriteria:['El efecto se aplica exactamente una vez']},...(coordination?[{id:'front',title:'Integrar Frontend',objective:'Preparar UI y pedir el contrato al Lead',assignedAgentId:'front',repository:repo,dependencies:[],expectedFiles:[],writePaths:['front.txt'],acceptanceCriteria:['Contrato integrado y comprobado']}]:[])]})
  }
  else {
    workerCalls++;if(engine)engineCalls++
    if(coordination&&outputs.length){
      const deadline=Date.now()+110000
      while(Date.now()<deadline){try{await stat(join(repo,'app-continue.flag'));break}catch{await delay(100)}}
    }
    const continuing=text.includes('La aplicación se reinició')
    if(continuing)continuationCalls++
    // A persisted call can have been interrupted before its result arrived.
    // Only claim verification after that exact call has a successful output.
    const verified=body.input.some((i)=>i.type==='function_call'&&i.arguments?.includes('readFileSync')&&outputs.some((o)=>o.call_id===i.call_id&&!/error|abort|interrupt|cancel|timed? ?out/i.test(JSON.stringify(o.output))))
    if((outputs.length>0&&!engine)||(engine&&verified))item=message({status:'completed',summary:'El efecto existe una sola vez; verificado',checks:[engine?verify:command(false)],limitations:[]})
    else {
      const replayingInterruptedEngine=engine&&engineCalls>1&&!continuing
      if(replayingInterruptedEngine)engineOriginalRetries++
      item={type:'function_call',id:`fc-${randomUUID()}`,call_id:`call-${randomUUID()}`,name:'bash',arguments:JSON.stringify({command:continuing||replayingInterruptedEngine?verify:command(engine),description:continuing||replayingInterruptedEngine?'Verificar efecto ya aplicado':'Efecto local seguido de espera',timeout:120000}),status:'completed'}
    }
  }
  const events=[{type:'response.created',response:{id:'resp',model:body.model,created_at:0}},{type:'response.output_item.added',output_index:0,item:{...item,arguments:'',content:[],status:'in_progress'}},...(item.type==='function_call'?[{type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:item.arguments},{type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments}]:[{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text}]),{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:3}}}]
  response.writeHead(200,{'content-type':'text/event-stream'});response.end(events.map((e)=>`data: ${JSON.stringify(e)}\n\n`).join(''))
})
await new Promise((done)=>mock.listen(0,'127.0.0.1',done))
const reserve=tcpServer();await new Promise((done)=>reserve.listen(0,'127.0.0.1',done));const port=reserve.address().port;await new Promise((done)=>reserve.close(done))
const origin=`http://127.0.0.1:${port}`
const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP'].filter((k)=>process.env[k]).map((k)=>[k,process.env[k]]))
Object.assign(env,{USERPROFILE:profile,HOME:profile,APPDATA:profile,LOCALAPPDATA:profile,XDG_DATA_HOME:join(profile,'data'),XDG_CONFIG_HOME:join(profile,'config'),XDG_CACHE_HOME:join(profile,'cache'),XDG_STATE_HOME:join(profile,'state'),OPENCODE_CONFIG_DIR:join(profile,'config','opencode'),OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_SERVER_PASSWORD:'qa-password',OPENCODE_CONFIG_CONTENT:JSON.stringify({enabled_providers:['openai'],provider:{openai:{options:{apiKey:'test-fake',baseURL:`http://127.0.0.1:${mock.address().port}/v1`},models:Object.fromEntries(['qa-recovery-lead','qa-recovery-worker','qa-recovery-front'].map((id)=>[id,{name:id,limit:{context:200000,output:16000}}]))}},agent:{title:{disable:true},summary:{disable:true}}})})
await mkdir(env.OPENCODE_CONFIG_DIR,{recursive:true})
let engine,app,dataDir,appLog='',engineLog=''
async function startEngine(){
  engine=spawn(resolve('src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe'),['serve','--hostname','127.0.0.1','--port',String(port)],{env,cwd:repo,windowsHide:true,stdio:'pipe'})
  for(const stream of [engine.stdout,engine.stderr])stream.on('data',(b)=>{engineLog=(engineLog+b).slice(-5000)})
  for(let i=0;i<100;i++){try{const r=await fetch(origin+'/global/health',{headers:{Authorization:`Basic ${Buffer.from('opencode:qa-password').toString('base64')}`},signal:AbortSignal.timeout(1000)});if(r.ok)return}catch{}await delay(200)}
  throw new Error('Engine failed to start: '+engineLog)
}
function kill(child){if(!child||child.exitCode!==null)return;assert.ok(child.pid>0);try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{/* process may have exited */}}
async function killFixtureTool(name){
  let pid;try{pid=Number(await readFile(join(repo,`${name}-process.txt`),'utf8'))}catch{return}
  assert.ok(Number.isSafeInteger(pid)&&pid>0)
  const line=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`],{windowsHide:true,encoding:'utf8'})
  if(!line.trim())return
  assert.ok(line.includes(identifier),'Refusing to stop a process outside this disposable fixture')
  try{execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{/* tool exited between lookup and stop */}
}
const phases=[]
try{
  const build=spawn('cargo',['test','--manifest-path','src-tauri/Cargo.toml','--release','--lib','--features','desktop-e2e','--no-run','--message-format=json'],{windowsHide:true,stdio:['ignore','pipe','pipe']})
  let compiled='',buildErrors='';build.stdout.on('data',(b)=>{compiled+=b});build.stderr.on('data',(b)=>{buildErrors+=b})
  assert.equal(await new Promise((done)=>build.once('exit',done)),0,buildErrors)
  const executable=compiled.split('\n').filter(Boolean).map((s)=>{try{return JSON.parse(s)}catch{return{}}}).find((m)=>m.executable&&m.target?.name==='app_lib')?.executable
  assert.ok(executable,'Rust test executable not found')
  await startEngine()
  async function phase(name,terminate=false){
    const signal=join(profile,`${name}.json`)
    appLog=''
    app=spawn(executable,['teams::restart_tests::restart_phase','--ignored','--exact','--nocapture','--test-threads=1'],{env:{...process.env,GUILLE_RESTART_AUTO:autonomous?'1':'0',GUILLE_RESTART_REPO:repo,GUILLE_RESTART_COORDINATION:coordination?'1':'0',GUILLE_RESTART_NO_GIT:noGit?'1':'0',GUILLE_RESTART_PHASE:name,GUILLE_RESTART_SIGNAL:signal,GUILLE_RESTART_APP:identifier,GUILLE_RESTART_ENGINE:origin},windowsHide:true,stdio:'pipe'})
    const exited=new Promise((done)=>app.once('exit',done))
    for(const stream of [app.stdout,app.stderr])stream.on('data',(b)=>{appLog=(appLog+b).slice(-15000)})
    let report
    for(let i=0;i<1200;i++){
      try{report=JSON.parse(await readFile(signal,'utf8'));break}catch{}
      if(app.exitCode!==null)throw new Error(`Phase ${name} exited: ${appLog}`)
      await delay(100)
    }
    assert.ok(report,`Phase ${name} timed out: ${appLog}`)
    dataDir=report.dataDir??dataDir
    if(terminate){assert.equal(report.pid,app.pid);kill(app);await exited}else assert.equal(await exited,0,appLog)
    phases.push({phase:name,...report});console.log(`Restart phase ${name}: ${report.status}`)
    return report
  }
  const first=await phase('prepare',true)
  let observedBusy=false
  for(let i=0;i<100;i++){
    const states=await fetch(origin+'/session/status?directory='+encodeURIComponent(repo),{headers:{Authorization:`Basic ${Buffer.from('opencode:qa-password').toString('base64')}`}}).then((r)=>r.json())
    if(Object.values(states).some((s)=>s.type!=='idle')){observedBusy=true;break}
    await delay(100)
  }
  if(observedBusy) await phase('busy')
  else {
    phases.push({phase:'busy',status:'engine-settled-interrupted-session'})
    console.log('Restart phase busy: engine settled the interrupted session; replay protection will be verified by the final effect count')
  }
  await writeFile(join(repo,'app-continue.flag'),'continue')
  for(let i=0;workerCalls<2&&i<100;i++)await delay(100)
  for(let i=0;i<100;i++){
    const states=await fetch(origin+'/session/status?directory='+encodeURIComponent(repo),{headers:{Authorization:`Basic ${Buffer.from('opencode:qa-password').toString('base64')}`}}).then((r)=>r.json())
    if(Object.values(states).every((s)=>s.type==='idle'))break
    await delay(100)
  }
  const count=workerCalls
  const resumed=await phase('resume')
  assert.equal(resumed.sessionId,first.sessionId);assert.equal(workerCalls,count,'A completed worker must not receive another implementation prompt')
  await phase('reopen');assert.equal(workerCalls,count)
  if(coordination){
    assert.equal(resumed.frontSessionId,first.frontSessionId,'waiting worker must retain its original session across process termination')
    assert.equal(resumed.coordinationId,first.coordinationId,'the same durable request must be resolved after restart')
    assert.equal(await readFile(join(repo,'app-effects.log'),'utf8'),'once\n')
    assert.equal(await readFile(join(repo,'user.txt'),'utf8'),'uncommitted user work\n')
    const reportDir='test-results/coordination-recovery'+(noGit?'-no-git':'')+(autonomous?'-auto':'')
    await mkdir(reportDir,{recursive:true});await writeFile(join(reportDir,'report.json'),JSON.stringify({appProcessKilled:true,noGit,phases,requestPreserved:true,sameWorkerSession:true,sideEffects:1},null,2))
    console.log('Verified: parallel workers, Lead request persisted during actual process termination, same waiting session resumed, no repeated side effect.')
  }else{
  const second=await phase('prepare_engine',true)
  kill(engine);await killFixtureTool('engine');await delay(500);await startEngine()
  const recovered=await phase('resume_engine')
  assert.equal(recovered.sessionId,second.sessionId)
  assert.ok(continuationCalls>0||engineOriginalRetries>0,'Recovery must continue explicitly or verify an engine-resumed request')
  assert.equal(await readFile(join(repo,'app-effects.log'),'utf8'),'once\n')
  assert.equal(await readFile(join(repo,'engine-effects.log'),'utf8'),'once\n')
  assert.equal(await readFile(join(repo,'user.txt'),'utf8'),'uncommitted user work\n')
  if(noGit)await assert.rejects(()=>stat(join(repo,'.git')),{code:'ENOENT'})
  const reportDir=noGit?'test-results/recovery-no-git':'test-results/recovery'
  await mkdir(reportDir,{recursive:true});await writeFile(join(reportDir,'report.json'),JSON.stringify({appProcessKilled:true,engineProcessKilled:true,noGit,workerCalls,continuationCalls,engineOriginalRetries,phases,sideEffects:{app:1,engine:1},userChangesPreserved:true},null,2))
  console.log('Verified actual app restart and engine restart: same session/attempt, side effect exactly once, completed work not replayed, durable final delivery.')
  }
}finally{
  kill(app);kill(engine);mock.closeAllConnections();await new Promise((done)=>mock.close(done))
  await killFixtureTool('app');await killFixtureTool('engine')
  if(dataDir){assert.equal(resolve(dataDir).toLowerCase(),resolve(process.env.APPDATA,identifier).toLowerCase());await rm(dataDir,{recursive:true,force:true,maxRetries:4,retryDelay:200})}
  assert.ok(profile.startsWith(join(tmpdir(),'guille-teams-restart-')));await rm(profile,{recursive:true,force:true,maxRetries:12,retryDelay:250})
}
