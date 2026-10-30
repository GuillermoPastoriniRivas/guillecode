import { spawnSync } from "node:child_process"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { resolve, dirname } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const output = resolve(root, "test-results/benchmarks")
const baseline = JSON.parse(await readFile(resolve(root, "benchmarks/plan-v2/baseline.json"), "utf8"))
const excerpts = (await readFile(resolve(root, "benchmarks/plan-v2/baseline.rs"), "utf8")).replace(/\r\n/g, "\n").split("\n").slice(1).join("\n")
const hash = text => createHash("sha256").update(text).digest("hex")
if (hash(excerpts) !== baseline.excerptsSha256) throw new Error("Pinned baseline excerpts changed; regenerate provenance explicitly.")
await mkdir(output, { recursive: true })
const result = spawnSync("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--release", "--lib", "teams::benchmarks::compare_planners", "--", "--ignored", "--nocapture"], {
  cwd: root, env: { ...process.env, FLUFY_BENCHMARK_REPORT: resolve(output, "plan-v2.json") }, windowsHide: true, stdio: "inherit",
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const report = JSON.parse(await readFile(resolve(output, "plan-v2.json"), "utf8"))
const corpus = JSON.parse(await readFile(resolve(root, "benchmarks/plan-v2/corpus.json"), "utf8"))
if (hash(await readFile(resolve(root, "benchmarks/plan-v2/corpus.json"))) !== report.corpusSha256) throw new Error("Corpus/report mismatch")
const rows = report.cases
if (rows.length !== 30 || rows.length !== corpus.cases.length) throw new Error("Incomplete corpus")
const count = predicate => rows.filter(predicate).length
const line = (label, predicate) => `| ${label} | ${["a", "b", "c"].map(key => count(row => predicate(row, row[key]))).join(" | ")} |`
const markdown = `# Flufy Plan V2: paired admission and routing benchmark

Baseline: ${baseline.commit}. Corpus SHA-256: ${report.corpusSha256}.

30 final proposals: 10 valid contracts, 20 malformed or semantically invalid contracts. Every arm sees identical proposals, permissions and catalog. The catalog deliberately lacks the manually assigned model and includes a compatible configured alternative. The old admission/fallback excerpts are pinned and hash-checked. Assignment DTOs are adapted to the current unchanged assignment validator.

| Observed count | A: v0.17.0 admission | B: V2/manual | C: V2/routing |
| --- | ---: | ---: | ---: |
${line("Valid plans admitted / 10", (row, arm) => row.expectedValid && arm.admitted)}
${line("Invalid plans admitted / 20 (lower is better)", (row, arm) => !row.expectedValid && arm.admitted)}
${line("Generic fallback substitutions / 30 (lower is better)", (_row, arm) => arm.genericFallback)}
${line("Valid plans with compatible selected model / 10", (row, arm) => row.expectedValid && !!arm.route)}

These measurements cover the final admission boundary after repair opportunities and pre-session routing. They do not execute 30 software tasks, sample model inference, measure live quota, or establish superiority over CodeAF/OMH. Objective verification, token cost and human interventions are unknown (null), never zero. durationNanos in the JSON is local processing time, not model latency. Native scheduler, real OpenCode tool execution and crash recovery have separate integration tests.

Run: npm run benchmark:plan-v2. Machine-readable report: test-results/benchmarks/plan-v2.json.
`
await writeFile(resolve(output, "plan-v2.md"), markdown)
console.log(markdown)
