// Real SDK + real ToolHandler, with controlled pages. No Chrome/user data is
// touched. This exercises registration and execution, not just prototype identity.
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { install } from '../src-tauri/src/desktop/browser_workspace.mjs'

const root = join(process.env.LOCALAPPDATA, 'com.guillecode.desktop/browser-bridge/node_modules/chrome-devtools-mcp/build/src')
const { McpServer, Mutex, zod } = await import(pathToFileURL(join(root, 'third_party/index.js')))
const { ToolHandler } = await import(pathToFileURL(join(root, 'ToolHandler.js')))
const launcher = await readFile(new URL('../src-tauri/src/desktop/browser_launcher.mjs', import.meta.url), 'utf8')
assert.match(launcher, /import \{ McpServer \} from ['"].*third_party\/index\.js['"]/, 'Launcher must intercept the SDK, not the application class')
const dir = await mkdtemp(join(tmpdir(), 'gc-mcp-integration-'))
const p = (id, windowId) => ({ id, pptrPage: { url: () => `https://test/${id}`,
  createCDPSession: async () => ({ send: async name => name === 'Target.getTargetInfo' ? { targetInfo: { targetId: `t${id}` } } : { windowId }, detach: async () => {} }) } })
const pages = [p(1, 100), p(2, 200)]
const context = { createPagesSnapshot: async () => {}, getPages: () => pages, selectPage() {},
  browser: { process: () => null, wsEndpoint: () => 'ws://127.0.0.1' },
  consumeReconnectNotice: () => false, getDevToolsData: async () => undefined, getSelectedMcpPageUrl: () => 'https://test/1' }
try {
  await install({ McpServer, ToolHandler }, pathToFileURL(join(dir, 'workspaces.json')))
  const server = new McpServer({ name: 'scope-test', version: '1' })
  const register = (name, schema, handler) => {
    const tool = { name, schema, annotations: {}, verifyFilesSchema: {}, handler }
    const impl = new ToolHandler(tool, { slim: false }, async () => context, new Mutex())
    return server.registerTool(name, { inputSchema: impl.registeredInputSchema }, impl.handle)
  }
  const list = register('list_pages', {}, async (_, response, context) => response.appendResponseLine(context.getPages().map(p => p.id).join(',')))
  const read = register('scope_probe', { pageId: zod.number() }, async (request, response, context) => response.appendResponseLine(String(context.getPageById(request.params.pageId).id)))
  const invoke = (registered, args) => registered.handler(registered.inputSchema.parse(args))
  const text = result => result.content.map(c => c.text).join('\n')
  const assignment = await invoke(list, { _guillecode: { session: 'a', action: 'assign', pageId: 1 } })
  assert.ok(!assignment.isError, JSON.stringify(assignment))
  assert.equal(JSON.parse(text(assignment)).windowId, 100)
  assert.match(text(await invoke(list, { _guillecode: { session: 'a' } })), /\b1\b/)
  assert.match(text(await invoke(read, { pageId: 1, _guillecode: { session: 'a' } })), /\b1\b/)
  const foreign = await invoke(read, { pageId: 2, _guillecode: { session: 'a' } })
  assert.equal(foreign.isError, true)
  assert.match(text(foreign), /no pertenece/)
  assert.throws(() => invoke(read, { pageId: 1 }), /Falta la conversación/)
  console.log('Real MCP registration → ToolHandler → scoped context: PASS (assignment, reads, foreign-window rejection, missing session)')
  await server.close()
} finally { await rm(dir, { recursive: true, force: true }) }
