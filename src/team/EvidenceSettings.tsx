import type { CaptureTarget, Team } from "./types"

export function EvidenceSettings({ team, update }: { team: Team; update: (patch: Partial<Team>) => void }) {
  const targets = team.evidenceTargets ?? []
  const patch = (id: string, fields: Partial<CaptureTarget>) => update({ evidenceTargets: targets.map((t) => t.id === id ? { ...t, ...fields } : t) })
  const limit = (name: keyof NonNullable<Team["limits"]>, value: string) => update({ limits: { ...team.limits, [name]: value === "" ? null : Number(value) } })
  return <>
    <section className="team-card">
      <div className="team-section-title"><h3>Capturas reales antes / después</h3><button className="btn btn-sm" onClick={() => update({ evidenceTargets: [...targets, { id: crypto.randomUUID(), name: `Flujo ${targets.length + 1}`, url: "http://localhost:5173/", width: 1280, height: 800, maskSelectors: [], actions: [], required: false }] })}>Agregar flujo visual</button></div>
      <p className="team-note">Se abre una sesión aislada de Chrome o Edge, sin cookies de tu perfil. Usá URLs locales y datos de prueba. Si dejás la lista vacía, el Lead puede descubrir flujos en el proyecto. Los campos de formularios y los elementos privados se ocultan antes de capturar.</p>
      {targets.map((t) => <div key={t.id} className="team-card">
        <div className="team-form-grid"><label>Nombre del flujo<input value={t.name} onChange={(e) => patch(t.id, { name: e.target.value })} /></label><label>URL local del flujo<input type="url" value={t.url} onChange={(e) => patch(t.id, { url: e.target.value })} /></label></div>
        <div className="team-form-grid"><label>Ancho de captura<input type="number" min={320} max={2560} value={t.width} onChange={(e) => patch(t.id, { width: Number(e.target.value) })} /></label><label>Alto de captura<input type="number" min={240} max={1600} value={t.height} onChange={(e) => patch(t.id, { height: Number(e.target.value) })} /></label></div>
        <label>Esperar elemento de la página (selector CSS, opcional)<input value={t.waitForSelector ?? ""} onChange={(e) => patch(t.id, { waitForSelector: e.target.value || null })} /></label>
        <label>Ocultar elementos privados (un selector por línea)<textarea rows={2} value={t.maskSelectors.join("\n")} onChange={(e) => patch(t.id, { maskSelectors: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} /></label>
        <label className="team-check"><input type="checkbox" checked={t.required} onChange={(e) => patch(t.id, { required: e.target.checked })} /> Exigir captura final para entregar</label>
        <h4>Pasos del flujo</h4>
        {t.actions.map((a, i) => <div key={i} className="team-form-grid"><label>Acción<select aria-label={`Acción ${i + 1}`} value={a.kind} onChange={(e) => patch(t.id, { actions: t.actions.map((v, n) => n === i ? { ...v, kind: e.target.value as typeof a.kind } : v) })}><option value="click">Clic</option><option value="fill">Completar campo</option><option value="wait">Esperar elemento</option></select></label><label>Selector del paso<input value={a.selector} onChange={(e) => patch(t.id, { actions: t.actions.map((v, n) => n === i ? { ...v, selector: e.target.value } : v) })} /></label>{a.kind === "fill" && <label>Dato de prueba<input value={a.value ?? ""} onChange={(e) => patch(t.id, { actions: t.actions.map((v, n) => n === i ? { ...v, value: e.target.value } : v) })} /></label>}<button className="btn btn-xs" onClick={() => patch(t.id, { actions: t.actions.filter((_, n) => n !== i) })}>Quitar paso</button></div>)}
        <div className="team-actions"><button className="btn btn-xs" onClick={() => patch(t.id, { actions: [...t.actions, { kind: "wait", selector: "main" }] })}>Agregar paso</button><button className="btn btn-xs" onClick={() => update({ evidenceTargets: targets.filter((v) => v.id !== t.id) })}>Quitar flujo</button></div>
      </div>)}
    </section>
    <section className="team-card"><h3>Límites opcionales</h3><p className="team-note">Dejá vacío lo que no quieras limitar. El uso se obtiene del motor; algunos proveedores no informan costo. El tiempo incluye pausas y cierres. La retención conserva las entregas pendientes de QA.</p><div className="team-form-grid">
      <label>Duración máxima (minutos)<input type="number" min={1} max={1440} value={team.limits?.maxRunMinutes ?? ""} onChange={(e) => limit("maxRunMinutes", e.target.value)} /></label>
      <label>Presupuesto USD<input type="number" min={0.01} step={0.01} value={team.limits?.maxCostUsd ?? ""} onChange={(e) => limit("maxCostUsd", e.target.value)} /></label>
      <label>Límite de tokens<input type="number" min={1} value={team.limits?.maxTokens ?? ""} onChange={(e) => limit("maxTokens", e.target.value)} /></label>
      <label>Retener evidencias (días)<input type="number" min={1} max={3650} value={team.limits?.retentionDays ?? ""} onChange={(e) => limit("retentionDays", e.target.value)} /></label>
    </div></section>
  </>
}
