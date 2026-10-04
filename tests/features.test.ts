import { test } from "node:test"
import assert from "node:assert/strict"
import { changeCount, slugify } from "../src/lib/featureText.ts"

test("el slug de la feature es ascii, corto y sin guiones sueltos", () => {
  assert.equal(slugify("Autenticación con Google"), "autenticacion-con-google")
  assert.equal(slugify("  Reportes / Q4!! "), "reportes-q4")
  assert.equal(slugify("¿¿??"), "feature")
  assert.ok(slugify("x".repeat(90)).length <= 40)
  assert.equal(slugify(`${"a".repeat(39)} b`), "a".repeat(39))
})

test("los cambios cuentan stage, sin stage, nuevos y conflictos", () => {
  assert.equal(changeCount(null), 0)
  assert.equal(changeCount({ staged: 1, unstaged: 2, untracked: 3, conflicts: 1 }), 7)
})
