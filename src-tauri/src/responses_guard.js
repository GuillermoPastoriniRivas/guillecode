// Runs inside Flufy's engine, so desktop, PWA and routines use the same
// transport protection. Do not turn a truncated Responses stream into a finish.
import { createProviderDiagnostics } from "./provider-diagnostics.js"
import { budgetChatGPTRequest } from "./responses-budget.js"

const installed = Symbol.for("guillecode.responses.guard")

function terminalFailure(code, message, responseHeaders) {
  const events = [
    { type: "response.created", response: { id: "guillecode-transport-error", model: "unknown", created_at: 0 } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "guillecode-transport-error", role: "assistant", content: [], status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "guillecode-transport-error", output_index: 0, content_index: 0, delta: "" },
    { type: "response.failed", sequence_number: 1, response: { error: { code, message } } },
  ]
  const headers = new Headers(responseHeaders)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("content-type", "text/event-stream")
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers })
}

function interrupted() {
  const error = new Error("La respuesta se interrumpió antes de recibir su final. Se conservó el contenido parcial. Reintentá para continuar desde el historial.")
  error.name = "ResponsesInterruptedError"
  return error
}

function protect(response, signal, diagnostic) {
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
        diagnostic?.event(event, terminal)
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
          diagnostic?.chunk(next.value)
          observe(decoder.decode(next.value, { stream: true }))
          controller.enqueue(next.value)
          return
        }
        observe(decoder.decode())
        if (buffer === "\r") line("")
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
        if (!terminal) { diagnostic?.finish("eof_without_terminal"); fail(controller); return }
        controller.close()
      } catch (error) {
        diagnostic?.error(signal?.aborted || error?.name === "AbortError" ? "aborted" : "stream_error", error, signal)
        if (signal?.aborted || error?.name === "AbortError") controller.error(error)
        else if (terminal) controller.close()
        else fail(controller)
        await reader.cancel(error).catch(() => undefined)
      }
    },
    cancel(reason) { diagnostic?.finish(signal?.aborted ? "aborted" : "consumer_cancelled"); return reader.cancel(reason) },
  }, { highWaterMark: 0 })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}

async function bufferFailure(response) {
  if (response.status !== 507) return response
  const body = await response.clone().text()
  if (!/exceeded request buffer limit while retrying upstream|request_payload_exceeded_retry_buffer_limit/i.test(body)) return response
  // The SDK retries every 5xx before exposing it to the UI. Bridge this known
  // non-recoverable replay into a terminal Responses error, preserving its real
  // status and body. This is a failed generation, never a successful finish.
  // Enter the streaming phase without adding visible content. The pinned SDK
  // treats a failure before any output as another retryable API call error.
  void response.body?.cancel().catch(() => undefined)
  return terminalFailure("guillecode_upstream_buffer_limit", `HTTP 507: ${body}`, response.headers)
}

export const FlufyResponses = async (_input, options = {}) => {
  if (globalThis[installed]) return {}
  globalThis[installed] = true
  const diagnostics = createProviderDiagnostics(options.diagnosticsPath, { appVersion: options.appVersion })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    if (method.toUpperCase() !== "POST" || !url.pathname.endsWith("/responses")) return original(input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (url.origin === "https://chatgpt.com") {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
      const body = typeof init?.body === "string" ? init.body
        : input instanceof Request && init?.body === undefined ? await input.clone().text() : null
      if (body !== null) {
        const bounded = budgetChatGPTRequest(body)
        if (bounded !== body) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          headers.delete("content-length")
          init = { ...init, headers, body: bounded }
        }
      }
    }
    const diagnostic = diagnostics?.begin(input, init)
    let response
    try { response = await original(input, init) }
    catch (error) { diagnostic?.error(signal?.aborted ? "aborted" : "transport_error", error, signal); throw error }
    diagnostic?.headers(response)
    if (!response.ok) { diagnostic?.httpError(response); return bufferFailure(response) }
    if (
        !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      diagnostic?.finish("http_ok_non_stream")
      return response
    }
    return protect(response, signal, diagnostic)
  }
  return {}
}
