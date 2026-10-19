import assert from "node:assert/strict"
import { test } from "node:test"
import { applySkillProfile, profileSkills } from "../src/team/profiles.ts"
import type { Employee, Skill } from "../src/team/types.ts"

const skills = ["frontend", "backend", "security", "review", "team-lead", "comportamientos"].flatMap((id) => [1, 2].map((version): Skill => ({ id, version, name: id, description: id, instructions: id, verificationGuidelines: [id] })))
const employee: Employee = { id: "a", name: "A", role: "Custom", model: { providerID: "p", modelID: "m" }, variant: "high", skillRefs: [{ id: "custom", version: 7 }], instructions: "Keep me", tools: ["read", "edit", "write", "apply_patch", "bash"], maxConcurrentTasks: 1 }
test("profiles combine relevant latest skills and preserve custom selections/model/instructions", () => {
  assert.deepEqual(profileSkills("Frontend", skills).map((s) => s.id), ["frontend", "security"])
  const configured = applySkillProfile(employee, "Backend", skills)
  assert.deepEqual(configured.skillRefs, [{ id: "custom", version: 7 }, { id: "backend", version: 2 }, { id: "security", version: 2 }])
  assert.equal(configured.model, employee.model); assert.equal(configured.instructions, employee.instructions)
  assert.equal(applySkillProfile(configured, "Backend", skills).skillRefs.length, 3)
  assert.deepEqual(profileSkills("Lead", skills).map((s) => s.id), ["team-lead", "comportamientos"])
})
test("review profile removes code editing without granting extra tools", () => {
  const configured = applySkillProfile(employee, "Code Review", skills)
  assert.deepEqual(configured.tools, ["read", "bash"])
  assert.deepEqual(employee.tools, ["read", "edit", "write", "apply_patch", "bash"])
})
