import { test } from "node:test"
import assert from "node:assert/strict"
import { chooseAvailableModel, hasAccount, modelAvailable, EMPTY_MODEL } from "../src/lib/providers.ts"

const chatgpt = { providerID: "openai", modelID: "gpt-test" }
const go = { providerID: "opencode-go", modelID: "deepseek-test" }

test("ChatGPT solo no necesita OpenCode y reemplaza un modelo anterior de Go", () => {
  assert.equal(hasAccount({ id: "openai", options: { apiKey: "opencode-oauth-dummy-key" } }), true)
  assert.deepEqual(chooseAvailableModel([chatgpt], go), chatgpt)
})
test("OpenCode solo y ambos: conserva el modelo elegido si sigue disponible", () => {
  assert.equal(hasAccount({ id: "opencode-go", source: "api" }), true)
  assert.deepEqual(chooseAvailableModel([go], chatgpt), go)
  assert.deepEqual(chooseAvailableModel([chatgpt, go], go), go)
})
test("al quitar una cuenta usa la restante, respetando favoritos", () => {
  const other = { providerID: "openai", modelID: "gpt-favorite" }
  assert.deepEqual(chooseAvailableModel([chatgpt, other], go, ["openai/gpt-favorite"]), other)
})
test("sin cuentas no habilita modelos gratuitos del motor ni deja modelo obsoleto", () => {
  assert.equal(hasAccount({ id: "opencode", source: "custom", options: {} }), false)
  assert.equal(hasAccount({ id: "opencode", source: "custom", options: { apiKey: "public" } }), false)
  assert.deepEqual(chooseAvailableModel([], go), EMPTY_MODEL)
  assert.equal(modelAvailable([], go), false)
  assert.equal(hasAccount({ id: "unrelated", source: "api" }), false)
})
test("Zen con clave y cuentas configuradas por entorno siguen disponibles", () => {
  assert.equal(hasAccount({ id: "opencode", source: "config", options: { apiKey: "test" } }), true)
  assert.equal(hasAccount({ id: "opencode-go", source: "env" }), true)
})
