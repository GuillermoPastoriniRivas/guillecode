import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode')

const root = path.resolve('../mdvault/packages/ui/out')
const pwa = path.resolve('dist-pwa')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
async function resource(base, pathname) {
  const relative = pathname === '/' ? (base === pwa ? '/pwa.html' : '/index.html') : pathname
  const target = path.resolve(base, `.${relative}`)
  assert.ok(target.startsWith(base + path.sep))
  try { return { body: await readFile(target), contentType: mime[path.extname(target)] ?? 'application/octet-stream' } }
  catch { return { body: await readFile(target + '.html'), contentType: 'text/html' } }
}
const server = createServer(async (req, res) => {
  try { const file = await resource(root, new URL(req.url, 'http://localhost').pathname); res.writeHead(200, { 'Content-Type': file.contentType }); res.end(file.body) }
  catch { res.writeHead(404); res.end('not found') }
})
await new Promise(resolve => server.listen(3300, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  await context.addInitScript(() => {
    if (location.hostname.endsWith('.ts.net')) {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Third-party storage blocked', 'SecurityError') } })
    }
  })
  const token = 'a'.repeat(64)
  const computers = [
    { id: 'desktop', name: 'Escritorio', origin: 'https://desktop.tail123.ts.net', token },
    { id: 'laptop', name: 'Notebook', origin: 'https://laptop.tail123.ts.net', token },
  ]
  let loggedIn = false
  let notebookOnline = true
  const qrDir = await mkdtemp(path.join(os.tmpdir(), 'guillecode-qr-'))
  const httpQrPath = path.join(qrDir, 'http.png')
  await QRCode.toFile(httpQrPath, `http://newpc.tail123.ts.net/?t=${token}`, { width: 420, margin: 1 })
  await context.route('**/*', async route => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.hostname.endsWith('.ts.net')) {
      if (url.hostname.startsWith('laptop') && !notebookOnline) return route.abort()
      if (url.pathname.startsWith('/hub/') || url.pathname.startsWith('/oc/')) {
        if (req.headers().authorization !== `Bearer ${token}`) return route.fulfill({ status: 401, json: { error: 'token inválido' } })
        if (url.pathname === '/hub/info') return route.fulfill({ json: { current: 'C:/Project', projects: ['C:/Project'], routines: [] } })
        if (url.pathname === '/oc/session/status') return route.fulfill({ json: { working: { type: 'busy' } } })
        if (url.pathname === '/oc/permission') return route.fulfill({ json: [{ id: 'perm', sessionID: 'working', permission: 'bash', patterns: ['test'] }] })
        if (url.pathname === '/oc/session') return route.fulfill({ json: [{ id: 'working', title: 'Tarea de prueba', time: { created: Date.now(), updated: Date.now() } }] })
        if (url.pathname === '/hub/events') return route.fulfill({ status: 404, json: {} })
        return route.fulfill({ json: [] })
      }
      try { return route.fulfill(await resource(pwa, url.pathname)) } catch { return route.fulfill({ status: 404, body: '' }) }
    }
    if (url.pathname === '/auth/me') return route.fulfill({ status: loggedIn ? 200 : 401, json: loggedIn ? { user: { id: 'owner', email: 'test@example.com' } } : { error: 'Autenticación requerida' } })
    if (url.pathname === '/auth/login') { loggedIn = true; return route.fulfill({ json: { user: { id: 'owner', email: 'test@example.com' } } }) }
    if (url.pathname === '/auth/register') { loggedIn = true; return route.fulfill({ json: { user: { id: 'owner', email: 'test@example.com' } } }) }
    if (url.pathname === '/auth/password-reset/request') return route.fulfill({ json: { ok: true, token: 'reset-test-token' } })
    if (url.pathname === '/auth/password-reset/confirm') { loggedIn = true; return route.fulfill({ json: { user: { id: 'owner', email: 'test@example.com' } } }) }
    if (url.pathname === '/auth/logout') { loggedIn = false; return route.fulfill({ json: { ok: true } }) }
    if (url.pathname === '/guillecode-api/computers') {
      if (req.method() === 'POST') {
        const body = req.postDataJSON()
        const link = new URL(body.link)
        if (!link.hostname.endsWith('.ts.net')) return route.fulfill({ status: 400, json: { error: 'Usá el enlace HTTPS de Tailscale.' } })
        let pc = computers.find(pc => pc.origin === link.origin)
        if (!pc) { pc = { id: `pc-${computers.length}`, name: body.name, origin: link.origin, token }; computers.push(pc) }
        pc.name = body.name
        return route.fulfill({ json: pc })
      }
      return route.fulfill({ json: { computers } })
    }
    if (url.pathname.startsWith('/guillecode-api/computers/')) { const id = url.pathname.split('/').pop(); computers.splice(computers.findIndex(pc => pc.id === id), 1); return route.fulfill({ json: { ok: true } }) }
    return route.continue()
  })
  const cameraQr = await QRCode.toDataURL(`https://fluws.com/guillecode/app#${new URLSearchParams({ pair: `https://newpc.tail123.ts.net/?t=${token}`, name: 'PC del QR' })}`, { width: 520, margin: 2 })
  await context.addInitScript((dataUrl) => {
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} })
    navigator.mediaDevices.getUserMedia = async () => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 640
      const c = canvas.getContext('2d')
      const draw = () => { c.fillStyle = '#fff'; c.fillRect(0, 0, 640, 640); c.drawImage(image, 30, 30, 580, 580) }
      draw()
      setInterval(draw, 150)
      return canvas.captureStream(15)
    }
  }, cameraQr)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const shots = process.env.GUILLECODE_FLEET_SHOTS
  const capture = async (name, fullPage = true) => { if (shots) await page.screenshot({ path: path.join(shots, `guillecode-${name}.png`), fullPage }) }
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page must not overflow horizontally')
  await page.goto('http://localhost:3300/')
  await page.getByRole('link', { name: 'Abrir GuilleCode', exact: true }).waitFor()
  await noOverflow()
  await capture('journey-home-mobile', false)
  await page.getByRole('button', { name: 'Abrir menú', exact: true }).click()
  await page.getByRole('dialog', { name: 'Menú de fluws' }).getByRole('link', { name: /GuilleCode/ }).click()
  await page.waitForURL('**/guillecode')
  await noOverflow()
  assert.equal(await page.getByRole('link', { name: 'Abrir mis computadoras →', exact: true }).evaluate(element => getComputedStyle(element).color), 'rgb(36, 29, 49)', 'light mobile CTA must have dark, readable text')
  await capture('journey-product-mobile', false)
  await page.getByRole('link', { name: 'Abrir mis computadoras →', exact: true }).click()
  await page.getByRole('button', { name: 'Iniciar sesión' }).waitFor()
  await noOverflow()
  await capture('login-mobile')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow()
  await capture('login-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Email', { exact: true }).fill('test@example.com')
  await page.getByLabel('Contraseña', { exact: true }).fill('mock-password')
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await page.getByRole('heading', { name: 'Mis computadoras' }).waitFor()
  await page.getByText('Conectada', { exact: true }).first().waitFor({ timeout: 20000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.gc-status-chip.is-online')].length === 2)
  assert.equal(await page.locator('.gc-stat strong').nth(1).innerText(), '2')
  assert.equal(await page.locator('.gc-stat strong').nth(2).innerText(), '2')
  const openFirst = await page.getByRole('button', { name: 'Abrir Escritorio', exact: true }).boundingBox()
  const openSecond = await page.getByRole('button', { name: 'Abrir Notebook', exact: true }).boundingBox()
  assert.ok(openFirst && openSecond && openSecond.y + openSecond.height < 777, 'both PCs must be actionable above the mobile navigation without scrolling')
  await noOverflow()
  await capture('dashboard-mobile')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow()
  await capture('dashboard-desktop')
  await page.setViewportSize({ width: 768, height: 1024 })
  await noOverflow()
  await page.setViewportSize({ width: 320, height: 740 })
  await noOverflow()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Buscar computadora', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Buscar computadora', exact: true }).fill('Notebook')
  assert.equal(await page.locator('.gc-computer-card').count(), 1)
  await page.getByRole('searchbox', { name: 'Buscar computadora', exact: true }).fill('')
  await page.getByRole('button', { name: 'Cerrar búsqueda' }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Vista en lista' }).click()
  assert.equal(await page.locator('.gc-computer-grid.is-list').count(), 1)
  await noOverflow()
  await page.getByRole('button', { name: 'Vista en tarjetas' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('navigation', { name: 'Navegación móvil' }).getByRole('button', { name: 'Actividad', exact: true }).click()
  await page.getByRole('heading', { name: 'Tu trabajo, en movimiento.' }).waitFor()
  assert.equal(await page.getByText('1 respuesta pendiente', { exact: true }).count(), 2)
  await page.getByRole('navigation', { name: 'Navegación móvil' }).getByRole('button', { name: 'Conexión', exact: true }).click()
  await page.getByRole('heading', { name: 'Un espacio. Sin distancias.' }).waitFor()
  await noOverflow()
  await capture('guide-mobile')
  await page.getByRole('navigation', { name: 'Navegación móvil' }).getByRole('button', { name: 'Computadoras', exact: true }).click()
  const frame = page.frames().find(frame => frame.url().includes('desktop.tail123.ts.net'))
  assert.ok(frame)
  assert.ok(!frame.url().includes(token), 'fragment credential must be removed from URL')
  await page.getByRole('button', { name: 'Abrir Escritorio', exact: true }).click()
  await frame.getByText('Tarea de prueba', { exact: true }).first().waitFor({ timeout: 20000 })
  await page.goBack()
  await page.getByRole('heading', { name: 'Mis computadoras', exact: true }).waitFor()
  assert.ok(!page.url().includes('pc='), 'browser Back must return to the PC chooser')
  assert.equal(await page.getByRole('button', { name: /Continuar/ }).count(), 1)
  await page.getByRole('button', { name: 'Abrir PC', exact: true }).nth(1).click()
  assert.equal(await page.locator('iframe.gc-pc').getAttribute('title'), 'GuilleCode — Notebook')
  await page.getByLabel('Cambiar computadora').selectOption('desktop')
  assert.equal(await page.locator('iframe.gc-pc').getAttribute('title'), 'GuilleCode — Escritorio')
  await page.getByRole('button', { name: 'Mis computadoras', exact: true }).click()
  await page.getByRole('button', { name: 'Agregar computadora', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tu espacio crece.' })
  await dialog.waitFor()
  await capture('connect-mobile', false)
  await page.getByRole('button', { name: 'Escanear QR con la cámara', exact: true }).click()
  await dialog.locator('.gc-qr-reader').waitFor()
  await capture('qr-scanner-mobile', false)
  await page.waitForFunction(() => document.querySelector('#gc-link')?.value.includes('newpc.tail123.ts.net'), null, { timeout: 25000 })
  await dialog.locator('.gc-qr-reader').waitFor({ state: 'hidden' })
  assert.equal(await page.getByLabel('Nombre de la computadora', { exact: true }).inputValue(), 'PC del QR')
  await page.locator('.gc-qr-photo input[type=file]').setInputFiles(httpQrPath)
  await dialog.getByText('Este QR usa HTTP', { exact: false }).waitFor({ timeout: 15000 })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Agregar computadora', exact: true }).click()
  await page.getByLabel('Nombre de la computadora', { exact: true }).fill('PC oficina')
  await page.getByLabel('Enlace HTTPS de «Conectar el celular»', { exact: true }).fill(`https://office.tail123.ts.net/?t=${token}`)
  await page.getByRole('button', { name: 'Guardar computadora' }).click()
  await page.getByRole('heading', { name: 'PC oficina', exact: true }).waitFor()
  assert.equal(await page.locator('.gc-computer-card').count(), 3)
  await page.getByLabel('Opciones de PC oficina', { exact: true }).click()
  await page.getByRole('button', { name: 'Renombrar / actualizar' }).click()
  await page.getByLabel('Nombre de la computadora', { exact: true }).fill('Oficina actualizada')
  await page.getByRole('button', { name: 'Guardar computadora' }).click()
  await page.getByRole('heading', { name: 'Oficina actualizada', exact: true }).waitFor()
  assert.equal(await page.locator('.gc-computer-card').count(), 3)
  await page.getByLabel('Opciones de Oficina actualizada', { exact: true }).click()
  await page.getByRole('button', { name: 'Quitar computadora', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Quitar computadora', exact: true }).click()
  await page.getByRole('heading', { name: 'Oficina actualizada', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.gc-computer-card').count(), 2)
  notebookOnline = false
  await page.getByText('Sin conexión', { exact: true }).waitFor({ timeout: 45000 })
  await page.getByRole('button', { name: 'Abrir PC', exact: true }).nth(1).click()
  await page.getByRole('heading', { name: 'Todavía no llegamos a tu PC.' }).waitFor()
  await capture('connection-recovery-mobile', false)
  notebookOnline = true
  await page.getByRole('button', { name: 'Reintentar conexión' }).click()
  await page.locator('iframe.gc-pc:not(.gc-pc-obscured)').waitFor({ timeout: 20000 })
  await page.getByRole('button', { name: 'Mis computadoras', exact: true }).click()
  computers.splice(0, computers.length)
  await page.reload()
  await page.getByRole('heading', { name: 'Traé tu primera computadora.' }).waitFor()
  await noOverflow()
  await capture('empty-mobile')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow()
  await capture('empty-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Cuenta', exact: true }).click()
  await page.getByRole('dialog', { name: 'Tu cuenta' }).getByRole('button', { name: 'Salir', exact: true }).click()
  await page.getByRole('button', { name: 'Iniciar sesión' }).waitFor()
  assert.equal(await page.locator('iframe').count(), 0)
  // Registration stays inside GuilleCode and preserves a QR invitation until explicit save.
  await page.goto(`http://localhost:3300/guillecode/app#${new URLSearchParams({ pair: `https://paired.tail123.ts.net/?t=${token}`, name: 'PC del QR' })}`)
  await page.getByRole('button', { name: 'Creá tu cuenta', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill('new@example.com')
  await page.getByLabel('Contraseña', { exact: true }).fill('mock-password')
  await page.getByRole('button', { name: 'Crear cuenta y continuar', exact: true }).click()
  await page.getByRole('dialog', { name: 'Tu espacio crece.' }).waitFor()
  assert.equal(await page.getByLabel('Nombre de la computadora', { exact: true }).inputValue(), 'PC del QR')
  assert.ok((await page.getByLabel('Enlace HTTPS de «Conectar el celular»', { exact: true }).inputValue()).includes('paired.tail123.ts.net'))
  assert.ok(page.url().includes('/guillecode/app') && !page.url().includes('auth='))
  await page.getByRole('button', { name: 'Cerrar formulario' }).click()
  await page.getByRole('button', { name: 'Cuenta', exact: true }).click()
  await page.getByRole('dialog', { name: 'Tu cuenta' }).getByRole('button', { name: 'Salir', exact: true }).click()
  // The shared fluws auth routes also return to the intended product.
  await page.goto('http://localhost:3300/login?next=%2Fguillecode%2Fapp')
  await page.getByLabel('Email', { exact: true }).fill('test@example.com')
  await page.getByLabel('Contraseña', { exact: true }).fill('mock-password')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL('**/guillecode/app')
  await page.getByRole('heading', { name: 'Traé tu primera computadora.' }).waitFor()
  await page.getByRole('button', { name: 'Cuenta', exact: true }).click()
  await page.getByRole('dialog', { name: 'Tu cuenta' }).getByRole('button', { name: 'Salir', exact: true }).click()
  await page.goto('http://localhost:3300/register?next=%2Fguillecode%2Fapp')
  await page.getByLabel('Email', { exact: true }).fill('new@example.com')
  await page.getByLabel('Contraseña', { exact: true }).fill('mock-password')
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click()
  await page.waitForURL('**/guillecode/app')
  await page.getByRole('heading', { name: 'Traé tu primera computadora.' }).waitFor()
  await page.getByRole('button', { name: 'Cuenta', exact: true }).click()
  await page.getByRole('dialog', { name: 'Tu cuenta' }).getByRole('button', { name: 'Salir', exact: true }).click()
  await page.goto(`http://localhost:3300/guillecode/app#${new URLSearchParams({ pair: `https://recovered.tail123.ts.net/?t=${token}`, name: 'PC tras recuperar acceso' })}`)
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor()
  await page.getByRole('link', { name: '¿La olvidaste?', exact: true }).click()
  await page.waitForURL('**/forgot**')
  await page.getByLabel('Email', { exact: true }).fill('test@example.com')
  await page.getByRole('button', { name: 'Enviar enlace', exact: true }).click()
  await page.getByRole('link', { name: 'Elegir una contraseña nueva', exact: true }).waitFor({ timeout: 60000 })
  await page.getByRole('link', { name: 'Elegir una contraseña nueva', exact: true }).click()
  await page.getByLabel('Contraseña (mínimo 8 caracteres)', { exact: true }).fill('new-password')
  await page.getByLabel('Repetila', { exact: true }).fill('new-password')
  await page.getByRole('button', { name: 'Cambiar contraseña y entrar', exact: true }).click()
  await page.waitForURL('**/guillecode/app')
  await page.getByRole('dialog', { name: 'Tu espacio crece.' }).waitFor()
  assert.equal(await page.getByLabel('Nombre de la computadora', { exact: true }).inputValue(), 'PC tras recuperar acceso')
  await page.getByRole('button', { name: 'Cerrar formulario' }).click()
  await page.getByRole('heading', { name: 'Traé tu primera computadora.' }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: mobile journey from fluws home, menu/product, above-fold PC actions, browser Back, inline registration + QR continuity, shared auth/reset return, QR camera auto-read + bad-QR validation, responsive 320/390/768/1440, PC controls and recovery')
} finally {
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
}
