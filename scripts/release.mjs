import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const config = JSON.parse(readFileSync(join(root, "scripts/release-config.json"), "utf8"))
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"))
const writeJson = (path, data) => writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`)
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim()
export const sha256 = (data) => createHash("sha256").update(data).digest("hex")
export function validVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.split(".").some((v) => String(Number(v)) !== v)) throw new Error("Usá una versión estable X.Y.Z, sin v ni prerelease")
  return version
}
export function compareVersions(a, b) {
  const left = validVersion(a).split(".").map(Number), right = validVersion(b).split(".").map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i])
  return 0
}
export function makeManifest(version, notes, installerName, signature, repository = config.repository) {
  validVersion(version)
  if (!notes.trim()) throw new Error("Escribí las novedades de esta versión")
  if (!/^[A-Za-z0-9+/=]+$/.test(signature.trim())) throw new Error("Firma de updater inválida")
  return { version, notes: notes.trim(), pub_date: new Date().toISOString(), platforms: {
    "windows-x86_64": { url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(installerName)}`, signature: signature.trim() },
  } }
}

function stamp(version) {
  validVersion(version)
  for (const path of ["package.json", "src-tauri/tauri.conf.json"]) {
    const data = json(path); data.version = version; writeJson(path, data)
  }
  const lock = json("package-lock.json"); lock.version = version; lock.packages[""].version = version; writeJson("package-lock.json", lock)
  const path = join(root, "src-tauri/Cargo.toml")
  writeFileSync(path, readFileSync(path, "utf8").replace(/^(version = ")[^"]+("\r?)$/m, `$1${version}$2`))
  const cargoLock = join(root, "src-tauri/Cargo.lock")
  writeFileSync(cargoLock, readFileSync(cargoLock, "utf8").replace(/(\[\[package\]\]\r?\nname = "app"\r?\nversion = ")[^"]+"/, `$1${version}"`))
}

function check() {
  const version = validVersion(json("package.json").version)
  const versions = [json("src-tauri/tauri.conf.json").version, json("package-lock.json").version, json("package-lock.json").packages[""].version,
    readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1],
    readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8").match(/\[\[package\]\]\r?\nname = "app"\r?\nversion = "([^"]+)"/)?.[1]]
  if (versions.some((v) => v !== version)) throw new Error(`Versiones inconsistentes: ${[version, ...versions].join(", ")}`)
  const tauri = json("src-tauri/tauri.conf.json")
  if (!tauri.bundle.createUpdaterArtifacts || !tauri.plugins.updater.pubkey || tauri.plugins.updater.endpoints.some((url) => !url.startsWith("https://"))) throw new Error("Updater incompleto o endpoint sin HTTPS")
  if (tauri.plugins.updater.dangerousInsecureTransportProtocol || tauri.plugins.updater.dangerousAcceptInvalidCerts) throw new Error("La release no puede habilitar transporte inseguro")
  console.log(`Release ${version}: versiones y configuración coherentes`)
  return version
}

async function engine() {
  if (process.platform !== "win32") throw new Error("El motor de esta release es Windows x64")
  const dir = mkdtempSync(join(tmpdir(), "guillecode-engine-"))
  try {
    const response = await fetch(config.engineUrl, { signal: AbortSignal.timeout(10 * 60_000) })
    if (!response.ok) throw new Error(`Descarga del motor: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (sha256(bytes) !== config.engineSha256) throw new Error("El motor descargado no coincide con el SHA256 fijado")
    const archive = join(dir, "engine.zip"), extracted = join(dir, "extracted")
    writeFileSync(archive, bytes)
    // Pass paths as environment variables rather than interpolating PowerShell code.
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $env:GC_ENGINE_ZIP -DestinationPath $env:GC_ENGINE_DIR"], {
      env: { ...process.env, GC_ENGINE_ZIP: archive, GC_ENGINE_DIR: extracted }, stdio: "inherit",
    })
    const findExe = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? findExe(join(dir, e.name)) : e.name === "opencode.exe" ? [join(dir, e.name)] : [])
    const files = findExe(extracted)
    if (files.length !== 1) throw new Error("El archivo del motor no contiene exactamente un opencode.exe")
    const dest = join(root, "src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe")
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(files[0]))
    const version = run(dest, ["--version"])
    if (version !== config.engineVersion) throw new Error(`Versión del motor inesperada: ${version}`)
    console.log(`OpenCode ${version}: descargado y SHA256 verificado`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

function manifest(bundle = "src-tauri/target/release/bundle/nsis", notesFile = process.env.GC_RELEASE_NOTES_FILE) {
  const version = check()
  if (!notesFile) throw new Error("Indicá el archivo de novedades como segundo argumento o GC_RELEASE_NOTES_FILE")
  const dir = resolve(root, bundle)
  const installers = readdirSync(dir).filter((name) => name.endsWith("-setup.exe"))
  if (installers.length !== 1) throw new Error("El bundle debe contener exactamente un instalador NSIS; limpiá los bundles viejos")
  const name = installers[0], bytes = readFileSync(join(dir, name))
  const latest = makeManifest(version, readFileSync(notesFile, "utf8"), name, readFileSync(join(dir, `${name}.sig`), "utf8"))
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`)
  writeFileSync(join(dir, "release-info.json"), `${JSON.stringify({ version, commit: run("git", ["rev-parse", "HEAD"]), engineVersion: config.engineVersion, installer: name, sha256: sha256(bytes) }, null, 2)}\n`)
  console.log(`Generado latest.json para ${version}; SHA256 ${sha256(bytes)}`)
}

function prepare(version, notesFile) {
  validVersion(version)
  if (!notesFile) throw new Error("Uso: npm run release:prepare -- X.Y.Z archivo-de-novedades")
  const notes = readFileSync(resolve(notesFile), "utf8").trim()
  if (!notes) throw new Error("Las novedades no pueden estar vacías")
  if (run("git", ["status", "--porcelain"])) throw new Error("Guardá los cambios en git y subilos antes de preparar una release")
  const ref = run("git", ["rev-parse", "--abbrev-ref", "HEAD"])
  if (ref === "HEAD") throw new Error("Prepará desde una rama subida al repositorio")
  const commit = run("git", ["rev-parse", "HEAD"])
  const remote = run("gh", ["api", `repos/${config.repository}/commits/${encodeURIComponent(ref)}`, "--jq", ".sha"])
  if (commit !== remote) throw new Error("La rama local y GitHub no tienen el mismo commit")
  run("gh", ["workflow", "run", "prepare-release.yml", "--repo", config.repository, "--ref", ref, "-f", `version=${version}`, "-f", `notes=${notes}`])
  console.log(`Preparación solicitada: ${version} desde ${commit}. Se creará un borrador; nadie se actualiza todavía.`)
}

function publish(version, confirmed = false) {
  validVersion(version)
  if (!confirmed) throw new Error("Confirmá la prueba de actualización con --tested antes de publicar")
  const release = JSON.parse(run("gh", ["api", `repos/${config.repository}/releases/tags/v${version}`]))
  if (!release.draft || release.prerelease) throw new Error("Solo se puede promover un borrador estable")
  const releases = JSON.parse(run("gh", ["api", `repos/${config.repository}/releases?per_page=100`]))
  for (const r of releases.filter((r) => !r.draft && !r.prerelease)) {
    if (compareVersions(version, r.tag_name.replace(/^v/, "")) <= 0) throw new Error("La versión debe ser mayor que todas las estables publicadas")
  }
  const dir = mkdtempSync(join(tmpdir(), "guillecode-publish-"))
  try {
    run("gh", ["release", "download", `v${version}`, "--repo", config.repository, "--dir", dir])
    const info = JSON.parse(readFileSync(join(dir, "release-info.json"), "utf8"))
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"))
    const platform = latest.platforms["windows-x86_64"]
    if (info.version !== version || latest.version !== version || !/^[0-9a-f]{40}$/.test(info.commit)) throw new Error("Metadata de release inconsistente")
    if (platform.url !== `https://github.com/${config.repository}/releases/download/v${version}/${encodeURIComponent(info.installer)}`) throw new Error("El manifiesto no apunta al instalador de esta release")
    if (platform.signature !== readFileSync(join(dir, `${info.installer}.sig`), "utf8").trim()) throw new Error("Firma y manifiesto no coinciden")
    if (info.sha256 !== sha256(readFileSync(join(dir, info.installer)))) throw new Error("El instalador no coincide con su SHA256")
    run("gh", ["release", "edit", `v${version}`, "--repo", config.repository, "--draft=false", "--latest", "--prerelease=false"])
    console.log(`Publicada ${version}: las apps ya pueden detectarla.`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (command === "version") stamp(args[0])
    else if (command === "check") check()
    else if (command === "engine") await engine()
    else if (command === "manifest") manifest(...args)
    else if (command === "prepare") prepare(...args)
    else if (command === "publish") publish(args[0], args.includes("--tested"))
    else throw new Error("Comandos: version, check, engine, manifest, prepare, publish")
  } catch (e) { console.error(e.message); process.exitCode = 1 }
}
