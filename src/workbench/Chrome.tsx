import { useLayout, type ViewId } from "../state/layout"
import {
  useProject,
  openProject,
  openInNewWindow,
  pickProject,
  pickProjectInNewWindow,
  pickRecentInNewWindow,
  pickWindow,
} from "../state/project"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useAgent, sessionStatus, toggleFavoriteModel } from "../state/agent"
import { useAttention, testAlert, silenceSound, focusPending } from "../state/attention"
import { useUnseen } from "../state/unseen"
import {
  USAGE_WINDOWS,
  chatgptWorst,
  fiveHourRelease,
  goRows,
  quotaWindowLabel,
  redeemChatgptReset,
  redeemableResets,
  refreshChatgptResets,
  refreshChatgptUsage,
  refreshGoUsage,
  refreshUsage,
  renewalLabel,
  resetExpiryLabel,
  resetsCountLabel,
  setUsageLimits,
  usageRatio,
  useUsage,
  type UsageLimits,
} from "../state/usage"
import { CHATGPT } from "../state/accounts"
import { useGit } from "../state/git"
import { contextSettings, featureTitle, findFeature, isAppRunning, pickFeature, runApp, stopApp, useFeatures } from "../state/features"
import { useTerminals } from "../state/terminals"
import { useDocs, docKey } from "../editor/documents"
import { useEditors, openEditor } from "../state/editors"
import { recentlyActive, useDesktopStatus } from "../lib/desktop"
import { useOutput } from "../state/output"
import { showQuickOpen, pickOne, promptInput } from "../state/quickinput"
import { executeCommand } from "../commands/registry"
import { useZoom } from "../state/zoom"
import { pickBranch } from "../views/ScmView"
import { basename, projectName } from "../lib/paths"
import { modelKey } from "../lib/opencode"
import { formatUsd, percent } from "../lib/format"
import { clockTime } from "../lib/time"
import { Icon, IconButton } from "../components/ui"
import { openMenuAt } from "../components/ContextMenu"
import { Logo } from "../components/Logo"
import { UpdateButton } from "../components/Updates"

const VIEWS: Array<{ id: ViewId; icon: string; title: string; keys: string }> = [
  { id: "explorer", icon: "files", title: "Explorador", keys: "Ctrl+Shift+E" },
  { id: "search", icon: "search", title: "Buscar", keys: "Ctrl+Shift+F" },
  { id: "scm", icon: "source-control", title: "Control de código", keys: "Ctrl+Shift+G" },
  { id: "agents", icon: "comment-discussion", title: "Sesiones del agente", keys: "Ctrl+Shift+A" },
  { id: "prs", icon: "git-pull-request", title: "Pull requests", keys: "" },
  { id: "routines", icon: "calendar", title: "Rutinas", keys: "" },
  { id: "memory", icon: "library", title: "Memoria", keys: "" },
  { id: "plane", icon: "hubot", title: "Plano del agente", keys: "" },
]

export function ActivityBar() {
  const active = useLayout((s) => s.activeView)
  const visible = useLayout((s) => s.sidebarVisible)
  const changes = useGit((s) => s.repos.reduce((n, r) => n + (s.byRepo[r]?.status?.entries.length ?? 0), 0))
  const busy = useAgent((s) => Object.values(s.statuses).filter((x) => x.type === "busy").length)
  const attention = useAgent((s) => s.permissions.length + s.questions.length)
  const sessions = useAgent((s) => s.sessions)
  const unseenIds = useUnseen((s) => s.ids)
  const unseen = sessions.filter((s) => !s.parentID && s.id in unseenIds).length
  return (
    <nav className="activity-bar">
      <button type="button" className="activity-item commands" title="Comandos (Ctrl+Shift+P)" onClick={() => showQuickOpen(">")}>
        <Icon name="symbol-event" />
      </button>
      {VIEWS.map((v) => {
        const badge = v.id === "scm" ? changes : v.id === "agents" ? attention || busy || unseen : 0
        const tone = v.id !== "agents" ? "" : attention ? " attention" : !busy && unseen ? " done" : ""
        return (
          <button
            key={v.id}
            type="button"
            className={`activity-item${visible && active === v.id ? " active" : ""}`}
            title={`${v.title}${v.keys ? ` (${v.keys})` : ""}`}
            onClick={() => useLayout.getState().showView(v.id)}
          >
            <Icon name={v.icon} />
            {badge > 0 && <span className={`activity-badge${tone}`}>{badge > 99 ? "99+" : badge}</span>}
          </button>
        )
      })}
      <span className="activity-spacer" />
    </nav>
  )
}

function FeatureChip() {
  const list = useFeatures((s) => s.list)
  const root = useProject((s) => s.root)
  const feature = findFeature(root, list)
  if (!list?.git || !feature) return null
  const isolated = feature.kind !== "main"
  return (
    <button
      type="button"
      className={`title-feature${isolated ? " isolated" : ""}`}
      onClick={() => void pickFeature()}
      title={`${isolated ? "Feature aislada en su propia carpeta" : "Copia principal del proyecto"}: ${feature.root}\nClic para cambiar de feature`}
    >
      <Icon name={isolated ? "worktree" : "home"} />
      <span className="title-feature-name">{featureTitle(feature)}</span>
      {feature.branch && <span className="title-feature-branch">{feature.branch}</span>}
      <Icon name="chevron-down" />
    </button>
  )
}

export function TitleBar() {
  const root = useProject((s) => s.project ?? s.root)
  const recent = useProject((s) => s.recent)
  const sidebar = useLayout((s) => s.sidebarVisible)
  const panel = useLayout((s) => s.panelVisible)
  const agent = useLayout((s) => s.agentVisible)
  const focusChat = useLayout((s) => s.focusChat)

  const projectMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { label: "Abrir carpeta…", icon: "folder-opened", keys: "ctrl+o", run: () => void pickProject() },
      { label: "Abrir carpeta en una ventana nueva…", icon: "empty-window", run: () => void pickProjectInNewWindow() },
      { label: "Nueva ventana", icon: "empty-window", keys: "ctrl+shift+n", run: () => void openInNewWindow() },
      { label: "Ir a otra ventana…", icon: "multiple-windows", run: () => void pickWindow() },
      ...(recent.filter((p) => p !== root).length > 0 ? [{ separator: true as const }] : []),
      ...recent
        .filter((p) => p !== root)
        .slice(0, 8)
        .map((p) => ({ label: basename(p), icon: "root-folder", run: () => void openProject(p) })),
      ...(recent.filter((p) => p !== root).length > 0
        ? [{ label: "Abrir un reciente en una ventana nueva…", icon: "empty-window", run: () => void pickRecentInNewWindow() }]
        : []),
    ])

  const layoutMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { label: "Equilibrado: código + agente", icon: "layout", run: () => useLayout.getState().applyPreset("balanced") },
      { label: "Foco en el agente", icon: "hubot", run: () => useLayout.getState().applyPreset("agent") },
      { label: "Foco en el código", icon: "code", run: () => useLayout.getState().applyPreset("code") },
      { label: "Revisión (git + agente)", icon: "diff-multiple", run: () => useLayout.getState().applyPreset("review") },
      { separator: true },
      {
        label: focusChat ? "Salir del foco en el chat" : "Foco en el chat (ocultar editor)",
        icon: focusChat ? "screen-normal" : "screen-full",
        keys: "ctrl+alt+m",
        run: () => useLayout.getState().toggleFocusChat(),
      },
    ])

  return (
    <header className="title-bar">
      <div className="title-left">
        <button type="button" className="title-brand" onClick={(e) => projectMenu(e.currentTarget)} title={root ?? "Abrir carpeta"}>
          <Logo size={22} className="brand-logo" />
          <span className="title-project">{projectName(root)}</span>
          <Icon name="chevron-down" />
        </button>
        <FeatureChip />
      </div>
      <button type="button" className="command-center" onClick={() => showQuickOpen()}>
        <Icon name="search" />
        <span>Buscar archivos, comandos (&gt;), sesiones (#)</span>
        <kbd className="kbd">Ctrl+P</kbd>
      </button>
      <div className="title-actions">
        <UpdateButton />
        <IconButton icon="layout" title="Presets de layout" onClick={(e) => layoutMenu(e.currentTarget)} />
        <IconButton icon={sidebar ? "layout-sidebar-left" : "layout-sidebar-left-off"} title="Barra lateral (Ctrl+B)" active={sidebar} onClick={() => useLayout.getState().toggleSidebar()} />
        <IconButton icon={panel ? "layout-panel" : "layout-panel-off"} title="Panel inferior (Ctrl+J)" active={panel} onClick={() => useLayout.getState().togglePanel()} />
        <IconButton icon={agent ? "layout-sidebar-right" : "layout-sidebar-right-off"} title="Agente (Ctrl+Alt+B)" active={agent} onClick={() => useLayout.getState().toggleAgent()} />
      </div>
    </header>
  )
}

function StatusItem({ icon, label, title, onClick, tone, spin, expanded }: { icon?: string; label?: string; title: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; tone?: string; spin?: boolean; expanded?: boolean }) {
  return (
    <button type="button" className={`status-item${tone ? ` ${tone}` : ""}`} title={title} onClick={onClick} disabled={!onClick} aria-expanded={expanded}>
      {icon && <Icon name={icon} spin={spin} />}
      {label && <span>{label}</span>}
    </button>
  )
}

function DesktopStatusItem() {
  const { status } = useDesktopStatus(15000)
  if (!status?.enabled) return null
  const active = recentlyActive(status)
  const last = status.activity[0]
  return (
    <StatusItem
      icon={status.paused ? "debug-pause" : active ? "vm-running" : "vm"}
      label={status.paused ? "PC en pausa" : active ? "usando la PC" : "PC"}
      title={status.paused ? "El control de la PC está en pausa" : active && last ? `El agente: ${last.summary}` : "El agente puede usar esta PC (clic para ver o pausar)"}
      tone={active ? "busy" : status.paused ? "attention" : undefined}
      onClick={() => openEditor({ kind: "desktop" })}
    />
  )
}

async function editUsageLimits(current: UsageLimits) {
  const value = await promptInput({
    title: "Topes de OpenCode Go (US$)",
    prompt: "5 h, 7 días y 30 días, separados por coma",
    value: `${current.fiveHours}, ${current.week}, ${current.month}`,
    validate: (v) => {
      const parts = v.split(",").map((x) => Number(x.trim()))
      return parts.length === 3 && parts.every((n) => Number.isFinite(n) && n > 0) ? null : "Tres montos mayores a cero, por ejemplo: 12, 30, 60"
    },
  })
  if (!value) return
  const [fiveHours, week, month] = value.split(",").map((x) => Number(x.trim()))
  setUsageLimits({ fiveHours, week, month })
}

function QuotaStatus() {
  const onChatgpt = useAgent((s) => s.model.providerID === CHATGPT)
  return onChatgpt ? <ChatgptQuotaStatus /> : <GoQuotaStatus />
}

type QuotaRow = { key: string; label: string; ratio: number; detail?: string }

function QuotaPopover({ anchor, onClose, title, badge, rows, extra, note, error, actions }: {
  anchor: HTMLElement
  onClose: () => void
  title: string
  badge?: string
  rows: QuotaRow[]
  extra?: ReactNode
  note: string
  error?: string | null
  actions: Array<{ label: string; icon: string; run: () => void }>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, rect.top - height - 8),
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [anchor])

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        anchor.focus()
      }
    }
    window.addEventListener("pointerdown", onPointer, true)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("resize", onClose)
    window.addEventListener("blur", onClose)
    return () => {
      window.removeEventListener("pointerdown", onPointer, true)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("resize", onClose)
      window.removeEventListener("blur", onClose)
    }
  }, [anchor, onClose])

  return createPortal(
    <div ref={ref} className="quota-popover" role="dialog" aria-label={title} style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}>
      <div className="quota-popover-head">
        <div>
          <div className="quota-popover-eyebrow">CUOTA UTILIZADA</div>
          <div className="quota-popover-title">{title}</div>
        </div>
        {badge && <span className="quota-popover-badge">{badge}</span>}
      </div>
      <div className="quota-popover-rows">
        {rows.map((row) => {
          const tone = row.ratio >= 1 ? "error" : row.ratio >= 0.8 ? "warn" : "normal"
          return (
            <div className={`quota-popover-row ${tone}`} key={row.key}>
              <div className="quota-popover-line">
                <span>{row.label}</span>
                <strong>{percent(row.ratio)}</strong>
              </div>
              <div className="quota-popover-track" role="progressbar" aria-label={row.label} aria-valuenow={Math.max(0, Math.min(100, Math.round(row.ratio * 100)))} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.max(0, Math.min(100, row.ratio * 100))}%` }} />
              </div>
              {row.detail && <div className="quota-popover-detail">{row.detail}</div>}
            </div>
          )
        })}
      </div>
      {extra}
      {error && <div className="quota-popover-error"><Icon name="warning" /> Última lectura fallida: {error}</div>}
      <div className="quota-popover-footer">
        <div className="quota-popover-note">{note}</div>
        <div className="quota-popover-actions">
          {actions.map((action) => (
            <button key={action.label} type="button" onClick={() => { onClose(); action.run() }}>
              <Icon name={action.icon} /> {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ChatgptResets({ exhausted, onUse }: { exhausted: boolean; onUse: () => void }) {
  const resets = useUsage((s) => s.resets)
  const error = useUsage((s) => s.resetsError)
  const fromUsage = useUsage((s) => s.chatgpt?.resetsAvailable ?? null)
  const redeeming = useUsage((s) => s.redeeming)
  useEffect(() => { void refreshChatgptResets() }, [])
  const credits = resets ? redeemableResets(resets) : []
  const available = resets?.available ?? fromUsage
  const use = (creditId: string | null) => {
    onUse()
    void redeemChatgptReset(creditId)
  }
  const button = (creditId: string | null) => (
    <button type="button" className={`btn btn-sm${exhausted ? " btn-primary" : ""}`} disabled={redeeming} onClick={() => use(creditId)}>
      {redeeming ? <Icon name="loading" spin /> : <Icon name="debug-restart" />} Usar
    </button>
  )
  return (
    <div className="quota-popover-resets">
      <div className="quota-popover-resets-head">
        <span>Resets guardados</span>
        <strong>{available ?? "–"}</strong>
      </div>
      {credits.map((c) => (
        <div className="quota-popover-reset" key={c.id}>
          <div className="quota-popover-reset-text" title={[c.title, c.description].filter(Boolean).join(" · ") || undefined}>
            <span>Reset completo: 5 h y semana</span>
            <span className="quota-popover-detail">{resetExpiryLabel(c)}</span>
          </div>
          {button(c.id)}
        </div>
      ))}
      {credits.length === 0 && !!available && available > 0 && (
        <div className="quota-popover-reset">
          <div className="quota-popover-reset-text">
            <span>Reset completo: 5 h y semana</span>
            <span className="quota-popover-detail">{error ? "No pude leer cuándo vence" : "Consultando el vencimiento…"}</span>
          </div>
          {button(null)}
        </div>
      )}
      {available === 0 && <div className="quota-popover-detail">No tenés resets. Cuando ChatGPT te dé uno, aparece acá.</div>}
      {available === null && <div className="quota-popover-detail">{error ? `No pude leer tus resets: ${error}` : "Consultando tus resets…"}</div>}
    </div>
  )
}

function ChatgptQuotaStatus() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const usage = useUsage((s) => s.chatgpt)
  const error = useUsage((s) => s.chatgptError)
  useEffect(() => { void refreshChatgptUsage() }, [])
  if (!usage) {
    return (
      <>
        <StatusItem
          icon="credit-card"
          label="Cuota ChatGPT"
          title="Ver cuota de ChatGPT"
          tone={error ? "warn" : undefined}
          expanded={!!anchor}
          onClick={(e) => { setAnchor(anchor ? null : e.currentTarget); if (!anchor) void refreshChatgptUsage() }}
        />
        {anchor && <QuotaPopover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          title="ChatGPT"
          rows={[]}
          note={error ? "No se pudo obtener la cuota. Podés reintentar o revisar tu cuenta." : "Consultando la cuota de tu cuenta…"}
          error={error}
          actions={[{ label: "Cuentas de IA", icon: "account", run: () => void openEditor({ kind: "accounts" }) }, { label: "Actualizar", icon: "refresh", run: () => void refreshChatgptUsage() }]}
        />}
      </>
    )
  }
  const worst = chatgptWorst(usage)
  const exhausted = usage.limitReached || worst >= 100
  const tone = exhausted ? "error" : worst >= 80 ? "warn" : undefined
  const plan = usage.plan ? ` ${usage.plan[0].toUpperCase()}${usage.plan.slice(1)}` : ""
  const summary = usage.windows.map((w) => `${quotaWindowLabel(w.windowSeconds).toLowerCase()} ${percent(w.usedPercent / 100)}`).join(" · ")
  const resets = usage.resetsAvailable ?? 0
  const resetsNote = resets > 0 ? `. Tenés ${resetsCountLabel(resets)} guardado${resets === 1 ? "" : "s"}` : ""
  return (
    <>
      <StatusItem
        icon="credit-card"
        label={`ChatGPT ${percent(worst / 100)}${exhausted && resets > 0 ? ` · ${resetsCountLabel(resets)}` : ""}`}
        title={`Cuota de tu plan${plan} de ChatGPT, compartida con Codex: ${summary}${resetsNote}. Medida a las ${clockTime(usage.measuredAt)}`}
        tone={tone}
        expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      />
      {anchor && <QuotaPopover
        anchor={anchor}
        onClose={() => setAnchor(null)}
        title="ChatGPT"
        badge={usage.plan || undefined}
        rows={usage.windows.map((w) => ({ key: String(w.windowSeconds), label: quotaWindowLabel(w.windowSeconds), ratio: w.usedPercent / 100, detail: w.resetsAt ? `Se renueva ${renewalLabel(w.resetsAt)}` : undefined }))}
        extra={<ChatgptResets exhausted={exhausted} onUse={() => setAnchor(null)} />}
        note={`Cuota real compartida con Codex · medida a las ${clockTime(usage.measuredAt)}${usage.limitReached ? " · Límite alcanzado" : ""}`}
        error={error}
        actions={[{ label: "Cuentas de IA", icon: "account", run: () => void openEditor({ kind: "accounts" }) }, { label: "Actualizar", icon: "refresh", run: () => void refreshChatgptUsage() }]}
      />}
    </>
  )
}

function GoQuotaStatus() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const go = useUsage((s) => s.go)
  const goError = useUsage((s) => s.goError)
  const localError = useUsage((s) => s.error)
  const usage = useUsage((s) => s.usage)
  const limits = useUsage((s) => s.limits)
  useEffect(() => { void refreshGoUsage(); void refreshUsage() }, [])

  let rows: QuotaRow[] = []
  let note = "Todavía no hay datos de cuota de OpenCode Go. Podés actualizar o revisar tus cuentas de IA."
  let error: string | null = goError || localError
  let badge: string | undefined
  let summary = ""
  if (go) {
    rows = goRows(go).map((r) => ({
      key: r.id,
      label: r.label,
      ratio: r.ratio,
      detail: `${formatUsd(r.ratio * limits[r.id])} de ${formatUsd(limits[r.id])}${r.resetsAt ? ` · Se renueva ${renewalLabel(r.resetsAt)}` : ""}`,
    }))
    note = `Cuota real de OpenCode Go (montos según tus topes) · medida a las ${clockTime(go.measuredAt)}`
    error = goError
    summary = "Cuota real de OpenCode Go"
  } else if (usage) {
    const release = fiveHourRelease(usage)
    rows = USAGE_WINDOWS.map((w) => ({
      key: w.id,
      label: w.label,
      ratio: usageRatio(usage, limits, w.id),
      detail: `${formatUsd(usage[w.id])} de ${formatUsd(limits[w.id])}${w.id === "fiveHours" && release ? ` · Se libera desde las ${clockTime(release)}` : ""}`,
    }))
    note = `Según el historial local · medida a las ${clockTime(usage.measuredAt)}`
    badge = "Estimado"
    summary = "Cuota de OpenCode Go, estimada con el historial local"
  }

  const worst = rows.length ? rows.reduce((a, b) => (b.ratio > a.ratio ? b : a), rows[0]) : null
  const tone = worst && worst.ratio >= 1 ? "error" : error || (worst && worst.ratio >= 0.8) ? "warn" : undefined
  const refresh = () => {
    void refreshGoUsage()
    void refreshUsage()
  }
  return (
    <>
      <StatusItem
        icon="credit-card"
        label={worst ? `Go ${percent(worst.ratio)}` : "Cuota Go"}
        title={worst ? `${summary}: ${percent(worst.ratio)} en ${worst.label.toLowerCase()}` : "Ver cuota de OpenCode Go"}
        tone={tone}
        expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      />
      {anchor && <QuotaPopover
        anchor={anchor}
        onClose={() => setAnchor(null)}
        title="OpenCode Go"
        badge={badge}
        rows={rows}
        note={note}
        error={error}
        actions={[{ label: worst ? "Editar topes" : "Cuentas de IA", icon: worst ? "settings-gear" : "account", run: () => { if (worst) void editUsageLimits(limits); else void openEditor({ kind: "accounts" }) } }, { label: "Actualizar", icon: "refresh", run: refresh }]}
      />}
    </>
  )
}

export function StatusBar() {
  const repo = useGit((s) => s.activeRepo)
  const status = useGit((s) => (s.activeRepo ? s.byRepo[s.activeRepo]?.status : null))
  const gitBusy = useGit((s) => s.busy)
  const connected = useAgent((s) => s.connected)
  const busyCount = useAgent((s) => Object.values(s.statuses).filter((x) => x.type === "busy").length)
  const attention = useAgent((s) => s.permissions.length + s.questions.length)
  const model = useAgent((s) => s.model)
  const models = useAgent((s) => s.models)
  const favoriteModels = useAgent((s) => s.favoriteModels)
  const cursor = useDocs((s) => s.cursor)
  const activePath = useEditors((s) => {
    const g = s.groups.find((x) => x.id === s.activeGroupId)
    const t = g?.tabs.find((x) => x.id === g.activeId)
    return t?.input.kind === "file" ? t.input.path : null
  })
  const meta = useDocs((s) => (activePath ? s.meta[docKey(activePath)] : undefined))
  const outputErrors = useOutput((s) => s.unseenErrors)
  const modelName = models.find((m) => modelKey(m) === modelKey(model))?.name ?? model.modelID
  const sound = useAttention((s) => s.sound)
  const desktop = useAttention((s) => s.desktop)
  const alerting = useAttention((s) => s.alerting)
  const silenced = useAttention((s) => s.silenced)
  const zoom = useZoom((s) => s.level)
  const featureList = useFeatures((s) => s.list)
  const runTerminalId = useFeatures((s) => s.runTerminalId)
  const terminals = useTerminals((s) => s.terminals)
  const activeRoot = useProject((s) => s.root)
  const feature = findFeature(activeRoot, featureList)
  const appRunning = isAppRunning(runTerminalId, terminals)
  const runCommand = contextSettings(featureList, activeRoot)?.run ?? null

  const attentionMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      {
        label: sound ? "Sonido: activado" : "Sonido: silenciado",
        icon: sound ? "unmute" : "mute",
        run: () => useAttention.getState().setSound(!sound),
      },
      {
        label: desktop ? "Notificación de Windows: activada" : "Notificación de Windows: desactivada",
        icon: desktop ? "bell-dot" : "bell-slash",
        run: () => useAttention.getState().setDesktop(!desktop),
      },
      { separator: true },
      { label: "Probar la alerta", icon: "play", run: testAlert },
    ])

  return (
    <footer className="status-bar">
      <div className="status-left">
        <StatusItem icon="remote" label={connected ? "opencode" : "desconectado"} title={connected ? "Conectado al servidor de opencode" : "Reconectando con opencode…"} tone={connected ? "remote" : "remote offline"} />
        {feature && featureList && featureList.features.length > 1 && (
          <StatusItem
            icon={feature.kind === "main" ? "home" : "worktree"}
            label={featureTitle(feature)}
            title="Feature activa (clic para cambiar)"
            tone={feature.kind === "main" ? undefined : "feature"}
            onClick={() => void pickFeature()}
          />
        )}
        {status && repo && (
          <>
            <StatusItem icon="git-branch" label={status.detached ? "HEAD" : status.branch} title="Cambiar de rama" onClick={() => void pickBranch(repo)} />
            <StatusItem
              icon={gitBusy ? "sync" : status.upstream ? "sync" : "cloud-upload"}
              spin={!!gitBusy}
              label={status.upstream ? `${status.behind}↓ ${status.ahead}↑` : "publicar"}
              title={gitBusy ?? (status.upstream ? `Sincronizar con ${status.upstream}` : "Publicar la rama")}
              onClick={() => void executeCommand("git.sync")}
            />
          </>
        )}
        {featureList?.git && (
          <StatusItem
            icon={appRunning ? "debug-stop" : "play"}
            label={appRunning ? "app corriendo" : "correr app"}
            title={appRunning ? "Detener la app (cierra su terminal y libera los puertos)" : runCommand ? `Correr: ${runCommand}` : "Elegir cómo se corre la app y correrla"}
            tone={appRunning ? "busy" : undefined}
            onClick={() => void (appRunning ? stopApp() : runApp())}
          />
        )}
        {outputErrors > 0 && (
          <StatusItem icon="error" label={String(outputErrors)} title="Errores de git/gh: ver salida" tone="error" onClick={() => useLayout.getState().showPanel("output")} />
        )}
      </div>
      <div className="status-right">
        {cursor && activePath && (
          <StatusItem label={`Ln ${cursor.line}, Col ${cursor.column}${cursor.selected ? ` (${cursor.selected} sel.)` : ""}`} title="Ir a línea (Ctrl+G)" onClick={() => showQuickOpen(":")} />
        )}
        {meta && activePath && (
          <>
            <StatusItem label={meta.indent === "\t" ? "Tabs" : `Espacios: ${meta.indent.length}`} title="Indentación detectada" />
            <StatusItem label={meta.bom ? "UTF-8 BOM" : "UTF-8"} title="Encoding (se respeta al guardar)" />
            <StatusItem label={meta.eol === "\r\n" ? "CRLF" : "LF"} title="Fin de línea (se respeta al guardar)" />
            <StatusItem label={meta.language} title="Lenguaje" />
          </>
        )}
        {attention > 0 && (
          <StatusItem
            icon={silenced ? "bell-slash" : "bell-dot"}
            label={silenced ? `${attention} esperando · silenciado` : `${attention} esperando`}
            title={silenced ? "Aviso silenciado. Clic para ir a responder" : "El agente espera tu respuesta (clic para silenciar e ir)"}
            tone="attention"
            onClick={() => {
              silenceSound()
              focusPending()
            }}
          />
        )}
        <StatusItem
          icon={busyCount > 0 ? "loading" : "hubot"}
          spin={busyCount > 0}
          label={busyCount > 0 ? `${busyCount} trabajando` : sessionStatus(useAgent.getState().activeSessionId) === "idle" ? "agente listo" : ""}
          title="Panel del agente (Ctrl+Alt+B)"
          onClick={() => useLayout.getState().toggleAgent()}
          tone={busyCount > 0 ? "busy" : undefined}
        />
        <DesktopStatusItem />
        <QuotaStatus />
        {zoom !== 1 && (
          <StatusItem
            icon="zoom-in"
            label={`${Math.round(zoom * 100)}%`}
            title="Zoom de la interfaz (Ctrl+= / Ctrl+-). Clic para restablecer"
            onClick={() => useZoom.getState().reset()}
          />
        )}
        <StatusItem
          icon="sparkle"
          label={modelName}
          title="Cambiar modelo"
          onClick={async () => {
            const item = await pickOne(
              models
                .map((m) => {
                  const key = modelKey(m)
                  return {
                    id: key,
                    label: m.name,
                    description: m.providerName,
                    icon: key === modelKey(model) ? "check" : "circle-small",
                    favorite: favoriteModels.includes(key),
                    onToggleFavorite: () => toggleFavoriteModel(key),
                  }
                })
                .sort((a, b) => Number(b.favorite) - Number(a.favorite)),
              { title: "Modelo del agente", favorites: true },
            )
            if (item) {
              const [providerID, ...rest] = item.id.split("/")
              useAgent.setState({ model: { providerID, modelID: rest.join("/") } })
            }
          }}
        />
        <StatusItem
          icon={alerting ? "bell-dot" : sound ? "bell" : "bell-slash"}
          title={alerting ? "El agente espera tu respuesta" : "Avisos cuando el agente espera"}
          tone={alerting ? "attention" : undefined}
          onClick={(e) => attentionMenu(e.currentTarget)}
        />
      </div>
    </footer>
  )
}
