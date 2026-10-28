import { pathToFileURL } from 'node:url'
import { install } from './browser_workspace.mjs'
// Intercept the SDK server, not the application's McpServer (whose tool
// registration is private). Both must be the same module used by upstream.
import { McpServer } from './node_modules/chrome-devtools-mcp/build/src/third_party/index.js'
import { ToolHandler } from './node_modules/chrome-devtools-mcp/build/src/ToolHandler.js'
await install({ McpServer, ToolHandler }, process.env.GUILLECODE_WORKSPACES_FILE ? pathToFileURL(process.env.GUILLECODE_WORKSPACES_FILE) : new URL('./workspaces.json', import.meta.url))
await import('./node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')
