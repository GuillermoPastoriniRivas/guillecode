import { useEffect, useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { call, errorMessage } from "../lib/tauri"
import { Segmented } from "../components/fields"
import { Icon } from "../components/ui"
import { notify } from "../state/toasts"

type VoiceView = { baseUrl: string; model: string; language: string; keyHint: string | null; ready: boolean }

type Provider = "openai" | "groq" | "custom"

const PRESETS: Record<Exclude<Provider, "custom">, { baseUrl: string; models: string[]; keys: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"], keys: "https://platform.openai.com/api-keys" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", models: ["whisper-large-v3-turbo", "whisper-large-v3"], keys: "https://console.groq.com/keys" },
}

function providerOf(baseUrl: string): Provider {
  const clean = baseUrl.trim().replace(/\/+$/, "")
  if (clean === PRESETS.openai.baseUrl) return "openai"
  if (clean === PRESETS.groq.baseUrl) return "groq"
  return "custom"
}

export function VoiceSettings() {
  const [saved, setSaved] = useState<VoiceView | null>(null)
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  const [language, setLanguage] = useState("es")
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState<"save" | "test" | null>(null)

  useEffect(() => {
    call<VoiceView>("voice_get")
      .then((v) => {
        setSaved(v)
        setBaseUrl(v.baseUrl || PRESETS.openai.baseUrl)
        setModel(v.model || PRESETS.openai.models[0])
        setLanguage(v.baseUrl ? v.language : "es")
      })
      .catch((e) => notify.error("No se pudo leer la configuración de audios", errorMessage(e)))
  }, [])

  const provider = providerOf(baseUrl)
  const suggestions = provider === "custom" ? [] : PRESETS[provider].models

  const pickProvider = (next: Provider) => {
    if (next === "custom") {
      if (provider !== "custom") setBaseUrl("")
      return
    }
    setBaseUrl(PRESETS[next].baseUrl)
    if (!PRESETS[next].models.includes(model)) setModel(PRESETS[next].models[0])
  }

  const persist = async () => {
    const view = await call<VoiceView>("voice_set", { baseUrl, model, language, apiKey: apiKey.trim() ? apiKey : null })
    setSaved(view)
    setApiKey("")
    return view
  }

  const save = async () => {
    setBusy("save")
    try {
      const view = await persist()
      notify.info("Audios configurados", view.ready ? "El celular ya muestra el botón del micrófono." : "Falta la URL base o el modelo.")
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
      notify.info("La transcripción responde", `${model} en ${baseUrl} aceptó un audio de prueba.`)
    } catch (e) {
      notify.error("La prueba falló", errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (!saved) return null

  return (
    <div className="remote-steps voice-settings">
      <strong>
        <Icon name="mic" /> Audios desde el celular
      </strong>
      <span>
        El celular graba, esta PC lo transcribe con un servicio compatible con la API de OpenAI (<code>/audio/transcriptions</code>) y el texto queda en el mensaje para que lo revises antes de mandarlo. La
        clave nunca sale de esta PC.
      </span>
      <div className="voice-grid">
        <span className="voice-label">Servicio</span>
        <Segmented<Provider>
          value={provider}
          onChange={pickProvider}
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "groq", label: "Groq" },
            { value: "custom", label: "Otro" },
          ]}
        />
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
        <span className="voice-label">Idioma</span>
        <input className="input input-sm voice-lang" value={language} placeholder="vacío = detectar" spellCheck={false} onChange={(e) => setLanguage(e.target.value)} />
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
      </div>
      <div className="form-row">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void save()}>
          <Icon name={busy === "save" ? "loading" : "save"} /> Guardar
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null || !baseUrl.trim() || !model.trim()} onClick={() => void test()}>
          <Icon name={busy === "test" ? "loading" : "beaker"} /> Probar
        </button>
        <span className={`routine-pill ${saved.ready ? "ok" : ""}`}>{saved.ready ? "Activo" : "Sin configurar"}</span>
      </div>
    </div>
  )
}
