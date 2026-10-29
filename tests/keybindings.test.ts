import assert from "node:assert/strict"
import test from "node:test"

import { matchesKey } from "../src/commands/registry.ts"

type KeyInit = {
  key: string
  code: string
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

const ev = (init: KeyInit) => ({
  key: init.key,
  code: init.code,
  ctrlKey: init.ctrlKey ?? false,
  shiftKey: init.shiftKey ?? false,
  altKey: init.altKey ?? false,
  metaKey: init.metaKey ?? false,
}) as unknown as KeyboardEvent

test("zoom in responde al + del bloque numérico", () => {
  const e = ev({ key: "+", code: "NumpadAdd", ctrlKey: true })
  assert.equal(matchesKey(e, "ctrl+="), true)
  assert.equal(matchesKey(e, "ctrl+shift+="), true)
})

test("zoom in responde al + del teclado principal en layout es-LA", () => {
  // En Latin America el + sale sin Shift en la tecla Equal y * con Shift.
  assert.equal(matchesKey(ev({ key: "+", code: "Equal", ctrlKey: true }), "ctrl+="), true)
  assert.equal(matchesKey(ev({ key: "*", code: "Equal", ctrlKey: true, shiftKey: true }), "ctrl+="), true)
})

test("zoom out responde al - del teclado principal y del numérico", () => {
  assert.equal(matchesKey(ev({ key: "-", code: "Minus", ctrlKey: true }), "ctrl+-"), true)
  assert.equal(matchesKey(ev({ key: "-", code: "NumpadSubtract", ctrlKey: true }), "ctrl+-"), true)
  assert.equal(matchesKey(ev({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }), "ctrl+-"), true)
})

test("sin Ctrl los atajos de zoom no se disparan solos", () => {
  assert.equal(matchesKey(ev({ key: "=", code: "Equal" }), "ctrl+="), false)
  assert.equal(matchesKey(ev({ key: "+", code: "NumpadAdd" }), "ctrl+="), false)
  assert.equal(matchesKey(ev({ key: "-", code: "Minus" }), "ctrl+-"), false)
})

test("las letras siguen exigiendo los modificadores exactos", () => {
  assert.equal(matchesKey(ev({ key: "p", code: "KeyP", ctrlKey: true, shiftKey: true }), "ctrl+shift+p"), true)
  assert.equal(matchesKey(ev({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }), "ctrl+p"), false)
  assert.equal(matchesKey(ev({ key: "b", code: "KeyB", ctrlKey: true }), "ctrl+b"), true)
  assert.equal(matchesKey(ev({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }), "ctrl+b"), false)
})
