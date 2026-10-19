import { test } from "node:test"
import assert from "node:assert/strict"
// @ts-expect-error Node runs this .mjs module without a declaration file.
import { makeManifest, validVersion, compareVersions, selectInstaller, assertOfficialUpdateSource, assertOfficialReleaseRepository } from "../scripts/release.mjs"

test("releases estables ordenan versiones numéricamente y rechazan entradas ambiguas", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1)
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0)
  for (const v of ["v1.0.0", "1.0.0-beta", "01.0.0", "1.0", "1.0.0;evil"]) assert.throws(() => validVersion(v))
})

test("release selects its exact product/version and never an old or QA installer", () => {
  assert.equal(selectInstaller(["guillecode_0.14.0_x64-setup.exe", "guillecode-upgrade-test_0.14.1_x64-setup.exe", "guillecode_0.14.1_x64-setup.exe"], "0.14.1", "guillecode"), "guillecode_0.14.1_x64-setup.exe")
  assert.throws(() => selectInstaller(["guillecode-upgrade-test_0.14.1_x64-setup.exe"], "0.14.1", "guillecode"))
  assert.throws(() => selectInstaller(["guillecode_0.14.1_x64-setup.exe", "guillecode_0.14.1_arm64-setup.exe"], "0.14.1", "guillecode"))
})
test("manifiesto apunta a la release inmutable y contiene la firma, no su URL", () => {
  const manifest = makeManifest("0.3.0", "Mejoras", "guillecode_0.3.0_x64-setup.exe", "YWJjZA==\n")
  assert.equal(manifest.platforms["windows-x86_64"].signature, "YWJjZA==")
  assert.equal(manifest.platforms["windows-x86_64"].url, "https://github.com/GuillermoPastoriniRivas/guillecode/releases/download/v0.3.0/guillecode_0.3.0_x64-setup.exe")
  assert.throws(() => makeManifest("0.3.0", "", "app.exe", "YWJjZA=="))
  assert.throws(() => makeManifest("0.3.0", "Mejoras", "app.exe", "https://example.test/app.sig"))
  assert.throws(() => makeManifest("0.3.0", "Mejoras", "app.exe", "YWJjZA==", "Kaitach/guillecode"), /solo pueden publicarse/)
  assert.throws(() => assertOfficialUpdateSource("GuillermoPastoriniRivas/guillecode", ["https://github.com/Kaitach/guillecode/releases/latest/download/latest.json"]), /solo pueden publicarse/)
  assert.throws(() => assertOfficialUpdateSource("GuillermoPastoriniRivas/guillecode", ["https://github.com/GuillermoPastoriniRivas/guillecode/releases/latest/download/latest.json", "https://github.com/Kaitach/guillecode/releases/latest/download/latest.json"]), /solo pueden publicarse/)
  assertOfficialReleaseRepository("GuillermoPastoriniRivas/guillecode")
  assert.throws(() => assertOfficialReleaseRepository("Kaitach/guillecode"), /solo se pueden preparar y publicar/)
  assert.throws(() => assertOfficialUpdateSource("GuillermoPastoriniRivas/guillecode", ["https://github.com/GuillermoPastoriniRivas/guillecode/releases/latest/download/latest.json"], "fork-signing-key"), /clave de firma oficial/)
})
