// Isolated headless Chromium profile: exercise the actual CDP background-tab path
// across two browser windows without touching the user's Chrome or profile.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Workspaces } from '../src-tauri/src/desktop/browser_workspace.mjs'
const bundle = join(process.env.LOCALAPPDATA, 'com.guillecode.desktop/browser-bridge/node_modules/chrome-devtools-mcp/build/src/third_party/index.js')
const { puppeteer } = await import(pathToFileURL(bundle))
const dir = await mkdtemp(join(tmpdir(), 'gc-background-tab-'))
const executablePath = [
  join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
].find(existsSync)
assert.ok(executablePath, 'Install Chrome or Edge for the isolated CDP test')
const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: join(dir, 'profile') })
try {
  const control = await browser.target().createCDPSession()
  await control.send('Target.createTarget', { url: 'about:blank#second-window', newWindow: true })
  const secondTarget = await browser.waitForTarget(t => t.url() === 'about:blank#second-window')
  await secondTarget.page()
  const entries = new Map()
  let next = 0
  const context = { createPagesSnapshot: async () => {
    const pages = await browser.pages()
    for (const page of pages) if (!entries.has(page)) entries.set(page, { id: ++next, pptrPage: page })
    for (const [page] of entries) if (!pages.includes(page)) entries.delete(page)
  }, getPages: () => [...entries.values()], selectPage() {} }
  const ws = new Workspaces(pathToFileURL(join(dir, 'workspaces.json')))
  const inventory = await ws.inventory(context)
  assert.ok(new Set(inventory.map(p => p.windowId)).size >= 2, `Need two distinct Chrome windows: ${JSON.stringify(inventory.map(({ id, windowId }) => ({ id, windowId })))}`)
  const origin = inventory[0]
  await ws.scope(context, { session: 'team:recovery', action: 'assign', pageId: origin.id })
  const scoped = await ws.scope(context, { session: 'team:recovery' })
  const personal = inventory.find(p => p.windowId !== origin.windowId)
  await personal.page.pptrPage.bringToFront() // agent window is not last active
  const created = await scoped.newPage(true)
  const after = await ws.inventory(context)
  const createdEntry = after.find(p => p.page === created)
  assert.equal(createdEntry.windowId, origin.windowId, 'New tab must stay in assigned window, not last active')
  assert.equal(scoped.getSelectedMcpPage(), created)
  assert.throws(() => scoped.getPageById(personal.id), /no pertenece/)
  // Closed team window: recovery creates exactly one new empty window, never
  // claims a personal window, and simultaneous agents share the recovery.
  for (const entry of after.filter(p=>p.windowId===origin.windowId)) await entry.page.pptrPage.close()
  const personalUrl=personal.page.pptrPage.url()
  const recovered=await Promise.all([1,2,3].map(actor=>ws.scope(context,{session:'team:recovery',actor:String(actor),autoRecover:true})))
  const recoveredPages=recovered[0].getPages()
  assert.equal(recoveredPages.length,1,'Concurrent recovery must create one new tab/window')
  assert.equal(recoveredPages[0].pptrPage.url(),'about:blank','No previous action or form is replayed')
  assert.equal(personal.page.pptrPage.url(),personalUrl,'Personal tab is unchanged')
  assert.throws(()=>recovered[0].getPageById(personal.id),/no pertenece/)
  const recoveredInventory=await ws.inventory(context)
  assert.notEqual(recoveredInventory.find(p=>p.page===recoveredPages[0]).windowId,personal.windowId)
  const restarted=new Workspaces(pathToFileURL(join(dir,'workspaces.json')))
  assert.equal((await restarted.scope(context,{session:'team:recovery'})).getPages()[0],recoveredPages[0])
  console.log('Actual CDP background tabs, closed-window recovery, concurrent recovery, personal-tab isolation and restart: PASS')
} finally { await browser.close(); await rm(dir, { recursive: true, force: true }) }
