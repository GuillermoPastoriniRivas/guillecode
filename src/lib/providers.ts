// OpenCode is the engine; its paid providers are optional accounts.
export const SUPPORTED_PROVIDERS = ["openai", "opencode", "opencode-go"] as const
export const EMPTY_MODEL = { providerID: "", modelID: "" }

export type ProviderAccount = { id: string; source?: string; options?: { apiKey?: unknown } }
export type AvailableModel = { providerID: string; modelID: string }

export function hasAccount(p: ProviderAccount): boolean {
  return SUPPORTED_PROVIDERS.some((id) => id === p.id) &&
    p.options?.apiKey !== "public" &&
    (p.source === "api" || p.source === "env" || !!p.options?.apiKey)
}

export function chooseAvailableModel<T extends AvailableModel>(models: T[], current: AvailableModel, favorites: string[] = []): AvailableModel {
  const key = (m: AvailableModel) => `${m.providerID}/${m.modelID}`
  const next = models.find((m) => key(m) === key(current)) ??
    models.find((m) => favorites.includes(key(m))) ?? models[0]
  return next ? { providerID: next.providerID, modelID: next.modelID } : { ...EMPTY_MODEL }
}

export function modelAvailable(models: AvailableModel[], model: AvailableModel): boolean {
  return models.some((m) => m.providerID === model.providerID && m.modelID === model.modelID)
}
