import { test } from "node:test"
import assert from "node:assert/strict"
import { coalescedByKey } from "../src/lib/coalesced.ts"

test("hundreds of refresh requests share one active query and one trailing refresh", async () => {
  const releases: (() => void)[] = []
  let calls = 0
  let active = 0
  let peak = 0
  const refresh = coalescedByKey(async () => {
    calls++
    peak = Math.max(peak, ++active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
  })
  const first = refresh("repo")
  await Promise.resolve()
  for (let i = 0; i < 600; i++) assert.equal(refresh("repo"), first)
  assert.equal(calls, 1)
  releases.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  releases.shift()!()
  await first
  assert.equal(peak, 1)
})

test("a failed refresh releases its slot and independent projects can run", async () => {
  const refresh = coalescedByKey(async (key) => { if (key === "bad") throw new Error("failed") })
  await Promise.all([assert.rejects(refresh("bad")), refresh("other")])
  await assert.rejects(refresh("bad"))
})
