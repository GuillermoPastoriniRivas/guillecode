// Isolated local-browser evidence. Node built-ins only; no browser extensions,
// accounts, user profile, package installation or external automation service.
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { once } from "node:events"

export function localUrl(value) {
  const u = new URL(value)
  if (!['http:', 'https:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error("La captura solo admite una aplicación local sin credenciales en la URL")
  if ([...u.searchParams.keys()].some((k) => /token|key|secret|password|cookie|auth/i.test(k)) || /\.env|credentials|auth\.json/i.test(u.pathname)) throw new Error("URL de evidencia sensible")
  return u
}

async function capture(config) {
  const debug=(message)=>{if(config.debug)process.stderr.write(`${message}\n`)}
  const target = config.target
  const wanted = localUrl(target.url)
  const profile = await mkdtemp(join(tmpdir(), 'guillecode-capture-'))
  const child = spawn(config.browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let socket
  const pending = new Map()
  let sequence = 0
  const deadline = setTimeout(() => { child.kill(); for (const p of pending.values()) p.reject(new Error('La captura superó 40 segundos')) }, 40000)
  try {
    const endpoint = await new Promise((done, fail) => {
      let log = ''
      const timer = setTimeout(() => fail(new Error('El navegador no abrió DevTools')), 15000)
      child.once('error', (e) => {clearTimeout(timer);fail(e)})
      child.once('exit', () => {clearTimeout(timer);fail(new Error('El navegador se cerró antes de capturar'))})
      child.stderr.on('data', (data) => { debug(String(data).slice(0,500));log = (log + data).slice(-4000); const match = log.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/); if (match) { clearTimeout(timer); done(match[1]) } })
    })
    socket = new WebSocket(endpoint)
    await once(socket, 'open')
    const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
      debug(method)
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`DevTools no respondió: ${method}`)) }, 10000)
      pending.set(id, { resolve: (value) => { clearTimeout(timer); done(value) }, reject: (e) => { clearTimeout(timer); fail(e) } })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    socket.addEventListener('message', ({ data }) => {
      const m = JSON.parse(data)
      const p = pending.get(m.id)
      if (p) { pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); return }
      if (m.method === 'Fetch.requestPaused') {
        let allowed = false
        try { const u = new URL(m.params.request.url); allowed = ['data:', 'blob:'].includes(u.protocol) || (['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) } catch { /* refuse unknown URL */ }
        void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: m.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }, m.sessionId).catch(() => undefined)
      }
    })
    const created = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    const cdp = (method, params) => send(method, params, sessionId)
    await cdp('Page.enable')
    await cdp('Page.setLifecycleEventsEnabled', { enabled: true })
    await cdp('Runtime.enable')
    await cdp('Network.enable')
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    await cdp('Emulation.setDeviceMetricsOverride', { width: target.width, height: target.height, deviceScaleFactor: 1, mobile: false })
    let httpStatus = null
    socket.addEventListener('message', ({ data }) => { const m = JSON.parse(data); if (m.sessionId === sessionId && m.method === 'Network.responseReceived' && m.params.type === 'Document') httpStatus = m.params.response.status })
    const evaluate = async (fn, argument) => {
      const r = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(argument)})`, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 500) || 'El flujo de captura falló')
      return r.result.value
    }
    // Runtime.evaluate immediately after navigate can run in about:blank's
    // context, which is destroyed by the navigation. Wait for this loader's
    // load event, including events delivered before the navigate response.
    const loaded = new Set()
    const onLifecycle = ({ data }) => {
      const event = JSON.parse(data)
      if (event.sessionId === sessionId && event.method === 'Page.lifecycleEvent' && event.params.name === 'load') loaded.add(event.params.loaderId)
    }
    socket.addEventListener('message', onLifecycle)
    const nav = await cdp('Page.navigate', { url: wanted.href })
    if (nav.errorText) throw new Error(`La aplicación no respondió: ${nav.errorText}`)
    const navigationStarted = Date.now()
    while (nav.loaderId && !loaded.has(nav.loaderId)) {
      if (Date.now() - navigationStarted > 15000) throw new Error('La aplicación no terminó de cargar el documento solicitado')
      await new Promise((done) => setTimeout(done, 50))
    }
    socket.removeEventListener('message', onLifecycle)
    if (httpStatus >= 400) throw new Error(`La aplicación local respondió HTTP ${httpStatus}; no se presenta como una captura del flujo funcionando`)
    await evaluate(async ({ selector, expectedOrigin }) => {
      const start = Date.now()
      while (location.origin!==expectedOrigin || document.readyState !== 'complete' || (selector && !document.querySelector(selector))) {
        if (Date.now() - start > 8000) throw new Error('La página o el selector esperado no estuvieron listos')
        await new Promise((done) => setTimeout(done, 100))
      }
      await document.fonts.ready
    }, { selector: target.waitForSelector || null, expectedOrigin:wanted.origin })
    const steps = []
    for (const action of target.actions ?? []) {
      await evaluate(async (a) => {
        const start = Date.now()
        while (!document.querySelector(a.selector)) { if (Date.now() - start > 5000) throw new Error('No se encontró el elemento del flujo'); await new Promise((done) => setTimeout(done, 100)) }
        const el = document.querySelector(a.selector)
        if (a.kind === 'click') el.click()
        else if (a.kind === 'fill') {
          const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set
          if (!setter || el.type === 'file' || el.type === 'password') throw new Error('El flujo no admite archivos ni contraseñas')
          setter.call(el, a.value ?? ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
        } else if (a.kind !== 'wait') throw new Error('Paso de captura desconocido')
        await new Promise((done) => setTimeout(done, 200))
      }, action)
      steps.push({ kind: action.kind, selector: action.selector, status: 'executed' })
    }
    const observation = await evaluate(async ({ masks, expectedOrigin }) => {
      if (location.origin !== expectedOrigin) throw new Error('El flujo salió del origen autorizado')
      const style = document.createElement('style'); style.textContent = '*,*::before,*::after { animation:none!important; transition:none!important; caret-color:transparent!important }'; document.head.append(style)
      let masked = 0
      for (const selector of ['input', 'textarea', '[contenteditable=true]', '[data-private]', '[data-sensitive]', ...masks]) for (const el of document.querySelectorAll(selector)) { el.style.setProperty('visibility', 'hidden', 'important'); masked++ }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (['SCRIPT','STYLE'].includes(node.parentElement?.tagName)) continue
        node.textContent = node.textContent.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email oculto]').replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/g, '[credencial oculta]')
      }
      await new Promise((done) => setTimeout(done,100))
      return { title: document.title, text: document.body.innerText.slice(0, 32000), maskedElements: masked, url: location.href }
    }, { masks: target.maskSelectors ?? [], expectedOrigin: wanted.origin })
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
    const bytes = Buffer.from(screenshot.data, 'base64')
    if (bytes.length < 32 || bytes.length > 5 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('El navegador no devolvió un PNG válido dentro del límite de 5 MB')
    if (bytes.readUInt32BE(16) !== target.width || bytes.readUInt32BE(20) !== target.height) throw new Error('El tamaño de la captura no coincide con el viewport solicitado')
    await writeFile(config.output, bytes, { flag: 'wx' })
    debug('PNG saved')
    return { status: 'captured', httpStatus, ...observation, steps, width: target.width, height: target.height, bytes: bytes.length, source: 'Chrome DevTools Protocol · perfil temporal aislado' }
  } finally {
    clearTimeout(deadline)
    if (socket?.readyState === WebSocket.OPEN) socket.close()
    for(const p of pending.values())p.reject(new Error('Captura cerrada'))
    pending.clear()
    if (child.pid && process.platform === 'win32') {
      const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
      await Promise.race([once(killer,'exit'),new Promise((done)=>setTimeout(done,2000))])
    } else if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((done) => setTimeout(done, 2000))]) }
    const safe = resolve(profile)
    if (safe.startsWith(resolve(tmpdir()) + sep) && safe.includes('guillecode-capture-')) await rm(safe, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined)
    debug('Capture closed')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input = ''
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 100000) throw new Error('Configuración de captura demasiado grande') }
    const config = JSON.parse(input)
    const result=await capture(config)
    process.stdout.write(JSON.stringify(result),()=>process.exit(0))
  } catch (error) { process.stdout.write(JSON.stringify({ status: 'unavailable', reason: String(error.message).slice(0, 1000) }),()=>process.exit(1)) }
}
