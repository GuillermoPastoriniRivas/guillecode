import assert from "node:assert/strict"
import { test } from "node:test"
// @ts-expect-error Node executes the release helper directly.
import { canonicalBinaryHash } from "../scripts/binary-validation.mjs"
test("NSIS marker is the only binary difference accepted by installation verification", () => {
  const built = Buffer.from("MZ-real-code-URI_BUNDLE_TYPE_VAR_UNK-data")
  assert.equal(canonicalBinaryHash(built), canonicalBinaryHash(Buffer.from("MZ-real-code-URI_BUNDLE_TYPE_VAR_NSS-data")))
  assert.notEqual(canonicalBinaryHash(built), canonicalBinaryHash(Buffer.from("MZ-other-code-URI_BUNDLE_TYPE_VAR_NSS-data")))
  assert.throws(() => canonicalBinaryHash(Buffer.from("MZ-no-marker")))
  assert.throws(() => canonicalBinaryHash(Buffer.from("URI_BUNDLE_TYPE_VAR_UNK-URI_BUNDLE_TYPE_VAR_NSS")))
})
