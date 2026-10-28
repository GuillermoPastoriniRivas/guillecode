import { test } from "node:test"
import assert from "node:assert/strict"
import { FlufyPolicy } from "../src-tauri/src/agent_policy.js"

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

const guillecodeConfig = JSON.stringify({ mcp: {
  terminal: { url: "http://127.0.0.1:12345/mcp/terminal" },
  worktrees: { url: "http://127.0.0.1:12345/mcp/worktrees" },
} })

test("las sesiones de equipos conservan su política específica", async () => {
  await withConfig(guillecodeConfig, async () => {
    const plugin = await FlufyPolicy()
    const output = { system: ["[GUILLECODE_TEAM_RUN] El Lead coordina tareas"] }
    await plugin["experimental.chat.system.transform"]({}, output)
    assert.equal(output.system.length, 1)
  })
})

test("la política global no altera motores ajenos a Flufy", async () => {
  for (const config of [undefined, "invalid", "null", "{}", JSON.stringify({ mcp: { terminal: { url: "https://example.com" } } })]) {
    await withConfig(config, async () => assert.deepEqual(await FlufyPolicy(), {}))
  }
})

test("inyecta una sola política sin depender de memoria ni modificar instrucciones existentes", async () => {
  await withConfig(guillecodeConfig, async () => {
    const first = await FlufyPolicy()
    const second = await FlufyPolicy()
    const output = { system: ["Instrucciones del modelo", "Requisitos del proyecto"] }
    await first["experimental.chat.system.transform"]({ sessionID: "session-with-memory-off" }, output)
    await second["experimental.chat.system.transform"]({ sessionID: "session-with-memory-off" }, output)
    assert.equal(output.system.length, 3)
    assert.deepEqual(output.system.slice(0, 2), ["Instrucciones del modelo", "Requisitos del proyecto"])
    assert.ok(output.system[2].startsWith("# Flufy: directo al objetivo"))

    const next = { system: ["Otro modelo"] }
    await first["experimental.chat.system.transform"]({}, next)
    assert.equal(next.system.length, 2)
  })
})
