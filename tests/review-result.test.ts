import assert from "node:assert/strict"
import { test } from "node:test"
import { parseReview } from "../src/lib/reviewResult.ts"

test("malformed or missing review data never becomes a clean approval", () => {
  for (const text of ["all good", "{broken}", '{"summary":"ok"}', '{"summary":"ok","findings":null}', '{"summary":"","findings":[]}', '{"summary":"ok","findings":[null]}']) assert.throws(() => parseReview(text))
  assert.deepEqual(parseReview('```json\n{"summary":"No hay defectos confirmados","findings":[]}\n```'), { summary: "No hay defectos confirmados", findings: [] })
})
