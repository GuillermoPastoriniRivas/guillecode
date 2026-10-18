import { test } from "node:test"
import assert from "node:assert/strict"
import { readableProviderError, isAccountLimitError } from "../src/lib/provider-error.ts"
import { providerErrorMessage, isRetryableProviderError } from "../src/lib/autoretry.ts"

test("un error de cuota anidado no expone cuerpo, cabeceras ni tokens", () => {
  const error = { name: "APIError", data: { message: "HTTP 429", isRetryable: true, responseBody: JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached" } }), responseHeaders: { "set-cookie": "private-session", "x-codex-turn-state": "private-state" } } }
  for (const value of [error, JSON.stringify(error), new Error(JSON.stringify(error))]) {
    const text = readableProviderError(value)
    assert.match(text, /límite de uso de tu cuenta/)
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
    assert.match(text, /No se pudo completar/)
    assert.doesNotMatch(text, /private|responseHeaders|Bearer/)
  }
  assert.equal(readableProviderError("El modelo de Backend no está disponible"), "El modelo de Backend no está disponible")
  assert.equal(readableProviderError("x ".repeat(1000)).length, 400)
})

test("autenticación y modelo reciben instrucciones concretas", () => {
  assert.match(readableProviderError({ data: { responseBody: '{"error":{"code":"invalid_api_key"}}' } }), /volver a conectarse/)
  assert.match(readableProviderError({ data: { message: "model_not_found" } }), /Elegí otro modelo/)
})
