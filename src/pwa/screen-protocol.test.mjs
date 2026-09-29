import { test } from "node:test"
import assert from "node:assert/strict"
import { ScreenPackets, screenPoint } from "./screen-protocol.ts"

function packet(kind, seq, data) {
  const bytes = new Uint8Array(9 + data.length)
  const header = new DataView(bytes.buffer)
  header.setUint8(0, kind)
  header.setUint32(1, seq)
  header.setUint32(5, data.length)
  bytes.set(data, 9)
  return bytes
}

test("fetch chunk boundaries may split every byte or combine several frames", () => {
  const first = packet(2, 257, new Uint8Array([0, 0, 0, 1, 0x67]))
  const second = packet(6, 257, new Uint8Array())
  const all = new Uint8Array([...first, ...second])
  for (let size = 1; size <= all.length; size++) {
    const parser = new ScreenPackets()
    const result = []
    for (let i = 0; i < all.length; i += size) result.push(...parser.push(all.slice(i, i + size)))
    assert.deepEqual(result, [
      { kind: 2, seq: 257, data: new Uint8Array([0, 0, 0, 1, 0x67]) },
      { kind: 6, seq: 257, data: new Uint8Array() },
    ])
  }
})

test("reject malformed frame sizes before buffering their payload", () => {
  const header = packet(1, 1, new Uint8Array())
  new DataView(header.buffer).setUint32(5, 16 * 1024 * 1024 + 1)
  assert.throws(() => new ScreenPackets().push(header), /inválido/)
  assert.throws(() => new ScreenPackets().push(packet(7, 1, new Uint8Array())), /inválido/)
})

test("letterboxing never becomes a remote click", () => {
  const rect = { left: 10, top: 20, width: 300, height: 300 }
  assert.equal(screenPoint(160, 30, rect, 1600, 1000), null)
  assert.deepEqual(screenPoint(160, 170, rect, 1600, 1000), { x: 0.5, y: 0.5 })
  assert.equal(screenPoint(9, 170, rect, 1600, 1000), null)
  assert.equal(screenPoint(160, 170, rect, 0, 1000), null)
  assert.deepEqual(screenPoint(160, 170, rect, 1000, 1600), { x: 0.5, y: 0.5 })
})

// El zoom del visor es una transformación CSS uniforme (scale + translate) sobre el
// canvas, así que getBoundingClientRect devuelve el rectángulo escalado. screenPoint
// debe seguir mapeando bien: un punto visible bajo el dedo tiene que dar la misma
// coordenada normalizada antes y después de zoomear.
test("zoom by uniform scale+translate keeps the tap mapping", () => {
  const base = { left: 0, top: 0, width: 800, height: 500 }
  const zoomed = { s: 2.5, tx: 40, ty: -30 }
  const cx = base.left + base.width / 2
  const cy = base.top + base.height / 2
  const at = (u) => ({
    left: cx + zoomed.tx + (base.left - cx) * zoomed.s,
    top: cy + zoomed.ty + (base.top - cy) * zoomed.s,
    width: base.width * zoomed.s,
    height: base.height * zoomed.s,
  })
  for (const u of [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.25 }]) {
    const plain = { left: base.left + u.x * base.width, top: base.top + u.y * base.height }
    const r = at(u)
    const zoomPoint = { left: r.left + u.x * r.width, top: r.top + u.y * r.height }
    // El mismo punto de la imagen da la misma coordenada normalizada sin zoom y con zoom.
    assert.deepEqual(screenPoint(plain.left, plain.top, base, 1600, 1000), { x: u.x, y: u.y })
    assert.deepEqual(screenPoint(zoomPoint.left, zoomPoint.top, r, 1600, 1000), { x: u.x, y: u.y })
  }
})
