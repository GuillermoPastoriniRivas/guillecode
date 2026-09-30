import { useEffect, useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { confirmAction } from "../components/Dialog"
import { Toggle } from "../components/fields"
import { Icon } from "../components/ui"
import { formatTokens } from "../lib/format"
import { modelKey } from "../lib/opencode"
import {
  CHATGPT,
  ZEN,
  cancelLogin,
  connectOpencode,
  loadAuthEntries,
  loginChatgpt,
  reloadProviders,
  removeProvider,
  setOpencodeZen,
  useAccounts,
  type AuthEntry,
  type LoginFlow,
} from "../state/accounts"
import { setModel, setZenFreeOnly, useAgent, type ConnectedProvider, type ProviderModel } from "../state/agent"
import { pickOne } from "../state/quickinput"
import { notify } from "../state/toasts"

function toAgents(n: number): string {
  return n === 1 ? "al agente que está trabajando" : `a los ${n} agentes que están trabajando`
}

type ProviderRow = {
  id: string
  name: string
  how: string
  credential: string
  restore: string
  models: number
  listed: boolean
  removable: boolean
  hint: string | null
  inUse: boolean
}

const PROVIDER_LABELS: Record<string, string> = { [ZEN]: "OpenCode Zen" }

function describeProviders(providers: ConnectedProvider[], entries: AuthEntry[] | null, models: ProviderModel[], current: string): ProviderRow[] {
  const ids = [...new Set([...providers.map((p) => p.id), ...(entries ?? []).map((e) => e.id)])]
  return ids
    .map((id) => {
      const p = providers.find((x) => x.id === id)
      const entry = entries?.find((e) => e.id === id)
      const name = PROVIDER_LABELS[id] ?? p?.name ?? id
      const oauth = entry ? entry.kind === "oauth" : !!p?.oauth
      const apiKey = entry ? entry.kind === "api" : p?.source === "api"
      let how = "Incluido en opencode"
      let hint: string | null = null
      if (oauth) how = id === CHATGPT ? "Suscripción de ChatGPT" : "Sesión iniciada"
      else if (apiKey) how = "API key guardada"
      else if (entry) how = "Credencial guardada"
      else if (p?.source === "env") {
        how = `Variable de entorno ${p.env[0] ?? ""}`.trim()
        hint = "Para quitarlo, borrá la variable de Windows y reiniciá GuilleCode."
      } else if (p?.source === "config") {
        how = "Configurado en opencode.json"
        hint = "Para quitarlo, sacalo del opencode.json global o del proyecto."
      }
      return {
        id,
        name,
        how,
        credential: oauth ? `tu sesión de ${name}` : apiKey ? `la API key de ${name}` : `la credencial de ${name}`,
        restore: oauth ? "volver a iniciar sesión" : "volver a cargar la clave",
        models: models.filter((m) => m.providerID === id).length,
        listed: !!p,
        removable: entries ? !!entry : oauth || apiKey,
        hint,
        inUse: current === id,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
}

function ProviderList() {
  const providers = useAgent((s) => s.providers)
  const models = useAgent((s) => s.models)
  const current = useAgent((s) => s.model.providerID)
  const entries = useAccounts((s) => s.authEntries)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    void loadAuthEntries()
  }, [providers])

  const rows = describeProviders(providers, entries, models, current)
  if (rows.length === 0) return null

  const remove = async (row: ProviderRow) => {
    const inUse = row.inUse ? " El chat lo está usando ahora: paso a otro modelo." : ""
    const message = `Se borra ${row.credential} de opencode en esta PC: el chat, el celular, las rutinas y opencode en la terminal dejan de usarla.${inUse} Si después lo querés de vuelta, vas a tener que ${row.restore}.`
    if (!(await confirmAction(`Quitar ${row.name}`, message, "Quitar", true))) return
    setRemoving(row.id)
    try {
      await removeProvider(row.id, row.name)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="remote-steps">
      <strong>
        <Icon name="plug" /> Proveedores conectados
      </strong>
      <span>Cada proveedor suma sus modelos al selector del chat. Quitar uno borra su credencial de opencode en esta PC.</span>
      <ul className="accounts-list">
        {rows.map((r) => (
          <li key={r.id}>
            <div className="accounts-item">
              <span className="accounts-name">
                {r.name}
                {r.inUse && <span className="routine-pill busy">en uso</span>}
              </span>
              <span className="accounts-detail">
                {r.how} · {r.listed ? `${r.models} modelo${r.models === 1 ? "" : "s"}` : "sin modelos disponibles"}
              </span>
              {r.hint && <span className="accounts-hint">{r.hint}</span>}
            </div>
            {r.removable && (
              <button type="button" className="btn btn-sm" disabled={removing !== null} onClick={() => void remove(r)}>
                <Icon name={removing === r.id ? "loading" : "trash"} spin={removing === r.id} /> Quitar
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function FlowSteps({ flow }: { flow: LoginFlow }) {
  if (flow.method === "browser")
    return (
      <>
        <span>Se abrió el navegador: iniciá sesión con tu cuenta de ChatGPT. Cuando termines, esto se actualiza solo.</span>
        <div className="remote-command">
          <button type="button" className="btn btn-sm" onClick={() => void openUrl(flow.url)}>
            <Icon name="link-external" /> Abrir de nuevo
          </button>
          <button type="button" className="btn btn-sm" onClick={cancelLogin}>
            Cancelar
          </button>
        </div>
      </>
    )
  return (
    <>
      <span>Abrí la página en cualquier navegador (también sirve el del celular) y escribí este código:</span>
      <div className="remote-command">
        <code className="accounts-code">{flow.code ?? "—"}</code>
        {flow.code && (
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => {
              void navigator.clipboard.writeText(flow.code ?? "")
              notify.info("Código copiado")
            }}
          >
            <Icon name="copy" /> Copiar
          </button>
        )}
      </div>
      <div className="remote-command">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void openUrl(flow.url)}>
          <Icon name="link-external" /> Abrir la página
        </button>
        <button type="button" className="btn btn-sm" onClick={cancelLogin}>
          Cancelar
        </button>
      </div>
      <span>Cuando apruebes el código, esto se actualiza solo.</span>
    </>
  )
}

export function AccountsEditor({ onboarding = false, onContinue }: { onboarding?: boolean; onContinue?: () => void }) {
  const connected = useAgent((s) => s.connected)
  const providers = useAgent((s) => s.providers)
  const models = useAgent((s) => s.models)
  const model = useAgent((s) => s.model)
  const { starting, flow, waitingFor } = useAccounts()
  const modelsLoaded = useAgent((s) => s.modelsLoaded)
  const modelsError = useAgent((s) => s.modelsError)
  const zenFreeOnly = useAgent((s) => s.zenFreeOnly)
  const savingKey = useAccounts((s) => s.savingKey)
  const savingZen = useAccounts((s) => s.savingZen)
  const entries = useAccounts((s) => s.authEntries)
  const [key, setKey] = useState("")
  const go = providers.find((p) => p.id === "opencode-go")
  const zenOn = !!entries?.some((e) => e.id === ZEN)
  const canContinue = modelsLoaded && !modelsError && models.length > 0 && waitingFor === 0
  const loading = !connected && providers.length === 0

  const openai = providers.find((p) => p.id === CHATGPT)
  const link = openai ? (openai.oauth ? "subscription" : "apiKey") : null
  const chatgptModels = models.filter((m) => m.providerID === CHATGPT)

  const pill = (() => {
    if (loading) return { text: "Conectando con opencode…", tone: "" }
    if (waitingFor > 0) return { text: "Esperando para recargar", tone: "warn" }
    if (flow || starting) return { text: "Iniciando sesión…", tone: "busy" }
    if (link === "subscription") return { text: "ChatGPT conectado", tone: "ok" }
    if (link === "apiKey") return { text: "OpenAI con API key", tone: "" }
    return { text: "ChatGPT sin conectar", tone: "" }
  })()

  const chooseModel = async () => {
    const current = modelKey(model)
    const item = await pickOne(
      chatgptModels.map((m) => ({
        id: m.modelID,
        label: m.name,
        description: [m.reasoning && "razona", m.image && "imágenes", m.contextLimit && `${formatTokens(m.contextLimit)} de contexto`].filter(Boolean).join(" · "),
        icon: modelKey(m) === current ? "check" : "circle-small",
      })),
      { title: "Modelo de ChatGPT", placeholder: "Buscar modelo" },
    )
    if (!item) return
    setModel({ providerID: CHATGPT, modelID: item.id })
    notify.info(`El chat usa ${item.label}`, "Desde el próximo mensaje, en cualquier conversación.")
  }

  const logout = async () => {
    const what = link === "apiKey" ? "la API key de OpenAI" : "tu sesión de ChatGPT"
    if (!(await confirmAction("Desconectar", `Se borra ${what} de opencode en esta PC: el chat, el celular, las rutinas y opencode en la terminal dejan de usarla.`, "Desconectar", true))) return
    await removeProvider(CHATGPT, "ChatGPT")
  }

  const reloadNow = async () => {
    if (!(await confirmAction("Recargar ahora", `Recargar opencode corta ${toAgents(waitingFor)}. Lo que ya hicieron queda, pero se detienen a mitad de la tarea.`, "Recargar y cortar", true))) return
    await reloadProviders(true)
  }

  const loginButtons = (
    <div className="remote-command">
      <button type="button" className="btn btn-sm btn-primary" disabled={!!starting || savingKey} onClick={() => void loginChatgpt("browser")}>
        <Icon name={starting === "browser" ? "loading" : "sign-in"} spin={starting === "browser"} /> Iniciar sesión con ChatGPT
      </button>
      <button type="button" className="btn btn-sm" disabled={!!starting || savingKey} title="Para cuando el navegador de esta PC no puede volver a GuilleCode" onClick={() => void loginChatgpt("device")}>
        <Icon name={starting === "device" ? "loading" : "key"} spin={starting === "device"} /> Con un código
      </button>
    </div>
  )

  return (
    <div className="doc-page remote-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="account" /> Modelos del agente
        </div>
        <h1>{onboarding ? "Bienvenido a GuilleCode" : "Cuentas de IA"}</h1>
        <div className="doc-meta">
          <span className={`routine-pill ${pill.tone}`}>{pill.text}</span>
        </div>
        <div className="doc-actions">
          <span className="toolbar-spacer" />
          <button type="button" className="btn btn-sm" title="Vuelve a leer las cuentas de opencode, por ejemplo si iniciaste sesión desde la terminal" onClick={() => void reloadProviders()}>
            <Icon name="refresh" /> Recargar modelos
          </button>
        </div>
      </header>
      <section className="doc-section remote-section">
        <p className="remote-text">Usá solamente ChatGPT, solamente OpenCode o ambos. Conectar una sola cuenta alcanza; podés agregar la otra cuando quieras.</p>
        <p className="remote-text">OpenCode viene incluido como motor interno de GuilleCode. Si elegís ChatGPT, no necesitás una cuenta ni una clave de OpenCode.</p>
        {modelsError && <div className="view-error">No se pudieron verificar tus cuentas: {modelsError}. Usá «Recargar modelos» para reintentar.</div>}
        <p className="remote-text">
          Con tu suscripción de ChatGPT Plus o Pro el agente usa los modelos de OpenAI sin API key y sin pagar por token: consume los límites de uso de tu plan, los mismos que Codex.
        </p>
        <div className="remote-steps">
          <strong>
            <Icon name="sparkle" /> ChatGPT
          </strong>
          {waitingFor > 0 ? (
            <>
              <span>
                Listo. Para que el chat vea el cambio hay que recargar opencode, y eso cortaría {toAgents(waitingFor)}. Lo hago solo apenas {waitingFor === 1 ? "termine" : "terminen"}.
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void reloadNow()}>
                <Icon name="debug-restart" /> Recargar ahora
              </button>
            </>
          ) : flow ? (
            <FlowSteps flow={flow} />
          ) : link === "subscription" ? (
            <>
              <span>
                Conectado con tu suscripción: {chatgptModels.length} modelo{chatgptModels.length === 1 ? "" : "s"} disponible{chatgptModels.length === 1 ? "" : "s"} en el selector del chat.
              </span>
              <div className="remote-command">
                <button type="button" className="btn btn-sm btn-primary" disabled={chatgptModels.length === 0} onClick={() => void chooseModel()}>
                  <Icon name="sparkle" /> Elegir un modelo de ChatGPT
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void logout()}>
                  <Icon name="sign-out" /> Cerrar sesión
                </button>
              </div>
            </>
          ) : (
            <>
              <span>
                {link === "apiKey"
                  ? "OpenAI está conectado con una API key, que se cobra por token. Si iniciás sesión con ChatGPT, la suscripción reemplaza a la API key."
                  : "Iniciá sesión con la misma cuenta que usás en chatgpt.com. Se abre el navegador y, cuando aceptás, los modelos aparecen en el chat."}
              </span>
              {loginButtons}
              {link === "apiKey" && (
                <button type="button" className="btn btn-sm" onClick={() => void logout()}>
                  <Icon name="trash" /> Quitar la API key
                </button>
              )}
            </>
          )}
        </div>
        <div className="remote-steps">
          <strong><Icon name="key" /> OpenCode Go {go && <span className="routine-pill ok">Conectado</span>}</strong>
          <span>Conectá tu propia API key del plan OpenCode Go. No necesitás una cuenta de ChatGPT.</span>
          <form className="accounts-key-form" onSubmit={(event) => {
            event.preventDefault()
            void connectOpencode(key, zenOn).then((saved) => { if (saved) setKey("") })
          }}>
            <label htmlFor="opencode-key">API key de OpenCode Go</label>
            <div className="remote-command">
              <input id="opencode-key" className="input" type="password" autoComplete="off" spellCheck={false} value={key} placeholder={go ? "Pegá una nueva clave para reemplazarla" : "Pegá tu API key"} disabled={savingKey} onChange={(event) => setKey(event.target.value)} />
              <button type="submit" className="btn btn-sm btn-primary" disabled={!key.trim() || savingKey || !!starting || !!flow}>
                <Icon name={savingKey ? "loading" : "plug"} spin={savingKey} /> {savingKey ? "Verificando…" : go ? "Reemplazar clave" : "Conectar OpenCode"}
              </button>
            </div>
          </form>
          <Toggle checked={zenOn} disabled={!go || savingZen || !!starting || !!flow} onChange={(value) => void setOpencodeZen(value)} label="Incluir OpenCode Zen (pago por token)" />
          <span>Zen usa la misma clave y suma modelos de pago por token, aparte de tu plan Go. Los modelos gratuitos de Zen no consumen saldo.</span>
          {zenOn && (
            <Toggle checked={zenFreeOnly} onChange={(value) => setZenFreeOnly(value)} label={zenFreeOnly ? "Solo modelos gratuitos de Zen" : "Todos los modelos de Zen"} />
          )}
          <button type="button" className="btn btn-sm" onClick={() => void openUrl("https://opencode.ai/auth")}><Icon name="link-external" /> Abrir consola de OpenCode</button>
          <span>La clave se verifica antes de guardarla, sin generar mensajes ni consumir tokens.</span>
        </div>
        {models.length > 0 && <div className="remote-steps">
          <strong><Icon name="sparkle" /> Modelo del agente</strong>
          <label htmlFor="account-model">Elegí el modelo que querés usar</label>
          <select id="account-model" className="input" value={modelKey(model)} onChange={(event) => {
            const selected = models.find((m) => modelKey(m) === event.target.value)
            if (selected) setModel({ providerID: selected.providerID, modelID: selected.modelID })
          }}>
            {models.map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}
          </select>
        </div>}
        {onboarding && <button type="button" className="btn btn-primary btn-lg" disabled={!canContinue || savingKey || !!starting || !!flow} onClick={onContinue}><Icon name="arrow-right" /> Continuar con GuilleCode</button>}
        {onboarding && !canContinue && !modelsError && <p className="remote-text">Conectá al menos un proveedor para continuar.</p>}
        <ProviderList />
        <div className="remote-note">
          <Icon name="info" />
          <span>
            La sesión queda guardada en el opencode de esta PC, así que también la usan el celular, las rutinas y opencode en la terminal. Los audios del celular siguen necesitando una API key de OpenAI
            o Groq: la suscripción no incluye la API de transcripción.
          </span>
        </div>
      </section>
    </div>
  )
}
