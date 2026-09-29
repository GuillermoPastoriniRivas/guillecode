export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} M`
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString("es-AR")} k`
  return n.toLocaleString("es-AR")
}

export function formatUsd(n: number): string {
  return `US$ ${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`
}
