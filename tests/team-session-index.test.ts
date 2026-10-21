import assert from "node:assert/strict"
import { test } from "node:test"
import type { Session } from "@opencode-ai/sdk"
import type { TeamChatRecord } from "../src/team/types.ts"
import { groupTeamSessions, indexTeamSessions, isTeamSession } from "../src/team/session-index.ts"

const session = (id: string, title = id, parentID?: string) => ({ id, title, parentID } as Session)
const chat = (id: string) => ({ id, title: "Mismo nombre", messages: [{ sessionId: `${id}-conversation` }], runs: [{ planSessionId: `${id}-plan`, closingSessions: [`${id}-close`], coordination: [{ sessions: [`${id}-help`] }], tasks: [{ attempts: [{ sessionId: `${id}-worker`, reviewSessionId: `${id}-review` }, { sessionId: `${id}-retry`, reviewSessionId: null }] }] }] } as TeamChatRecord)

test("agrupa por identidad todas las sesiones e intentos aunque se renombren o compartan nombre", () => {
  const chats = [chat("one"), chat("two")]
  indexTeamSessions(chats)
  const one = ["conversation", "plan", "close", "help", "worker", "review", "retry"].map(name => session(`one-${name}`, "Renombrada"))
  const two = session("two-worker")
  const normal = session("normal", "Mi chat")
  const grouped = groupTeamSessions([normal, ...one, two], chats)
  assert.deepEqual(grouped.normal, [normal])
  assert.equal(grouped.groups.length, 2)
  assert.deepEqual(grouped.groups[0].sessions, one)
  assert.equal(grouped.groups[0].chat?.id, "one")
  assert.equal(grouped.groups[1].chat?.id, "two")
  assert.equal(isTeamSession("one-retry"), true)
  indexTeamSessions([])
  assert.equal(isTeamSession("one-retry"), false)
})

test("incluye descendientes con ancestros fuera del filtro y conserva sesiones normales y legadas", () => {
  const parent = session("one-worker")
  const child = session("child", "Nested", parent.id)
  const grandchild = session("grandchild", "Child", child.id)
  const normal = session("normal", "Equipo de ventas")
  const legacy = session("legacy", "Equipo · Viejo · plan")
  const cycle = session("cycle", "Normal", "cycle")
  const grouped = groupTeamSessions([grandchild, normal, legacy, cycle], [chat("one")], [parent, child, grandchild, normal, legacy, cycle])
  assert.deepEqual(grouped.normal, [normal, cycle])
  assert.deepEqual(grouped.groups.map(g => g.sessions.map(s => s.id)), [["grandchild"], ["legacy"]])
  assert.equal(grouped.groups[0].chat?.id, "one")
  assert.equal(grouped.groups[1].chat, undefined)
})
