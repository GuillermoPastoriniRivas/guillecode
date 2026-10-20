import { test } from "node:test"
import assert from "node:assert/strict"
import { readableProviderError, readableTeamError, isAccountLimitError } from "../src/lib/provider-error.ts"
import { providerErrorMessage, isRetryableProviderError } from "../src/lib/autoretry.ts"

test("el rechazo de modelos Zen exclusivos de OpenCode indica cambiar modelo", () => {
  const error = { name: "APIError", data: { isRetryable: false, statusCode: 403, message: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.", responseHeaders: { "set-cookie": "private" } } }
  for (const value of [error, JSON.stringify(error)]) {
    for (const human of [readableProviderError(value), readableTeamError(value)]) {
      assert.match(human, /restringido a la aplicación OpenCode.*Elegí otro modelo/)
      assert.doesNotMatch(human, /https:|private|responseHeaders/)
    }
  }
  assert.equal(isRetryableProviderError(error), false)
})

test("un error de cuota anidado no expone cuerpo, cabeceras ni tokens", () => {
  const error = { name: "APIError", data: { message: "HTTP 429", isRetryable: true, responseBody: JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached" } }), responseHeaders: { "set-cookie": "private-session", "x-codex-turn-state": "private-state" } } }
  for (const value of [error, JSON.stringify(error), new Error(JSON.stringify(error))]) {
    const text = readableProviderError(value)
    assert.match(text, /alcanzó su límite de uso/)
    assert.match(text, /Tus cambios se conservan/)
    assert.doesNotMatch(text, /private|responseBody|responseHeaders|HTTP|429/)
    assert.ok(text.length < 250)
  }
  assert.equal(isAccountLimitError(error), true)
  assert.equal(isRetryableProviderError(error), false, "compactar no recupera cuota")
  assert.equal(providerErrorMessage(error), readableProviderError(error))
})

test("errores desconocidos o JSON malformado producen texto breve y seguro", () => {
  for (const value of ['{"data":{"responseHeaders":', { data: { responseHeaders: { cookie: "private" } } }, { data: { message: "Authorization: Bearer private-token" } }]) {
    const text = readableProviderError(value)
    assert.match(text, /no pudo completar la respuesta/)
    assert.doesNotMatch(text, /private|responseHeaders|Bearer/)
  }
  assert.equal(readableProviderError("El modelo de Backend no está disponible"), "El modelo de Backend no está disponible")
  assert.ok(readableProviderError("x ".repeat(1000)).length < 250)
})

test("autenticación y modelo reciben instrucciones concretas", () => {
  assert.match(readableProviderError({ data: { responseBody: '{"error":{"code":"invalid_api_key"}}' } }), /volver a conectarse/)
  assert.match(readableProviderError({ data: { message: "model_not_found" } }), /Elegí otro modelo/)
  assert.match(readableProviderError({ data: { message: "The upstream request failed unexpectedly" } }), /proveedor de IA no pudo completar/i)
})

test("el HTTP 402 de OpenCode explica saldo o facturación sin revelar cabeceras", () => {
  const error = { data: { statusCode: 402, message: "The upstream request failed", responseHeaders: { "set-cookie": "private-session" } } }
  const text = readableTeamError(error)
  assert.match(text, /HTTP 402.*saldo o la facturación.*modelo con acceso disponible/)
  assert.doesNotMatch(text, /private-session|upstream|set-cookie/)
})

test("mensajes de equipos explican la causa y el siguiente paso sin mostrar errores crudos", () => {
  assert.match(readableTeamError("fatal: not a git repository (or any of the parent directories): .git"), /Git.*no tiene un repositorio Git.*no impide trabajar/i)
  assert.match(readableTeamError("Falta una comprobación satisfactoria observada para cada comando declarado."), /dio pruebas por aprobadas.*falta el registro.*repetir esa verificación/i)
  assert.match(readableTeamError("El plan debe contener entre 1 y 100 tareas"), /Lead.*plan de trabajo válido.*reintentá/i)
  assert.match(readableTeamError('{"error":{"code":"ECONNREFUSED","responseHeaders":{"authorization":"private"}}}'), /conexión|proveedor/i)
  assert.doesNotMatch(readableTeamError('{"error":{"code":"ECONNREFUSED","responseHeaders":{"authorization":"private"}}}'), /ECONNREFUSED|authorization|private/)
})
