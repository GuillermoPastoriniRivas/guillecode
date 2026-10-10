// Runs inside GuilleCode's engine, so desktop, PWA and routines use the same
// transport protection. Do not turn a truncated Responses stream into a finish.
const installed = Symbol.for("guillecode.responses.guard")

function interrupted() {
  const error = new Error("La respuesta se interrumpió antes de recibir su final. Se conservó el contenido parcial. Reintentá para continuar desde el historial.")
  error.name = "ResponsesInterruptedError"
  return error
}

function protect(response, signal) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = "", data = [], terminal = false
  const fail = (controller) => {
    // Queue a terminal error in the same byte stream. controller.error() would
    // discard queued deltas in the SDK's transforms and lose the partial text.
    const event = { type: "response.failed", sequence_number: 0, response: {
      error: { code: "guillecode_interrupted_stream", message: interrupted().message },
    } }
    controller.enqueue(new TextEncoder().encode(`\n\ndata: ${JSON.stringify(event)}\n\n`))
    controller.close()
  }
  const line = (value) => {
    if (value === "") {
      if (!data.length) return
      try {
        const event = JSON.parse(data.join("\n"))
        const result = event.response
        // Match the terminal shapes consumed by the pinned Responses SDK.
        if ((event.type === "response.completed" || event.type === "response.incomplete") &&
            typeof result?.usage?.input_tokens === "number" && typeof result?.usage?.output_tokens === "number") terminal = true
        if (event.type === "response.failed" && typeof event.sequence_number === "number" && result &&
            (result.error == null || typeof result.error.message === "string")) terminal = true
      } catch { /* Malformed data is handled by the provider parser. */ }
      data = []
    } else if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /, ""))
    }
  }
  const observe = (text) => {
    buffer += text
    // Support CR, LF and CRLF, including CRLF split between network chunks.
    let start = 0
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== "\n" && buffer[i] !== "\r") continue
      if (buffer[i] === "\r" && i === buffer.length - 1) break
      line(buffer.slice(start, i))
      if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++
      start = i + 1
    }
    buffer = buffer.slice(start)
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
        if (terminal) {
          controller.close()
          await reader.cancel().catch(() => undefined)
          return
        }
        const next = await reader.read()
        if (!next.done) {
          observe(decoder.decode(next.value, { stream: true }))
          controller.enqueue(next.value)
          return
        }
        observe(decoder.decode())
        if (buffer === "\r") line("")
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
        if (!terminal) { fail(controller); return }
        controller.close()
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") controller.error(error)
        else if (terminal) controller.close()
        else fail(controller)
        await reader.cancel(error).catch(() => undefined)
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  }, { highWaterMark: 0 })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}

export const GuilleCodeResponses = async () => {
  if (globalThis[installed]) return {}
  globalThis[installed] = true
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init)
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    if (method.toUpperCase() !== "POST" || !url.pathname.endsWith("/responses") || !response.ok ||
        !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response
    return protect(response, init?.signal ?? (input instanceof Request ? input.signal : undefined))
  }
  return {}
}
