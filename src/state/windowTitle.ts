import { projectName } from "../lib/paths"
import { useProject } from "./project"
import { featureTitle, findFeature, useFeatures } from "./features"
import { setBaseTitle } from "./attention"

function compute(): string {
  const { project, root } = useProject.getState()
  if (!project) return "GuilleCode"
  const feature = findFeature(root, useFeatures.getState().list)
  const name = projectName(project)
  return feature && feature.kind !== "main" ? `${name} · ${featureTitle(feature)} — GuilleCode` : `${name} — GuilleCode`
}

let started = false
let last = ""

export function startWindowTitle(): void {
  if (started) return
  started = true
  const apply = () => {
    const next = compute()
    if (next === last) return
    last = next
    setBaseTitle(next)
  }
  apply()
  useProject.subscribe(apply)
  useFeatures.subscribe(apply)
}
