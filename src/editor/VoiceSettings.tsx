import { useEffect, useState } from "react"
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import { call, errorMessage, onEvent } from "../lib/tauri"
import { Segmented } from "../components/fields"
import { Icon } from "../components/ui"
import { notify } from "../state/toasts"

type VoiceView = { kind: string; baseUrl: string; model: string; language: string; localModel: string; keyHint: string | null; ready: boolean }

type ModelView = { size: string; present: boolean; bytes: number; totalBytes: number; downloading: boolean; error: string | null }
type WhisperView = { available: boolean; running: boolean; port: number | null; defaultSize: string; modelsDir: string | null; models: ModelView[] }

type Provider = "openai" | "groq" | "custom" | "local"

const PRESETS: Record<Exclude<Provider, "custom" | "local">, { baseUrl: string; models: string[]; keys: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"], keys: "https://platform.openai.com/api-keys" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", models: ["whisper-large-v3-turbo", "whisper-large-v3"], keys: "https://console.groq.com/keys" },
}

const SIZE_ORDER = ["base", "small", "medium", "large-v3-turbo"]
const SIZE_LABEL: Record<string, string> = { base: "Base", small: "Small", medium: "Medium", "large-v3-turbo": "Large Turbo" }
const SIZE_NOTE: Record<string, string> = {
  base: "~141 MB · la más rápida",
  small: "~465 MB · recomendada",
  medium: "~1,4 GB · más precisa",
  "large-v3-turbo": "~1,5 GB · máxima precisión",
}

function providerOf(view: VoiceView): Provider {
  if (view.kind === "local") return "local"
  const clean = view.baseUrl.trim().replace(/\/+$/, "")
  if (clean === PRESETS.openai.baseUrl) return "openai"
  if (clean === PRESETS.groq.baseUrl) return "groq"
  return "custom"
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(bytes > 100_000_000 ? 0 : 1)} MB`
}

export function VoiceSettings() {
  const [saved, setSaved] = useState<VoiceView | null>(null)
  const [provider, setProvider] = useState<Provider>("openai")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  const [language, setLanguage] = useState("es")
  const [localModel, setLocalModel] = useState("small")
  const [apiKey, setApiKey] = useState("")
  const [whisper, setWhisper] = useState<WhisperView | null>(null)
  const [busy, setBusy] = useState<"save" | "test" | null>(null)

  const refreshWhisper = () => {
    void call<WhisperView>("whisper_status")
      .then(setWhisper)
      .catch(() => setWhisper(null))
  }

  useEffect(() => {
    call<VoiceView>("voice_get")
      .then((v) => {
        setSaved(v)
        setProvider(providerOf(v))
        setBaseUrl(v.baseUrl || PRESETS.openai.baseUrl)
        setModel(v.model || PRESETS.openai.models[0])
        setLanguage(v.baseUrl ? v.language : "es")
        setLocalModel(v.localModel || "small")
      })
      .catch((e) => notify.error("No se pudo leer la configuración de audios", errorMessage(e)))
    refreshWhisper()
    return onEvent<{ size: string; received?: number; total?: number; done?: boolean; error?: string; cancelled?: boolean }>("whisper:download", (p) => {
      setWhisper((prev) =>
        prev
          ? {
              ...prev,
              models: prev.models.map((m) =>
                m.size === p.size
                  ? {
                      ...m,
                      downloading: !p.done && !p.error && !p.cancelled,
                      error: p.error ?? null,
                      present: p.done ? true : m.present,
                      bytes: p.done ? m.totalBytes : (p.received ?? m.bytes),
                    }
                  : m,
              ),
            }
          : prev,
      )
      if (p.done || p.error || p.cancelled) refreshWhisper()
    })
  }, [])

  const suggestions = provider === "custom" || provider === "local" ? [] : PRESETS[provider].models
  const selected = whisper?.models.find((m) => m.size === localModel)

  const pickProvider = (next: Provider) => {
    setProvider(next)
    if (next === "custom") {
      setBaseUrl("")
      return
    }
    if (next === "local") return
    setBaseUrl(PRESETS[next].baseUrl)
    if (!PRESETS[next].models.includes(model)) setModel(PRESETS[next].models[0])
  }

  const persist = async () => {
    const view = await call<VoiceView>("voice_set", {
      kind: provider === "local" ? "local" : "cloud",
      baseUrl: provider === "local" ? "" : baseUrl,
      model: provider === "local" ? "" : model,
      language,
      localModel,
      apiKey: apiKey.trim() ? apiKey : null,
    })
    setSaved(view)
    setApiKey("")
    return view
  }

  const save = async () => {
    setBusy("save")
    try {
      const view = await persist()
      notify.info("Voz configurada", view.ready ? "El micrófono ya está disponible en el celular y en la app." : "Falta completar la configuración.")
    } catch (e) {
      notify.error("No se pudo guardar", errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy("test")
    try {
      await persist()
      await call("voice_test")
      notify.info("La transcripción responde", provider === "local" ? `Whisper local (${SIZE_LABEL[localModel] ?? localModel}) aceptó un audio de prueba.` : `${model} en ${baseUrl} aceptó un audio de prueba.`)
    } catch (e) {
      notify.error("La prueba falló", errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const download = async () => {
    try {
      await call("whisper_download", { size: localModel })
      refreshWhisper()
    } catch (e) {
      notify.error("No se pudo descargar el modelo", errorMessage(e))
    }
  }

  const cancelDownload = async () => {
    try {
      await call("whisper_cancel")
    } catch (e) {
      notify.error("No se pudo cancelar la descarga", errorMessage(e))
    }
  }

  const removeModel = async () => {
    try {
      await call("whisper_delete_model", { size: localModel })
      refreshWhisper()
    } catch (e) {
      notify.error("No se pudo eliminar el modelo", errorMessage(e))
    }
  }

  if (!saved) return null

  return (
    <div className="remote-steps voice-settings">
      <strong>
        <Icon name="mic" /> Voz y audios
      </strong>
      <span>
        El micrófono del celular y de la app graba, esta PC transcribe y el texto aparece en el chat. Podés usar un servicio en la nube compatible con la API de OpenAI, o <b>Whisper local</b> (sin
        costo y sin que el audio salga de tu equipo).
      </span>
      <div className="voice-grid">
        <span className="voice-label">Servicio</span>
        <Segmented<Provider>
          value={provider}
          onChange={pickProvider}
          options={[
            { value: "local", label: "Esta PC" },
            { value: "openai", label: "OpenAI" },
            { value: "groq", label: "Groq" },
            { value: "custom", label: "Otro" },
          ]}
        />
        {provider === "local" ? (
          <>
            <span className="voice-label">Modelo</span>
            <div className="voice-model">
              {SIZE_ORDER.map((s) => {
                const present = whisper?.models.find((m) => m.size === s)?.present
                return (
                  <button key={s} type="button" className={`chip-btn${s === localModel ? " active" : ""}`} onClick={() => setLocalModel(s)} title={SIZE_NOTE[s]}>
                    {SIZE_LABEL[s]}
                    {present ? " ✓" : ""}
                  </button>
                )
              })}
            </div>
            <span className="voice-label">Estado</span>
            <div className="voice-local-status">
              {whisper && !whisper.available ? (
                <span className="warn-text">El motor de Whisper no está instalado en esta PC.</span>
              ) : selected?.error ? (
                <span className="warn-text">{selected.error}</span>
              ) : selected?.present ? (
                <>
                  <span className="routine-pill ok">Descargado ({megabytes(selected.bytes)})</span>
                  <button type="button" className="btn btn-sm" onClick={() => void removeModel()}>
                    <Icon name="trash" /> Eliminar
                  </button>
                </>
              ) : selected?.downloading ? (
                <>
                  <span className="voice-progress">
                    <span className="voice-progress-track">
                      <span className="voice-progress-bar" style={{ width: `${selected.totalBytes ? Math.min(100, (selected.bytes / selected.totalBytes) * 100) : 0}%` }} />
                    </span>
                    <small>
                      Descargando {megabytes(selected.bytes)} de {megabytes(selected.totalBytes)}
                    </small>
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => void cancelDownload()}>
                    <Icon name="close" /> Cancelar
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-sm" disabled={!whisper?.available} onClick={() => void download()}>
                  <Icon name="cloud-download" /> Descargar {SIZE_LABEL[localModel]} ({megabytes(selected?.totalBytes ?? 0)})
                </button>
              )}
              <small className="muted">{SIZE_NOTE[localModel]}</small>
            </div>
          </>
        ) : (
          <>
            <span className="voice-label">URL base</span>
            <input className="input input-sm" value={baseUrl} placeholder="http://localhost:8000/v1" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
            <span className="voice-label">Modelo</span>
            <div className="voice-model">
              <input className="input input-sm" value={model} placeholder="whisper-1" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
              {suggestions.map((m) => (
                <button key={m} type="button" className={`chip-btn${m === model ? " active" : ""}`} onClick={() => setModel(m)}>
                  {m}
                </button>
              ))}
            </div>
            <span className="voice-label">API key</span>
            <div className="voice-model">
              <input
                className="input input-sm"
                type="password"
                value={apiKey}
                autoComplete="off"
                placeholder={saved.keyHint ? `Guardada (${saved.keyHint})` : provider === "custom" ? "Opcional" : "Pegá la clave"}
                title={saved.keyHint ? "Para cambiarla, pegá otra y guardá" : undefined}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {provider !== "custom" && (
                <button type="button" className="btn btn-sm" onClick={() => void openUrl(PRESETS[provider].keys)}>
                  <Icon name="link-external" /> Conseguir clave
                </button>
              )}
            </div>
          </>
        )}
        <span className="voice-label">Idioma</span>
        <input className="input input-sm voice-lang" value={language} placeholder="vacío = detectar" spellCheck={false} onChange={(e) => setLanguage(e.target.value)} />
      </div>
      {provider === "local" && whisper?.modelsDir && (
        <button type="button" className="voice-folder" onClick={() => void revealItemInDir(whisper.modelsDir as string)} title="Abrir la carpeta donde se guardan los modelos">
          <Icon name="folder-opened" /> {whisper.modelsDir}
        </button>
      )}
      <div className="form-row">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void save()}>
          <Icon name={busy === "save" ? "loading" : "save"} /> Guardar
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== null || (provider === "local" ? !selected?.present : !baseUrl.trim() || !model.trim())}
          onClick={() => void test()}
        >
          <Icon name={busy === "test" ? "loading" : "beaker"} /> Probar
        </button>
        <span className={`routine-pill ${saved.ready ? "ok" : ""}`}>{saved.ready ? "Activo" : "Sin configurar"}</span>
      </div>
    </div>
  )
}
