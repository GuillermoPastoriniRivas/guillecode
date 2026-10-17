// Isolated headless Edge profile: exercise the actual CDP background-tab path
// across two browser windows without touching the user's Chrome or profile.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Workspaces } from '../src-tauri/src/desktop/browser_workspace.mjs'
const bundle = join(process.env.LOCALAPPDATA, 'com.guillecode.desktop/browser-bridge/node_modules/chrome-devtools-mcp/build/src/third_party/index.js')
const { puppeteer } = await import(pathToFileURL(bundle))
const dir = await mkdtemp(join(tmpdir(), 'gc-background-tab-'))
const executablePath = join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe')
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
  await ws.scope(context, { session: 'test', action: 'assign', pageId: origin.id })
  const scoped = await ws.scope(context, { session: 'test' })
  const personal = inventory.find(p => p.windowId !== origin.windowId)
  await personal.page.pptrPage.bringToFront() // agent window is not last active
  const created = await scoped.newPage(true)
  const after = await ws.inventory(context)
  const createdEntry = after.find(p => p.page === created)
  assert.equal(createdEntry.windowId, origin.windowId, 'New tab must stay in assigned window, not last active')
  assert.equal(scoped.getSelectedMcpPage(), created)
  assert.throws(() => scoped.getPageById(personal.id), /no pertenece/)
  console.log('Actual CDP newPage across two isolated browser windows: PASS')
} finally { await browser.close(); await rm(dir, { recursive: true, force: true }) }
