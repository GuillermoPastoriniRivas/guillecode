import { test } from "node:test"
import assert from "node:assert/strict"
import { FlufyPacing } from "../src-tauri/src/agent_pacing.js"

async function withConfig(config, run) {
  const previous = process.env.OPENCODE_CONFIG_CONTENT
  try {
    if (config === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = config
    await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = previous
  }
}

const flufyConfig = JSON.stringify({ mcp: {
  terminal: { url: "http://127.0.0.1:12345/mcp/terminal" },
  worktrees: { url: "http://127.0.0.1:12345/mcp/worktrees" },
} })

test("el guardrail de ritmo no toca motores ajenos a Flufy", async () => {
  for (const config of [undefined, "invalid", "null", "{}", JSON.stringify({ mcp: { terminal: { url: "https://example.com" } } })]) {
    await withConfig(config, async () => assert.deepEqual(await FlufyPacing(), {}))
  }
})

test("inyecta el ritmo una sola vez y respeta lo que ya estaba", async () => {
  await withConfig(flufyConfig, async () => {
    const first = await FlufyPacing()
    const second = await FlufyPacing()
    const output = { system: ["Instrucciones del modelo"] }
    await first["experimental.chat.system.transform"]({}, output)
    await second["experimental.chat.system.transform"]({}, output)
    assert.equal(output.system.length, 2)
    assert.equal(output.system[0], "Instrucciones del modelo")
    assert.ok(output.system[1].startsWith("# Flufy: ritmo"))
  })
})
