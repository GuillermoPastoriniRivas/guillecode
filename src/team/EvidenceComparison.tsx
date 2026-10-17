import { useEffect, useRef, useState } from "react"
import { call, errorMessage } from "../lib/tauri"
import type { Observation, TeamRun } from "./types"
import { formatDateTime } from "../lib/time"

function useCapture(runId: string, observation: Observation | undefined): { url?: string; error?: string } {
  const key = `${runId}:${observation?.id}:${observation?.artifactPath}:${observation?.status}`
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>({ key: "" })
  useEffect(() => {
    let disposed = false
    if (observation?.status !== "captured" || !observation.artifactPath) return
    void call<{ mime: string; data: string }>("team_evidence_image", { runId, path: observation.artifactPath }).then((r) => {
      if (!disposed) setState({ key, url: `data:${r.mime};base64,${r.data}` })
    }).catch((e) => { if (!disposed) setState({ key, error: errorMessage(e) }) })
    return () => { disposed = true }
  }, [key, runId, observation?.id, observation?.artifactPath, observation?.status])
  return state.key === key ? state : {}
}

function Missing({ observation }: { observation?: Observation }) {
  return <p className="team-note">{observation?.status === "captured" ? "Cargando captura verificada…" : observation?.details.reason ?? "No existe una captura verificada de este estado. Consultá el reporte de ausencia."}</p>
}

function ImagePreview({ url, label, close }: { url: string; label: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog ref={ref} className="team-image-dialog" aria-label={label} onClose={close}>
    <div className="team-section-title"><strong>{label}</strong><button className="btn btn-sm" onClick={() => ref.current?.close()}>Cerrar imagen</button></div>
    <img src={url} alt={label} />
  </dialog>
}

function Pair({ run, baseline, before, after }: { run: TeamRun; baseline: TeamRun; before?: Observation; after?: Observation }) {
  const first = useCapture(baseline.id, before)
  const second = useCapture(run.id, after)
  const [mode, setMode] = useState("side")
  const [position, setPosition] = useState(50)
  const [preview, setPreview] = useState<{url: string; label: string} | null>(null)
  const comparable = !!first.url && !!second.url && before?.details.width === after?.details.width && before?.details.height === after?.details.height
  return <div className="team-comparison">
    <div className="team-actions"><button className={`btn btn-xs ${mode === "side" ? "btn-primary" : ""}`} onClick={() => setMode("side")}>Lado a lado</button><button className={`btn btn-xs ${mode === "slide" ? "btn-primary" : ""}`} disabled={!comparable} onClick={() => setMode("slide")}>Deslizar antes / después</button></div>
    {mode === "slide" && comparable ? <>
      <div className="team-image-overlay" style={{ aspectRatio: `${after?.details.width}/${after?.details.height}` }}>
        <img src={first.url} alt="Antes del cambio" />
        <img src={second.url} alt="Después del cambio" style={{ clipPath: `inset(0 0 0 ${position}%)` }} />
        <span className="team-image-divider" style={{ left: `${position}%` }} />
      </div>
      <label>Posición del comparador<input aria-label="Posición antes y después" type="range" min={0} max={100} value={position} onChange={(e) => setPosition(Number(e.target.value))} /></label>
    </> : <div className="team-image-pair">
      <figure><figcaption>Antes{before ? ` · ${formatDateTime(before.capturedAt)}` : ""}</figcaption>{first.url ? <button className="team-image-open" aria-label="Ampliar antes" onClick={() => setPreview({ url: first.url!, label: "Antes del cambio ampliado" })}><img src={first.url} alt="Antes del cambio" /></button> : first.error ? <p role="alert" className="team-error">{first.error}</p> : <Missing observation={before} />}</figure>
      <figure><figcaption>Después{after ? ` · ${formatDateTime(after.capturedAt)}` : ""}</figcaption>{second.url ? <button className="team-image-open" aria-label="Ampliar después" onClick={() => setPreview({ url: second.url!, label: "Después del cambio ampliado" })}><img src={second.url} alt="Después del cambio" /></button> : second.error ? <p role="alert" className="team-error">{second.error}</p> : <Missing observation={after} />}</figure>
    </div>}
    <p className="team-note">{after?.details.width ?? before?.details.width} × {after?.details.height ?? before?.details.height} · {after?.details.source ?? before?.details.source ?? "Sin fuente visual disponible"}</p>
    {after?.details.steps?.length ? <details><summary>Pasos realmente ejecutados</summary><ol>{after.details.steps.map((s, i) => <li key={i}>{s.kind} · {s.selector} · {s.status}</li>)}</ol></details> : null}
    {before?.sha256 && after?.sha256 && <p className="team-note">{before.sha256 === after.sha256 ? "Las capturas son idénticas. La ausencia de diferencia visual no prueba por sí sola que la función esté verificada." : "Imágenes distintas; revisá el comportamiento y las comprobaciones registradas."}</p>}
    {preview && <ImagePreview {...preview} close={() => setPreview(null)} />}
  </div>
}

export function EvidenceComparison({ run, history }: { run: TeamRun; history: TeamRun[] }) {
  const targets = run.captureTargets ?? []
  const [selected, setSelected] = useState(targets[0]?.id ?? "")
  const [baselineId, setBaselineId] = useState(run.id)
  const baseline = history.find((r) => r.id === baselineId) ?? run
  const target = targets.find((t) => t.id === selected) ?? targets[0]
  if (!target) return null
  const before = baseline.observations?.filter((o) => o.targetId === target.id && o.phase === (baseline.id === run.id ? "before" : "after")).at(-1)
  const after = run.observations?.filter((o) => o.targetId === target.id && o.phase === "after").at(-1)
  const previous = history.filter((r) => r.startedAt < run.startedAt && r.observations?.some((o) => o.phase === "after"))
  return <section className="team-card" aria-label="Comparador de evidencias">
    <h3>Antes / Después</h3>
    <label>Flujo capturado<select aria-label="Flujo capturado" value={target.id} onChange={(e) => setSelected(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    <label>Comparar contra<select aria-label="Comparar contra" value={baseline.id} onChange={(e) => setBaselineId(e.target.value)}><option value={run.id}>Estado anterior a esta ejecución</option>{previous.map((r, i) => <option key={r.id} value={r.id}>Entrega anterior {i + 1} · {formatDateTime(r.startedAt)}</option>)}</select></label>
    <p className="team-note selectable">{target.url}</p>
    <Pair key={`${baseline.id}-${run.id}-${target.id}-${before?.id}-${after?.id}`} run={run} baseline={baseline} before={before} after={after} />
  </section>
}
