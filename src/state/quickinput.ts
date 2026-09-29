import { create } from "zustand"

export type QuickItem = {
  id: string
  label: string
  description?: string
  detail?: string
  icon?: string
  iconColor?: string
  keys?: string
  group?: string
  groupFavorites?: boolean
  favorite?: boolean
  onToggleFavorite?: () => void
  run?: () => void | Promise<void>
}

type PickerRequest = {
  kind: "pick"
  title?: string
  placeholder?: string
  items: QuickItem[]
  favorites?: boolean
  resolve: (item: QuickItem | null) => void
}

type InputRequest = {
  kind: "input"
  title?: string
  placeholder?: string
  prompt?: string
  value?: string
  validate?: (value: string) => string | null
  resolve: (value: string | null) => void
}

type QuickState = {
  open: boolean
  value: string
  request: PickerRequest | InputRequest | null
  nonce: number
}

export const useQuickInput = create<QuickState>(() => ({ open: false, value: "", request: null, nonce: 0 }))

function cancelPending() {
  const req = useQuickInput.getState().request
  if (req?.kind === "pick") req.resolve(null)
  if (req?.kind === "input") req.resolve(null)
}

export function showQuickOpen(prefix = ""): void {
  cancelPending()
  useQuickInput.setState((s) => ({ open: true, value: prefix, request: null, nonce: s.nonce + 1 }))
}

export function closeQuickInput(): void {
  cancelPending()
  useQuickInput.setState({ open: false, request: null, value: "" })
}

export function pickOne(
  items: QuickItem[],
  opts: { title?: string; placeholder?: string; favorites?: boolean } = {},
): Promise<QuickItem | null> {
  cancelPending()
  return new Promise((resolve) => {
    useQuickInput.setState((s) => ({
      open: true,
      value: "",
      nonce: s.nonce + 1,
      request: { kind: "pick", items, title: opts.title, placeholder: opts.placeholder, favorites: opts.favorites, resolve },
    }))
  })
}

export function promptInput(opts: {
  title?: string
  placeholder?: string
  prompt?: string
  value?: string
  validate?: (value: string) => string | null
}): Promise<string | null> {
  cancelPending()
  return new Promise((resolve) => {
    useQuickInput.setState((s) => ({
      open: true,
      value: opts.value ?? "",
      nonce: s.nonce + 1,
      request: { kind: "input", ...opts, resolve },
    }))
  })
}

export function resolvePick(item: QuickItem | null): void {
  const req = useQuickInput.getState().request
  useQuickInput.setState({ open: false, request: null, value: "" })
  if (req?.kind === "pick") req.resolve(item)
}

export function resolveInput(value: string | null): void {
  const req = useQuickInput.getState().request
  useQuickInput.setState({ open: false, request: null, value: "" })
  if (req?.kind === "input") req.resolve(value)
}
