const MINUTE = 60
const HOUR = 3600
const DAY = 86400
const MONTH = DAY * 30
const YEAR = DAY * 365

export function timeAgo(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000))
  if (s < 45) return "recién"
  if (s < HOUR) return `hace ${Math.max(1, Math.round(s / MINUTE))} min`
  if (s < DAY) return `hace ${Math.round(s / HOUR)} h`
  if (s < MONTH) {
    const d = Math.round(s / DAY)
    return d === 1 ? "ayer" : `hace ${d} días`
  }
  if (s < YEAR) {
    const m = Math.round(s / MONTH)
    return m === 1 ? "hace un mes" : `hace ${m} meses`
  }
  const y = Math.round(s / YEAR)
  return y === 1 ? "hace un año" : `hace ${y} años`
}

export function shortAgo(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000))
  if (s < MINUTE) return "ahora"
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m`
  if (s < DAY) return `${Math.floor(s / HOUR)}h`
  if (s < MONTH) return `${Math.floor(s / DAY)}d`
  if (s < YEAR) return `${Math.floor(s / MONTH)}mes`
  return `${Math.floor(s / YEAR)}a`
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function clockTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
  if (d.toDateString() === new Date().toDateString()) return hm
  return `${d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })} ${hm}`
}
