import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { evaluate } from "./evaluate.ts"

// No inference is launched and no shell command from an input file is run.
const manifestPath = process.argv[2]
if (!manifestPath) throw new Error("Usage: npm run benchmark:plan-v2:results -- manifest.json (see benchmarks/plan-v2/README.md)")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.samples)) throw new Error("Unsupported results manifest")
const corpusText = await readFile(new URL("./corpus.json", import.meta.url))
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
if (manifest.corpusSha256 !== hash(corpusText)) throw new Error("Results must refer to this exact corpus SHA-256")
const corpus = JSON.parse(corpusText)
const baseline = JSON.parse(await readFile(new URL("./baseline.json", import.meta.url)))
const base = dirname(resolve(manifestPath))
const samples = new Map()
for (const sample of manifest.samples) {
  const spec = corpus.cases.find(c => c.id === sample.caseId)
  const key = `${sample.caseId}:${sample.arm}`
  if (!spec || !["a", "b", "c", "d"].includes(sample.arm) || samples.has(key)) throw new Error(`Unknown or duplicate sample ${key}`)
  const controls = sample.controls
  if (!["model", "toolsSha256", "fixtureSha256", "runtimeVersion", "commit"].every(k => typeof controls?.[k] === "string" && controls[k].length > 0)) throw new Error(`Missing controls ${key}`)
  if (![controls.toolsSha256, controls.fixtureSha256].every(value => /^[a-f0-9]{64}$/i.test(value))) throw new Error(`Invalid control hash ${key}`)
  if (sample.arm === "a" && controls.commit !== baseline.commit) throw new Error(`Baseline commit mismatch ${key}`)
  const bytes = await readFile(resolve(base, sample.runPath))
  const run = JSON.parse(bytes)
  if (run.goal !== spec.goal) throw new Error(`Objective mismatch ${key}`)
  if (sample.arm === "a" && run.planV2?.enabled) throw new Error(`Baseline has V2 enabled ${key}`)
  if ((sample.arm === "b" || sample.arm === "c") && !run.planV2?.enabled) throw new Error(`V2 is disabled ${key}`)
  if (sample.arm === "b" && run.team.planV2?.routing?.enabled) throw new Error(`Manual control has routing enabled ${key}`)
  if (sample.arm === "c" && !run.team.planV2?.routing?.enabled) throw new Error(`Routing is disabled ${key}`)
  let verdict = null
  if (sample.verdictPath) {
    verdict = JSON.parse(await readFile(resolve(base, sample.verdictPath)))
    if (verdict.caseId !== sample.caseId || verdict.runSha256 !== hash(bytes)) throw new Error(`Independent verdict is not bound to this run ${key}`)
    if (typeof verdict.objectivePassed !== "boolean" || typeof verdict.evaluator !== "string" || !verdict.evaluator.trim() || !Array.isArray(verdict.requirements)
      || verdict.requirements.some(r => typeof r.id !== "string" || typeof r.passed !== "boolean" || typeof r.evidence !== "string")
      || new Set(verdict.requirements.map(r => r.id)).size !== verdict.requirements.length
      || [verdict.scopeViolations, verdict.duplicateEffects].some(n => n !== null && (!Number.isInteger(n) || n < 0))) throw new Error(`Invalid verdict ${key}`)
  }
  samples.set(key, { caseId: sample.caseId, arm: sample.arm, controls, metrics: {
    ...evaluate(run, spec.agreedRequirementIds, verdict),
    wallTimeMs: Number.isFinite(sample.wallTimeMs) && sample.wallTimeMs >= 0 ? sample.wallTimeMs : null,
    humanInterventions: Array.isArray(sample.humanInterventions) ? sample.humanInterventions.filter(i => i.kind !== "final_manual_qa").length : null,
  } })
}
for (const spec of corpus.cases) {
  const a = samples.get(`${spec.id}:a`), b = samples.get(`${spec.id}:b`), c = samples.get(`${spec.id}:c`)
  if (a && b && ["model", "toolsSha256", "fixtureSha256", "runtimeVersion"].some(k => a.controls[k] !== b.controls[k])) throw new Error(`Unpaired A/B controls ${spec.id}`)
  if (b && c && ["toolsSha256", "fixtureSha256", "runtimeVersion"].some(k => b.controls[k] !== c.controls[k])) throw new Error(`Unpaired B/C controls ${spec.id}`)
  const d = samples.get(`${spec.id}:d`)
  if (b && d && ["model", "toolsSha256", "fixtureSha256"].some(k => b.controls[k] !== d.controls[k])) throw new Error(`Unpaired B/D controls ${spec.id}`)
}
const report = { schemaVersion: 1, corpusSha256: hash(corpusText), scope: "exported-runs-with-independent-verdicts", samples: [...samples.values()], complete: corpus.cases.every(c => ["a", "b", "c"].every(arm => samples.get(`${c.id}:${arm}`)?.metrics.objectiveVerified != null)) }
const table = ["| Arm | Samples / 30 | Objective verified / observed | Unknown objectives | Known cost USD |", "| --- | ---: | ---: | ---: | ---: |"]
for (const arm of ["a", "b", "c", "d"]) {
  const rows = report.samples.filter(r => r.arm === arm), observed = rows.filter(r => r.metrics.objectiveVerified !== null)
  table.push(`| ${arm.toUpperCase()} | ${rows.length} | ${observed.filter(r => r.metrics.objectiveVerified).length}/${observed.length} | ${rows.length - observed.length} | ${rows.length && rows.every(r => r.metrics.costUsd !== null) ? rows.reduce((n, r) => n + r.metrics.costUsd, 0).toFixed(4) : "unknown"} |`)
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), out = process.argv[3] ? resolve(process.argv[3]) : resolve(root, "test-results/benchmarks")
await mkdir(out, { recursive: true })
await writeFile(resolve(out, "quality-comparison.json"), JSON.stringify(report, null, 2))
await writeFile(resolve(out, "quality-comparison.md"), `${table.join("\n")}\n\nComplete paired corpus: ${report.complete}. Missing independent evaluation stays unknown. No rates are extrapolated to missing tasks.\n`)
console.log(table.join("\n"))
console.log(`Complete paired corpus: ${report.complete}`)
