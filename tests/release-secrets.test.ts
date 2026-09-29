import { test } from "node:test"
import assert from "node:assert/strict"
import { build, loadEnv } from "vite"

test("release elimina credenciales de desarrollo y rechaza una fuga nueva", async () => {
  const env = loadEnv("production", process.cwd(), "VITE_")
  // A real username can coincide with engine names in the JS; use a unique sentinel.
  const previousUser = process.env.VITE_OPENCODE_USER
  const sentinelUser = "release-test-unique-development-user-918273"
  process.env.VITE_OPENCODE_USER = sentinelUser
  try {
    const output = await build({ logLevel: "silent", build: { write: false } })
    const chunks = (Array.isArray(output) ? output : [output]).flatMap((r) => "output" in r ? r.output : [])
    for (const value of [env.VITE_OPENCODE_PASSWORD, sentinelUser].filter(Boolean)) {
      assert.equal(chunks.some((chunk) => chunk.type === "chunk" && chunk.code.includes(value)), false, "Development credentials must not be embedded")
    }
  } finally {
    if (previousUser === undefined) delete process.env.VITE_OPENCODE_USER
    else process.env.VITE_OPENCODE_USER = previousUser
  }
  const name = "VITE_RELEASE_TEST_SECRET"
  process.env[name] = "test-secret-never-distribute-123456"
  try {
    await assert.rejects(() => build({
      logLevel: "silent", build: { write: false },
      plugins: [{ name: "simulate-secret-regression", renderChunk(code) { return `${code}\nconsole.log(${JSON.stringify(process.env[name])});` } }],
    }), /El release contiene VITE_RELEASE_TEST_SECRET/)
  } finally {
    delete process.env[name]
  }
})
