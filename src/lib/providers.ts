// OpenCode is the engine; its paid providers are optional accounts.
export const SUPPORTED_PROVIDERS = ["openai", "opencode", "opencode-go"] as const
export const EMPTY_MODEL = { providerID: "", modelID: "" }

export type ProviderAccount = { id: string; source?: string; options?: { apiKey?: unknown } }
export type AvailableModel = { providerID: string; modelID: string }
export type ModelCost = { input?: number; output?: number }

export const ZEN = "opencode"

export function hasAccount(p: ProviderAccount): boolean {
  return SUPPORTED_PROVIDERS.some((id) => id === p.id) &&
    p.options?.apiKey !== "public" &&
    (p.source === "api" || p.source === "env" || !!p.options?.apiKey)
}

export function isFreeModel(id: string, cost?: ModelCost): boolean {
  if (/-free$/.test(id)) return true
  return !!cost && (cost.input ?? 0) === 0 && (cost.output ?? 0) === 0
}

export function modelVisible(model: { providerID: string; modelID: string; cost?: ModelCost }, zenFreeOnly: boolean): boolean {
  if (!zenFreeOnly || model.providerID !== ZEN) return true
  return isFreeModel(model.modelID, model.cost)
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
