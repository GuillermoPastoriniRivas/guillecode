import { call } from "./tauri"

export type SearchQuery = {
  root: string
  query: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  include: string
  exclude: string
  maxResults?: number
}

export type LineMatch = { line: number; col: number; colEnd: number; text: string; ranges: [number, number][] }
export type FileMatches = { path: string; matches: LineMatch[] }
export type SearchResult = { files: FileMatches[]; total: number; truncated: boolean; searched: number }

export function searchText(query: SearchQuery): Promise<SearchResult> {
  return call<SearchResult>("search_text", { query })
}

export function replaceInFiles(query: SearchQuery, replacement: string, paths: string[]) {
  return call<{ files: number; replacements: number }>("search_replace", { request: { query, replacement, paths } })
}
