import { useEffect, useMemo, useState } from "react"
import {
  changeCount,
  featuresCopyCandidates,
  featuresMerge,
  featuresMergePreview,
  slugify,
  type CopyCandidate,
  type Feature,
  type MergePreview,
} from "../lib/features"
import { gitBranches, type Branch } from "../lib/git"
import { joinPath, samePath } from "../lib/paths"
import { errorMessage } from "../lib/tauri"
import { timeAgo } from "../lib/time"
import { useProject } from "../state/project"
import {
  createFeature,
  featureTitle,
  findGroup,
  handleMergeResult,
  hasUnsavedIn,
  openFeatureCreate,
  openPullRequest,
  refreshFeatures,
  removeFeature,
  setArchived,
  suggestSetupCommand,
  switchToFeature,
  updateFromBase,
  useFeatures,
} from "../state/features"
import { removeTabs, tabId } from "../state/editors"
import { useAgent } from "../state/agent"
import { useLayout } from "../state/layout"
import { Select, Toggle } from "../components/fields"
import { Icon, Spinner } from "../components/ui"

function useLocalBranches(repo: string | null): Branch[] {
  const [branches, setBranches] = useState<Branch[]>([])
  useEffect(() => {
    if (!repo) return
    let alive = true
    gitBranches(repo)
      .then((list) => alive && setBranches(list))
      .catch(() => alive && setBranches([]))
    return () => {
      alive = false
    }
  }, [repo])
  return branches
}

export function FeatureCreateEditor({ repo }: { repo: string | null }) {
  const project = useProject((s) => s.project)
  const list = useFeatures((s) => s.list)
  const scope = repo || list?.project || project
  const group = findGroup(scope, list)
  const branches = useLocalBranches(group?.main || list?.repo || project)
  const [label, setLabel] = useState("")
  const [branch, setBranch] = useState("")
  const [branchTouched, setBranchTouched] = useState(false)
  const [base, setBase] = useState("")
  const [existing, setExisting] = useState(false)
  const [candidates, setCandidates] = useState<CopyCandidate[] | null>(null)
  const [copy, setCopy] = useState<string[]>([])
  const [setup, setSetup] = useState(() => findGroup(scope, useFeatures.getState().list)?.settings.setup ?? "")
  const [open, setOpen] = useState(true)
  const [prompt, setPrompt] = useState("")
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!scope) return
    let alive = true
    featuresCopyCandidates(scope)
      .then((found) => {
        if (!alive) return
        setCandidates(found)
        const saved = findGroup(scope, useFeatures.getState().list)?.settings.copy ?? []
        const initial = saved.length > 0 ? saved.filter((p) => found.some((c) => c.path === p)) : found.filter((c) => c.suggested).map((c) => c.path)
        setCopy(initial)
      })
      .catch(() => alive && setCandidates([]))
    if (!findGroup(scope, useFeatures.getState().list)?.settings.setup)
      void suggestSetupCommand(scope).then((s) => {
        if (alive && s) setSetup((current) => current || s)
      })
    return () => {
      alive = false
    }
  }, [scope])

  const locals = useMemo(() => branches.filter((b) => !b.remote), [branches])
  const defaultBase = group?.defaultBase ?? locals.find((b) => b.current)?.name ?? ""
  const effectiveBase = base || defaultBase
  const effectiveBranch = branchTouched ? branch : label.trim() ? `feature/${slugify(label)}` : ""
  const openElsewhere = list?.features.find((f) => f.branch === effectiveBranch && !!scope && samePath(f.repo || "", scope))
  const openInMain = !!list?.multi && !!effectiveBranch && group?.branch === effectiveBranch
  const branchExists = locals.some((b) => b.name === effectiveBranch)
  const folder = group?.worktreesDir && label.trim() ? joinPath(group.worktreesDir, slugify(label)) : ""
  const branchError = !effectiveBranch
    ? null
    : /\s|\.\.|[~^:?*[\\]|^-|\/$|\.lock$/.test(effectiveBranch)
      ? "Nombre inválido para git"
      : openElsewhere
        ? `Esa rama ya está abierta en «${featureTitle(openElsewhere)}»`
        : openInMain
          ? `Esa rama ya está abierta en la copia principal de ${group?.name}`
          : null

  const baseOptions = [
    ...locals.map((b) => ({ value: b.name, label: b.name, description: b.current ? "actual en la principal" : b.subject, icon: "git-branch" })),
    ...branches
      .filter((b) => b.remote && !locals.some((l) => b.name.endsWith(`/${l.name}`)))
      .map((b) => ({ value: b.name, label: b.name, description: b.subject, icon: "cloud" })),
  ]

  const canCreate =
    !!scope && !!group && !!label.trim() && !!effectiveBranch && !branchError && (!branchExists || existing) && (existing || !!effectiveBase) && !creating

  const submit = async () => {
    if (!canCreate) return
    setCreating(true)
    const created = await createFeature({
      repo: scope,
      label: label.trim(),
      branch: effectiveBranch,
      base: effectiveBase,
      existing: branchExists && existing,
      copy,
      setup: setup.trim() || null,
      open,
      prompt: open ? prompt : "",
    })
    setCreating(false)
    if (created) removeTabs((t) => t.id === tabId({ kind: "featureCreate", repo: repo ?? undefined }))
  }

  if (list && !list.git)
    return (
      <div className="doc-page">
        <div className="editor-message center">Las features necesitan un repositorio git, o una carpeta que tenga repos adentro.</div>
      </div>
    )

  if (list?.multi && !group)
    return (
      <div className="doc-page">
        <div className="editor-message center">
          <span>Elegí en qué repositorio va la feature.</span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              removeTabs((t) => t.id === tabId({ kind: "featureCreate", repo: repo ?? undefined }))
              void openFeatureCreate()
            }}
          >
            <Icon name="repo" /> Elegir repositorio
          </button>
        </div>
      </div>
    )

  return (
    <div className="doc-page feature-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="git-branch-create" /> Feature nueva
        </div>
        <h1>{label.trim() || "Nueva feature"}</h1>
        <div className="doc-meta">
          {list?.multi && group && (
            <span>
              <Icon name="repo" /> {group.name}
            </span>
          )}
          <span>Una carpeta propia (worktree) con su rama, sus conversaciones y su terminal. La copia principal no se toca.</span>
        </div>
        <div className="doc-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={!canCreate} onClick={() => void submit()}>
            <Icon name={creating ? "loading" : "add"} spin={creating} /> Crear feature
          </button>
        </div>
      </header>
      <section className="doc-section routine-form">
        <label className="routine-field">
          <span className="routine-label">Nombre</span>
          <input
            className="input"
            autoFocus
            value={label}
            placeholder="Autenticación con Google"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) void submit()
            }}
          />
        </label>
        <div className="routine-row-fields">
          <label className="routine-field feature-grow">
            <span className="routine-label">Rama</span>
            <input
              className="input mono"
              value={effectiveBranch}
              placeholder="feature/nombre"
              onChange={(e) => {
                setBranchTouched(true)
                setBranch(e.target.value)
              }}
            />
          </label>
          {!(branchExists && existing) && (
            <div className="routine-field feature-grow">
              <span className="routine-label">Desde</span>
              <Select className="routine-select-wide" icon="git-branch" value={effectiveBase} options={baseOptions} onChange={setBase} />
            </div>
          )}
        </div>
        {branchError && <div className="feature-callout error"><Icon name="error" /> {branchError}</div>}
        {!branchError && branchExists && (
          <div className="feature-callout warn">
            <Icon name="info" />
            <span>La rama {effectiveBranch} ya existe.</span>
            <Toggle checked={existing} onChange={setExisting} label="Usar la rama existente" />
          </div>
        )}
        {folder && (
          <div className="routine-field">
            <span className="routine-label">Carpeta</span>
            <code className="feature-path">{folder}</code>
            <span className="routine-hint">Arranca desde el último commit de {existing && branchExists ? effectiveBranch : effectiveBase || "la rama elegida"}. Los cambios sin commitear de la principal no se copian.</span>
          </div>
        )}
        <div className="routine-field">
          <span className="routine-label">Archivos que se copian de la principal</span>
          {candidates === null ? (
            <span className="routine-hint">
              <Spinner size={11} /> Buscando archivos ignorados por git…
            </span>
          ) : candidates.length === 0 ? (
            <span className="routine-hint">No hay archivos ignorados para copiar (como .env).</span>
          ) : (
            <div className="feature-copy-list">
              {candidates.map((c) => (
                <label key={c.path} className="feature-copy-item">
                  <input
                    type="checkbox"
                    checked={copy.includes(c.path)}
                    onChange={(e) => setCopy((prev) => (e.target.checked ? [...prev, c.path] : prev.filter((p) => p !== c.path)))}
                  />
                  <Icon name={c.dir ? "folder" : "file"} />
                  <span className="mono">{c.path}{c.dir ? "/" : ""}</span>
                  {c.suggested && <span className="routine-pill">sugerido</span>}
                </label>
              ))}
            </div>
          )}
          <span className="routine-hint">Se copian una vez (no quedan enlazados). Las dependencias y builds no se copian: se instalan con el paso de abajo.</span>
        </div>
        <label className="routine-field">
          <span className="routine-label">Preparar el entorno</span>
          <input className="input mono" value={setup} placeholder="npm install (vacío para no correr nada)" onChange={(e) => setSetup(e.target.value)} />
          <span className="routine-hint">Corre en la terminal de la feature apenas se abre. Se recuerda para las próximas features.</span>
        </label>
        <div className="routine-field">
          <span className="routine-label">Al crearla</span>
          <Toggle checked={open} onChange={setOpen} label="Abrir la feature (se cierran las terminales de la actual)" />
        </div>
        {open && (
          <label className="routine-field">
            <span className="routine-label">Primer pedido al agente (opcional)</span>
            <textarea
              className="input routine-prompt feature-prompt"
              rows={4}
              value={prompt}
              placeholder="Implementá el login con Google usando…"
              onChange={(e) => setPrompt(e.target.value)}
            />
            <span className="routine-hint">Queda escrito en el chat de una conversación nueva de la feature, listo para mandar.</span>
          </label>
        )}
      </section>
    </div>
  )
}

function Changed({ feature }: { feature: Feature | undefined }) {
  if (!feature?.changes) return null
  const c = feature.changes
  const parts: string[] = []
  if (c.staged) parts.push(`${c.staged} en stage`)
  if (c.unstaged) parts.push(`${c.unstaged} modificados`)
  if (c.untracked) parts.push(`${c.untracked} nuevos`)
  if (c.conflicts) parts.push(`${c.conflicts} con conflicto`)
  return <>{parts.join(" · ")}</>
}

type Blocker = { tone: "error" | "warn" | "info"; text: string; action?: { label: string; run: () => void } }

export function FeatureIntegrateEditor({ path }: { path: string }) {
  const project = useProject((s) => s.project)
  const list = useFeatures((s) => s.list)
  const feature = list?.features.find((f) => samePath(f.path, path))
  const branches = useLocalBranches(feature && !feature.missing ? feature.path : null)
  const statuses = useAgent((s) => s.statuses)
  const allSessions = useAgent((s) => s.allSessions)
  const [target, setTarget] = useState("")
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [merging, setMerging] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const scope = feature?.repo || project
  const effectiveTarget = target || feature?.base?.replace(/^origin\//, "") || findGroup(scope, list)?.defaultBase || ""
  const sourcePath = feature && !feature.missing ? feature.path : null
  const requestKey = scope && sourcePath && effectiveTarget ? `${sourcePath}|${effectiveTarget}|${feature?.head ?? ""}|${nonce}` : null
  const loading = requestKey !== null && loadedKey !== requestKey

  useEffect(() => {
    if (!requestKey || !scope || !sourcePath) return
    let alive = true
    featuresMergePreview(scope, sourcePath, effectiveTarget)
      .then((p) => {
        if (!alive) return
        setPreview(p)
        setError(null)
      })
      .catch((e) => {
        if (!alive) return
        setPreview(null)
        setError(errorMessage(e))
      })
      .finally(() => alive && setLoadedKey(requestKey))
    return () => {
      alive = false
    }
  }, [requestKey, scope, sourcePath, effectiveTarget])

  if (!feature)
    return (
      <div className="doc-page">
        <div className="editor-message center">Esta feature ya no existe.</div>
      </div>
    )

  const targetGroup = preview?.targetCheckout ? findGroup(preview.targetCheckout, list) : null
  const targetFeature = preview?.targetCheckout
    ? (list?.features.find((f) => samePath(f.path, preview.targetCheckout!)) ??
      (list?.multi && targetGroup ? list.features.find((f) => f.kind === "main") : undefined))
    : undefined
  const targetLabel = (fallback: string) =>
    list?.multi && targetGroup ? `${targetGroup.name} · principal` : targetFeature ? featureTitle(targetFeature) : fallback
  const busyIn = (f: Feature | undefined) =>
    !!f && allSessions.some((s) => s.directory && samePath(s.directory, f.root) && statuses[s.id] && statuses[s.id].type !== "idle")

  const blockers: Blocker[] = []
  if (preview) {
    const sourceTracked = preview.sourceChanges.staged + preview.sourceChanges.unstaged + preview.sourceChanges.conflicts
    if (sourceTracked > 0)
      blockers.push({
        tone: "error",
        text: `La feature tiene ${sourceTracked} archivo(s) con cambios sin commitear. Commitealos antes de integrar.`,
        action: {
          label: "Ir a Control de código",
          run: () => void switchToFeature(feature).then((ok) => ok && useLayout.getState().showView("scm", false)),
        },
      })
    if (preview.sourceChanges.untracked > 0)
      blockers.push({ tone: "warn", text: `${preview.sourceChanges.untracked} archivo(s) nuevos sin commitear no se van a integrar.` })
    if (preview.targetMerging) blockers.push({ tone: "error", text: `${preview.target} ya tiene un merge en curso: terminalo o abortalo primero.` })
    const targetTracked = preview.targetChanges ? preview.targetChanges.staged + preview.targetChanges.unstaged + preview.targetChanges.conflicts : 0
    if (targetTracked > 0)
      blockers.push({
        tone: "error",
        text: `${preview.target} está abierta en «${targetLabel(preview.targetCheckout ?? "")}» con ${targetTracked} archivo(s) sin commitear. Commitealos o guardalos en stash.`,
      })
    if (targetFeature && hasUnsavedIn(targetFeature))
      blockers.push({ tone: "error", text: `Hay archivos sin guardar en «${targetLabel(featureTitle(targetFeature))}». Guardalos antes de integrar.` })
    if (busyIn(targetFeature))
      blockers.push({ tone: "error", text: `Hay agentes trabajando en «${targetLabel(preview.target)}». Esperá a que terminen.` })
    if (busyIn(feature)) blockers.push({ tone: "warn", text: "Hay agentes trabajando en esta feature: se integra lo que ya está commiteado." })
    if (preview.conflicts.length > 0)
      blockers.push(
        preview.targetCheckout
          ? {
              tone: "warn",
              text: `Hay conflictos en ${preview.conflicts.length} archivo(s). Si integrás, el merge queda en curso en «${targetLabel(preview.targetCheckout ?? "")}» para que los resuelvas. También podés traer ${preview.target} a la feature y resolverlos acá.`,
              action: { label: `Traer ${preview.target} a la feature`, run: () => void updateFromBase(feature) },
            }
          : {
              tone: "error",
              text: `Hay conflictos en ${preview.conflicts.length} archivo(s) y ${preview.target} no está abierta en ninguna feature. Traé ${preview.target} a la feature, resolvelos y volvé a integrar.`,
              action: { label: `Traer ${preview.target} a la feature`, run: () => void updateFromBase(feature) },
            },
      )
  }
  const blocked = blockers.some((b) => b.tone === "error")
  const defaultMessage = preview ? `Integrar ${featureTitle(feature)} (${preview.source}) en ${preview.target}` : ""

  const integrate = async () => {
    if (!scope || !preview || blocked || preview.upToDate) return
    setMerging(true)
    try {
      const result = await featuresMerge({
        project: scope,
        sourcePath: feature.path,
        target: preview.target,
        expectedSource: preview.sourceHead,
        expectedTarget: preview.targetHead,
        message: message.trim() || defaultMessage,
      })
      await handleMergeResult(result, `«${featureTitle(feature)}» integrada en ${preview.target}`)
      if (result.status === "merged") setDone(preview.target)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setMerging(false)
      setNonce((n) => n + 1)
      void refreshFeatures()
    }
  }

  const targetOptions = branches
    .filter((b) => !b.remote && b.name !== feature.branch)
    .map((b) => ({ value: b.name, label: b.name, description: b.name === feature.base ? "base de la feature" : b.subject, icon: "git-branch" }))

  return (
    <div className="doc-page feature-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="git-merge" /> Integrar feature
        </div>
        <h1>{featureTitle(feature)}</h1>
        <div className="doc-meta">
          <span className="mono">{feature.branch ?? "HEAD detached"}</span>
          <Icon name="arrow-right" />
          <span className="mono">{effectiveTarget || "…"}</span>
          {preview && !preview.upToDate && <span>{preview.totalCommits} commit(s)</span>}
          <span>
            <Changed feature={feature} />
          </span>
        </div>
        <div className="doc-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!preview || blocked || preview.upToDate || merging || loading}
            onClick={() => void integrate()}
          >
            <Icon name={merging ? "loading" : "git-merge"} spin={merging} /> Integrar en {effectiveTarget}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void openPullRequest(feature)}>
            <Icon name="git-pull-request-create" /> Crear PR en vez de integrar
          </button>
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => setNonce((n) => n + 1)}>
            <Icon name="refresh" spin={loading} /> Revisar de nuevo
          </button>
        </div>
      </header>
      <section className="doc-section routine-form">
        <div className="routine-row-fields">
          <div className="routine-field feature-grow">
            <span className="routine-label">Integrar en</span>
            <Select className="routine-select-wide" icon="git-branch" value={effectiveTarget} options={targetOptions} onChange={setTarget} />
          </div>
          <div className="routine-field feature-grow">
            <span className="routine-label">Dónde</span>
            <span className="feature-where">
              {preview?.targetCheckout ? (
                <>
                  <Icon name={targetFeature?.kind === "main" ? "home" : "git-branch"} /> en la copia «{targetLabel(preview.targetCheckout)}», que queda actualizada
                </>
              ) : preview ? (
                <>
                  <Icon name="cloud" /> {preview.target} no está abierta: se mueve la rama sin tocar ninguna carpeta
                </>
              ) : (
                "…"
              )}
            </span>
          </div>
        </div>
        {error && <div className="feature-callout error"><Icon name="error" /> {error}</div>}
        {done && (
          <div className="feature-callout ok">
            <Icon name="pass" />
            <span>Integrada en {done}. La carpeta y la rama de la feature se conservan.</span>
            <button type="button" className="btn btn-sm" onClick={() => void setArchived(feature, true)}>
              <Icon name="archive" /> Archivar
            </button>
            <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => void removeFeature(feature)}>
              <Icon name="trash" /> Eliminar
            </button>
          </div>
        )}
        {preview?.upToDate && !done && <div className="feature-callout info"><Icon name="check" /> {preview.target} ya tiene todo lo de esta feature.</div>}
        {blockers.map((b, i) => (
          <div key={i} className={`feature-callout ${b.tone}`}>
            <Icon name={b.tone === "error" ? "error" : b.tone === "warn" ? "warning" : "info"} />
            <span>{b.text}</span>
            {b.action && (
              <button type="button" className="btn btn-sm" onClick={b.action.run}>
                {b.action.label}
              </button>
            )}
          </div>
        ))}
        {preview && preview.conflicts.length > 0 && (
          <div className="routine-field">
            <span className="routine-label">Archivos en conflicto</span>
            <div className="feature-file-list">
              {preview.conflicts.map((f) => (
                <span key={f} className="mono">{f}</span>
              ))}
            </div>
          </div>
        )}
        {preview && !preview.upToDate && (
          <label className="routine-field">
            <span className="routine-label">Mensaje del merge</span>
            <input className="input" value={message} placeholder={defaultMessage} onChange={(e) => setMessage(e.target.value)} />
          </label>
        )}
        {preview && preview.commits.length > 0 && (
          <div className="routine-field">
            <span className="routine-label">Commits que entran</span>
            <div className="feature-commits">
              {preview.commits.map((c) => (
                <div key={c.hash} className="feature-commit">
                  <span className="mono feature-hash">{c.hash.slice(0, 7)}</span>
                  <span className="feature-subject">{c.subject}</span>
                  <span className="feature-meta">{c.author} · {timeAgo(c.time * 1000)}</span>
                </div>
              ))}
              {preview.totalCommits > preview.commits.length && (
                <div className="routine-hint">y {preview.totalCommits - preview.commits.length} más</div>
              )}
            </div>
          </div>
        )}
        {preview?.stat && (
          <div className="routine-field">
            <span className="routine-label">Archivos</span>
            <pre className="feature-stat">{preview.stat}</pre>
          </div>
        )}
        {loading && !preview && (
          <span className="routine-hint">
            <Spinner size={11} /> Revisando qué entra y si hay conflictos…
          </span>
        )}
        <span className="routine-hint">
          {changeCount(feature.changes) === 0 ? "" : "Solo se integra lo commiteado. "}La comparación es contra el último commit de cada rama; si cambian, se vuelve a revisar antes de integrar.
        </span>
      </section>
    </div>
  )
}
