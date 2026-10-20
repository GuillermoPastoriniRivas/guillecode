// Runs beside the pinned chrome-devtools-mcp package and narrows every page
// operation to the Chrome window assigned to the calling conversation. The
// scope comes from the authenticated native bridge, never from model arguments.
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile, writeFile, rename } from 'node:fs/promises'

export class Workspaces {
  constructor(file) { this.file = file; this.sessions = {}; this.loaded = false; this.writes = Promise.resolve(); this.creations = new Map() }
  async createTab(session, action) {
    const previous = this.creations.get(session) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(action)
    this.creations.set(session, pending)
    try { return await pending } finally { if (this.creations.get(session) === pending) this.creations.delete(session) }
  }
  async load() {
    if (this.loaded) return
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      this.sessions = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    this.loaded = true
  }
  async save() {
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temp = new URL(`./workspaces-${process.pid}.tmp`, this.file)
      await writeFile(temp, JSON.stringify(this.sessions), 'utf8')
      await rename(temp, this.file)
    })
    await this.writes
  }
  async inventory(context) {
    await context.createPagesSnapshot()
    return (await Promise.all(context.getPages().map(async page => {
      try {
        const client = await page.pptrPage.createCDPSession()
        try {
          const { targetInfo } = await client.send('Target.getTargetInfo')
          const { windowId } = await client.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })
          return { page, id: page.id, target: targetInfo.targetId, windowId, url: page.pptrPage.url() }
        } finally { await client.detach() }
      } catch { return null }
    }))).filter(Boolean)
  }
  async scope(context, meta) {
    await this.load()
    let pages = await this.inventory(context)
    if (meta.action === 'assign') {
      const chosen = pages.find(p => p.id === meta.pageId)
      if (!chosen) throw new Error('La pestaña ya no existe. Volvé a elegir la ventana de Chrome.')
      if (Object.entries(this.sessions).some(([session, w]) => session !== meta.session && w.windowId === chosen.windowId &&
        Array.isArray(w.targets) && pages.some(p => w.targets.includes(p.target) && p.windowId === w.windowId))) {
        throw new Error('Esa ventana ya está asignada a otra conversación. Elegí una ventana dedicada.')
      }
      this.sessions[meta.session] = { windowId: chosen.windowId, targets: pages.filter(p => p.windowId === chosen.windowId).map(p => p.target), selected: chosen.target }
      await this.save()
    }
    const workspace = this.sessions[meta.session]
    // Team members share a window, not a mutable "selected tab" cursor. The
    // actor comes from the authenticated native session registry.
    const selectedTarget = () => meta.actor ? workspace?.actors?.[meta.actor] ?? workspace?.selected : workspace?.selected
    const select = target => {
      if (!meta.actor) { workspace.selected = target; return }
      workspace.actors ??= {}
      delete workspace.actors[meta.actor]
      workspace.actors[meta.actor] = target
      while (Object.keys(workspace.actors).length > 128) delete workspace.actors[Object.keys(workspace.actors)[0]]
    }
    // A recycled windowId is not identity on its own: a target must survive.
    const survives = () => !!workspace && Array.isArray(workspace.targets) && pages.some(p => workspace.targets.includes(p.target) && p.windowId === workspace.windowId)
    const valid = survives()
    const owned = () => valid ? pages.filter(p => p.windowId === workspace.windowId) : []
    if (valid) {
      workspace.targets = owned().map(p => p.target)
      if (!workspace.targets.includes(selectedTarget())) select(workspace.targets[0])
      await this.save()
    }
    meta.state = { assigned: valid, missing: !!workspace && !valid, windowId: valid ? workspace.windowId : null,
      pages: (meta.action ? pages : owned()).map(({ id, windowId, url }) => ({ id, windowId, url })) }
    if (meta.action) return context
    if (!valid) throw new Error('Chrome sin ventana asignada o ventana cerrada. Pedile al usuario que elija «Chrome» en el chat. No uses otra ventana ni Windows como sustituto.')
    const check = page => {
      if (!owned().some(p => p.page === page)) throw new Error('La pestaña no pertenece a la ventana de Chrome de esta conversación.')
      return page
    }
    const selected = () => check(owned().find(p => p.target === selectedTarget())?.page)
    const refresh = async () => {
      pages = await this.inventory(context)
      if (!survives()) throw new Error('Se cerró la ventana de Chrome asignada. Elegí otra desde el chat.')
      workspace.targets = owned().map(p => p.target)
      if (!workspace.targets.includes(selectedTarget())) select(workspace.targets[0])
      await this.save()
    }
    return new Proxy(context, { get: (target, key) => {
      if (key === 'getPages') return () => owned().map(p => p.page)
      if (key === 'getPageById') return id => check(owned().find(p => p.id === id)?.page)
      if (key === 'getSelectedMcpPage') return selected
      if (key === 'getSelectedMcpPageUrl') return page => (page ?? selected()).pptrPage.url()
      if (key === 'isPageSelected') return page => page === selected()
      if (key === 'getSelectedPageFallback') return () => undefined
      if (key === 'selectPage') return page => { check(page); select(owned().find(p => p.page === page).target); target.selectPage(page) }
      if (key === 'createPagesSnapshot') return refresh
      if (key === 'closePage') return async id => {
        const page = check(owned().find(p => p.id === id)?.page)
        if (owned().length === 1) throw new Error('No se puede cerrar la última pestaña de la ventana asignada. Podés dejarla abierta.')
        await page.pptrPage.close()
        await refresh()
      }
      if (key === 'newPage') return async (_background, isolatedContext) => this.createTab(meta.session, async () => {
        if (isolatedContext !== undefined) throw new Error('Esta conversación usa la ventana asignada y su perfil compartido; no un contexto aislado.')
        const page = selected()
        const createdTarget = await openBackgroundTab(page.pptrPage)
        await refresh()
        const created = owned().find(p => p.page.pptrPage.target() === createdTarget)
        if (!created) throw new Error('No pude confirmar la nueva pestaña en la ventana asignada. No reintentes a ciegas.')
        select(created.target)
        await this.save()
        target.selectPage(created.page)
        return created.page
      })
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
}

// CDP newPage lands in Chrome's last active window and can steal focus. A
// trusted Ctrl+click is dispatched inside the source WebContents, so the tab
// opens in that same window, in the background, without OS input, key events
// or activateTarget/bringToFront.
export async function openBackgroundTab(page) {
  const marker = `guillecode-${crypto.randomUUID()}`
  const url = `about:blank#${marker}`
  let client
  try {
    await page.evaluate(id => {
      const a = document.createElement('a')
      a.id = id; a.href = `about:blank#${id}`; a.textContent = ' '
      a.style.cssText = 'position:fixed!important;left:1px!important;top:1px!important;width:4px!important;height:4px!important;z-index:2147483647!important;display:block!important;pointer-events:auto!important'
      document.documentElement.append(a)
      if (document.elementFromPoint(2, 2) !== a) throw new Error('La página tiene una superposición que impide abrir una pestaña de forma segura.')
    }, marker)
    client = await page.createCDPSession()
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1, modifiers: 2 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1, modifiers: 2 })
    return await page.browser().waitForTarget(t => t.type() === 'page' && t.url() === url, { timeout: 5000 })
  } finally {
    await client?.detach().catch(() => {})
    await page.evaluate(id => document.getElementById(id)?.remove(), marker).catch(() => {})
  }
}

export async function install({ McpServer, ToolHandler }, file) {
  const storage = new AsyncLocalStorage()
  const workspaces = new Workspaces(file)
  const register = McpServer.prototype.registerTool
  const unknown = ToolHandler.prototype.unknownArgumentNames
  if (typeof register !== 'function' || typeof unknown !== 'function') {
    throw new Error('Chrome DevTools MCP cambió su contrato de registro; el alcance por conversación no está disponible.')
  }
  McpServer.prototype.registerTool = function(name, config, callback) {
    return register.call(this, name, config, (params, extra) => {
      const { _guillecode: meta, ...argumentsForTool } = params ?? {}
      if (!meta?.session && name !== 'list_pages') throw new Error('Falta la conversación del navegador')
      if (name === 'select_page') argumentsForTool.bringToFront = false
      if (name === 'new_page') argumentsForTool.background = true
      return storage.run(meta || { action: 'inspect' }, async () => {
        const result = await callback(argumentsForTool, extra)
        const state = storage.getStore().state
        if (meta?.action && state && !result.isError) return { content: [{ type: 'text', text: JSON.stringify(state) }] }
        if (state?.assigned) await workspaces.save()
        return result
      })
    })
  }
  // ToolHandler validates arguments before resolving the context. Hooking here
  // lets us ignore the native-only `_guillecode` marker and wrap getContext
  // exactly once per handler with the session carried by AsyncLocalStorage.
  ToolHandler.prototype.unknownArgumentNames = function(params) {
    if (!this.guillecodeScoped) {
      const get = this.getContext
      this.getContext = async () => workspaces.scope(await get(), storage.getStore())
      this.guillecodeScoped = true
    }
    return unknown.call(this, params).filter(key => key !== '_guillecode')
  }
}
