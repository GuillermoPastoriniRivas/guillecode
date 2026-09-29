export type FuzzyMatch = {
  score: number
  positions: number[]
}

const BOUNDARY_CHARS = new Set(["/", "\\", "_", "-", ".", " ", ":"])
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 10
const BONUS_CAMEL = 8
const BONUS_CONSECUTIVE = 6
const BONUS_FIRST_CHAR = 12
const BONUS_BASENAME = 14
const PENALTY_GAP_START = -3
const PENALTY_GAP_EXTENSION = -1

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase()
}

function charBonus(target: string, i: number): number {
  if (i === 0) return BONUS_FIRST_CHAR
  const prev = target[i - 1]
  if (BOUNDARY_CHARS.has(prev)) return BONUS_BOUNDARY
  if (isUpper(target[i]) && !isUpper(prev)) return BONUS_CAMEL
  return 0
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] }
  const q = query.toLowerCase().replace(/\s+/g, "")
  if (!q) return { score: 0, positions: [] }
  const t = target.toLowerCase()
  let qi = 0
  let end = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++
      if (qi === q.length) end = ti
    }
  }
  if (end === -1) return null
  const positions: number[] = new Array(q.length)
  qi = q.length - 1
  for (let ti = end; ti >= 0 && qi >= 0; ti--) {
    if (t[ti] === q[qi]) {
      positions[qi] = ti
      qi--
    }
  }
  const baseStart = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")) + 1
  let score = 0
  for (let k = 0; k < positions.length; k++) {
    const pos = positions[k]
    score += SCORE_MATCH + charBonus(target, pos)
    if (pos >= baseStart) score += BONUS_BASENAME
    if (k > 0) {
      const gap = pos - positions[k - 1] - 1
      if (gap === 0) score += BONUS_CONSECUTIVE
      else score += PENALTY_GAP_START + PENALTY_GAP_EXTENSION * Math.min(gap, 20)
    }
  }
  if (target.toLowerCase().endsWith(q)) score += 20
  if (target.slice(baseStart).toLowerCase().startsWith(q)) score += 25
  score -= Math.min(target.length, 120) * 0.15
  return { score, positions }
}

export type Ranked<T> = { item: T; match: FuzzyMatch }

export function rankFuzzy<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
  limit = 60,
): Ranked<T>[] {
  if (!query.trim()) return items.slice(0, limit).map((item) => ({ item, match: { score: 0, positions: [] } }))
  const out: Ranked<T>[] = []
  for (const item of items) {
    const match = fuzzyMatch(query, key(item))
    if (match) out.push({ item, match })
  }
  out.sort((a, b) => b.match.score - a.match.score)
  return out.slice(0, limit)
}

export function highlightSegments(text: string, positions: number[]): Array<{ text: string; hit: boolean }> {
  if (positions.length === 0) return [{ text, hit: false }]
  const set = new Set(positions)
  const out: Array<{ text: string; hit: boolean }> = []
  let current = ""
  let currentHit = set.has(0)
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i)
    if (hit !== currentHit && current) {
      out.push({ text: current, hit: currentHit })
      current = ""
    }
    currentHit = hit
    current += text[i]
  }
  if (current) out.push({ text: current, hit: currentHit })
  return out
}
