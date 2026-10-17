import type { Skill, Employee } from "./types"

export const skillProfiles = [
  { role: "Lead", name: "Team Lead", skills: ["team-lead", "comportamientos"] },
  { role: "Frontend", name: "Frontend", skills: ["frontend", "security"] },
  { role: "Backend", name: "Backend", skills: ["backend", "security"] },
  { role: "Full Stack", name: "Full Stack", skills: ["frontend", "backend", "security"] },
  { role: "GraphQL", name: "GraphQL", skills: ["graphql", "backend"] },
  { role: "QA", name: "QA y evidencias", skills: ["qa", "comportamientos"] },
  { role: "Code Review", name: "Code Review", skills: ["review", "security"] },
  { role: "Database", name: "Database", skills: ["database", "security"] },
  { role: "AWS", name: "AWS", skills: ["aws", "security"] },
  { role: "DevOps", name: "DevOps", skills: ["devops", "docker"] },
  { role: "Docker", name: "Docker", skills: ["docker"] },
  { role: "Git Integration", name: "Git Integration", skills: ["git-integration"] },
] as const

export function profileSkills(role: string, skills: Skill[]): Employee["skillRefs"] {
  const profile = skillProfiles.find((p) => p.role.toLowerCase() === role.toLowerCase())
  return skills.filter((s) => profile?.skills.some((id) => id === s.id) && !skills.some((v) => v.id === s.id && v.version > s.version)).map((s) => ({ id: s.id, version: s.version }))
}

export function applySkillProfile(employee: Employee, role: string, skills: Skill[]): Employee {
  const refs = new Map(employee.skillRefs.map((s) => [s.id, s]))
  for (const s of profileSkills(role, skills)) refs.set(s.id, s)
  return { ...employee, role, skillRefs: [...refs.values()], tools: role === "Code Review" ? employee.tools.filter((t) => !["edit", "write", "apply_patch"].includes(t)) : employee.tools }
}
