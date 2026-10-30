import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { evaluate, type Verdict } from "../benchmarks/plan-v2/evaluate.ts"
import type { TeamRun } from "../src/team/types.ts"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const run = (): TeamRun => ({ team: { planV2: { enabled: true, routing: { enabled: false } } }, planV2: { enabled: true, revisions: [] }, tasks: [{ id: "T1", status: "completed", expectedFiles: ["app.ts"], verificationPlan: [{ kind: "command", command: "node --test", expected: "pass" }], attempts: [{ id: "attempt", sessionId: "session", reviewSessionId: "review", finishedAt: 2, status: "completed", review: { status: "approved", criteriaSatisfied: true }, declaredChecks: ["node --test"], commands: [{ command: "node --test", exitCode: 0 }] }] }] } as unknown as TeamRun)
const verdict = (): Verdict => ({ caseId: "case", runSha256: "hash", evaluator: "Independent tests", objectivePassed: true, requirements: [{ id: "R1", passed: true, evidence: "Positive and negative tests" }], scopeViolations: null, duplicateEffects: null })

test("benchmark requiere recibos y evaluación independiente; métricas desconocidas siguen null", () => {
  const r = run()
  assert.equal(evaluate(r, ["R1"], null).objectiveVerified, null)
  const observed = evaluate(r, ["R1"], verdict())
  assert.equal(observed.objectiveVerified, true)
  assert.equal(observed.costUsd, null)
  assert.equal(observed.duplicateEffects, null)
  r.tasks[0].attempts[0].reviewSessionId = null
  assert.equal(evaluate(r, ["R1"], verdict()).objectiveVerified, false)
})
test("benchmark no acepta pérdida de requisitos, tests fallidos ni efectos duplicados", () => {
  assert.equal(evaluate(run(), ["R1", "R2"], verdict()).objectiveVerified, null)
  const v = verdict(); v.duplicateEffects = 1
  assert.equal(evaluate(run(), ["R1"], v).objectiveVerified, false)
  const r = run(); r.tasks[0].attempts[0].commands[0].exitCode = 1
  assert.equal(evaluate(r, ["R1"], verdict()).objectiveVerified, false)
})
test("importador comparativo rechaza A/B no pareados y veredictos de otra ejecución", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flufy-benchmark-import-"))
  try {
    const corpusBytes = await readFile(resolve("benchmarks/plan-v2/corpus.json"))
    const corpus = JSON.parse(corpusBytes.toString())
    const baseline = JSON.parse(await readFile(resolve("benchmarks/plan-v2/baseline.json"), "utf8"))
    const r = run(); r.goal = corpus.cases[0].goal
    const raw = JSON.stringify(r)
    await writeFile(join(directory, "run.json"), raw)
    const old = JSON.parse(raw); delete old.planV2; delete old.team.planV2
    const oldRaw = JSON.stringify(old)
    await writeFile(join(directory, "legacy.json"), oldRaw)
    const controls = { model: "same-model", toolsSha256: hash("tools"), fixtureSha256: hash("fixture"), runtimeVersion: "test-runtime", commit: baseline.commit }
    const manifest = { schemaVersion: 1, corpusSha256: hash(corpusBytes), samples: ["a", "b"].map(arm => ({ arm, caseId: corpus.cases[0].id, runPath: arm === "a" ? "legacy.json" : "run.json", controls: { ...controls }, verdictPath: arm === "a" ? "legacy-verdict.json" : "verdict.json" })) }
    const v = { ...verdict(), caseId: corpus.cases[0].id, runSha256: hash(raw) }
    await writeFile(join(directory, "verdict.json"), JSON.stringify(v))
    await writeFile(join(directory, "legacy-verdict.json"), JSON.stringify({ ...v, runSha256: hash(oldRaw) }))
    const execute = async () => {
      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest))
      return spawnSync(process.execPath, ["--experimental-strip-types", resolve("benchmarks/plan-v2/compare-runs.mjs"), join(directory, "manifest.json"), join(directory, "reports")], { encoding: "utf8", windowsHide: true })
    }
    assert.equal((await execute()).status, 0)
    const report = JSON.parse(await readFile(join(directory, "reports/quality-comparison.json"), "utf8"))
    assert.equal(report.complete, false)
    assert.equal(report.samples[0].metrics.humanInterventions, null)
    manifest.samples[1].controls.model = "different-model"
    assert.match((await execute()).stderr, /Unpaired A\/B controls/)
    manifest.samples[1].controls.model = "same-model"
    v.runSha256 = hash("different-run")
    await writeFile(join(directory, "verdict.json"), JSON.stringify(v))
    assert.match((await execute()).stderr, /not bound to this run/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(basename(directory).startsWith("flufy-benchmark-import-"))
    await rm(directory, { recursive: true, force: true })
  }
})
