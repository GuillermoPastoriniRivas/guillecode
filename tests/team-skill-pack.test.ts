import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"

test("OpenCode pack has 13 unique valid SKILL.md files matching the embedded catalog", async () => {
  const catalog = JSON.parse(await readFile(".opencode/skills/catalog.json", "utf8")) as {id: string; slug: string; version: number; verificationGuidelines: string[]}[]
  assert.equal(catalog.length, 13); assert.equal(new Set(catalog.map((s) => s.id)).size, 13)
  for (const skill of catalog) {
    assert.match(skill.slug, /^[a-z]+(?:-[a-z]+)*$/)
    const source = await readFile(`.opencode/skills/${skill.slug}/SKILL.md`, "utf8")
    assert.ok(source.startsWith(`---\nname: ${skill.slug}\n`) || source.startsWith(`---\r\nname: ${skill.slug}\r\n`))
    assert.match(source, /compatibility: opencode/); assert.match(source, /Contrato de Flufy/)
    assert.ok(skill.verificationGuidelines.length >= 2)
    assert.ok(source.includes("permisos") && source.includes("QA manual"))
  }
  const reviewer = await readFile(".opencode/skills/code-reviewer/SKILL.md", "utf8")
  assert.match(reviewer, /changes_requested/); assert.ok(!reviewer.includes('"verdict": "rejected"'))
  const frontend = await readFile(".opencode/skills/frontend/SKILL.md", "utf8")
  assert.match(frontend, /respuestas obsoletas/); assert.match(frontend, /también en servidor/)
  const backend = await readFile(".opencode/skills/backend/SKILL.md", "utf8")
  assert.match(backend, /constraints y transacciones/)
})
