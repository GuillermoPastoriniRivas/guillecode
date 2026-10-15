import { createHash, randomUUID } from "node:crypto"
import { appendFile, rename, stat, unlink } from "node:fs/promises"

const bytes = (value) => typeof value === "string" ? Buffer.byteLength(value) : 0
const hash = (value) => createHash("sha256").update(value).digest("hex")
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : undefined
const numbers = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([, n]) => typeof n === "number" && Number.isFinite(n)))
const selectedHeaders = ["content-type", "server", "date", "cf-ray", "x-request-id", "request-id", "openai-processing-ms", "retry-after", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"]

function payload(body) {
  // The pinned SDK sends a JSON string. Never consume a Request/stream to log it.
  if (typeof body !== "string") return { bodyKind: body == null ? "unavailable" : "opaque" }
  const result = { bodyKind: "string", requestBytes: bytes(body), payloadHash: hash(body) }
  let value
  try { value = JSON.parse(body) } catch { return { ...result, json: false } }
  result.json = true
  result.model = identifier(value?.model)
  result.reasoningEffort = identifier(value?.reasoning?.effort)
  result.cacheKeyHash = typeof value?.prompt_cache_key === "string" ? hash(value.prompt_cache_key) : undefined
  result.cacheSessionID = /^ses_[a-zA-Z0-9]+$/.test(value?.prompt_cache_key ?? "") ? value.prompt_cache_key : undefined
  result.instructionsBytes = bytes(value?.instructions)
  result.tools = Array.isArray(value?.tools) ? value.tools.length : 0
  result.toolSchemaBytes = bytes(JSON.stringify(value?.tools ?? []))
  const input = Array.isArray(value?.input) ? value.input : []
  result.inputItems = input.length
  result.messages = result.functionCalls = result.functionResults = result.textBytes = result.toolResultBytes = result.images = result.imageURLBytes = 0
  for (const item of input) {
    if (item?.role) result.messages++
    if (item?.type === "function_call") result.functionCalls++
    if (item?.type === "function_call_output") {
      result.functionResults++
      result.toolResultBytes += bytes(typeof item.output === "string" ? item.output : JSON.stringify(item.output))
    }
    if (typeof item?.content === "string") result.textBytes += bytes(item.content)
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      result.textBytes += bytes(part?.text)
      if (part?.type === "input_image") {
        result.images++
        result.imageURLBytes += bytes(part.image_url)
      }
    }
  }
  return result
}

function errorInfo(error, signal) {
  return { errorName: identifier(error?.name), causeCode: identifier(error?.cause?.code ?? error?.code), aborted: !!signal?.aborted }
}

async function failureInfo(response) {
  const reader = response.body?.getReader()
  if (!reader) return {}
  let content = "", observed = 0, truncated = false
  const decoder = new TextDecoder()
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 1000) })
  try {
    while (observed < 4096) {
      const next = await Promise.race([reader.read(), timeout])
      if (next.timeout) { truncated = true; break }
      if (next.done) break
      const chunk = next.value.subarray(0, 4096 - observed)
      observed += chunk.byteLength
      content += decoder.decode(chunk, { stream: true })
      if (chunk.byteLength < next.value.byteLength || observed === 4096) truncated = true
    }
    content += decoder.decode()
    let code
    try { const body = JSON.parse(content); code = identifier(body?.error?.code ?? body?.code) } catch { /* Plain proxy errors. */ }
    // Do not persist arbitrary error text: providers can echo prompt contents.
    const failureClass = /exceeded request buffer limit|request_payload_exceeded_retry_buffer_limit/i.test(content) ? "upstream_buffer_limit"
      : /upstream connect error|disconnect\/reset before headers/i.test(content) ? "upstream_connection_failure"
      : /usage limit|rate.limit/i.test(content) ? "usage_limit" : "unclassified"
    return { failureClass, providerErrorCode: code, remoteConnectionFailure: /reset reason: remote connection failure/i.test(content), errorBytesObserved: observed, errorTruncated: truncated }
  } finally { clearTimeout(timer); void reader.cancel().catch(() => undefined) }
}

export function createProviderDiagnostics(path, { appVersion, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!path) return undefined
  const runID = randomUUID(), attempts = new Map()
  let queue = Promise.resolve(), queued = 0, warned = false, active = 0
  const warn = () => {
    if (warned) return
    warned = true
    console.warn("[guillecode] No se pudo guardar parte del diagnóstico del proveedor")
  }
  const emit = (record) => {
    if (queued >= 256) { warn(); return }
    const line = JSON.stringify({ schema: 1, time: new Date().toISOString(), runID, appVersion: identifier(appVersion), runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`, ...record }) + "\n"
    queued++
    queue = queue.then(async () => {
      const size = await stat(path).then((s) => s.size).catch((e) => { if (e.code !== "ENOENT") throw e; return 0 })
      if (size + bytes(line) > maxBytes) {
        await unlink(`${path}.2`).catch((e) => { if (e.code !== "ENOENT") throw e })
        await rename(`${path}.1`, `${path}.2`).catch((e) => { if (e.code !== "ENOENT") throw e })
        await rename(path, `${path}.1`).catch((e) => { if (e.code !== "ENOENT") throw e })
      }
      await appendFile(path, line, { mode: 0o600 })
    }).catch(warn).finally(() => { queued-- })
  }
  return {
    flush: () => queue,
    begin(input, init) {
      try {
        const url = new URL(input instanceof Request ? input.url : input)
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        const summary = payload(init?.body)
        const sessionID = /^ses_[a-zA-Z0-9]+$/.test(headers.get("session-id") ?? "") ? headers.get("session-id") : summary.cacheSessionID
        const engineVersion = /opencode\/([0-9][0-9A-Za-z.+-]{0,40})/.exec(headers.get("user-agent") ?? "")?.[1]
        const key = `${sessionID ?? ""}:${summary.payloadHash ?? randomUUID()}`
        const attempt = (attempts.get(key) ?? 0) + 1
        attempts.delete(key); attempts.set(key, attempt)
        if (attempts.size > 128) attempts.delete(attempts.keys().next().value)
        const requestID = randomUUID(), started = performance.now()
        const base = { requestID, sessionID, endpoint: `${url.origin}${url.pathname}`, samePayloadAttempt: attempt }
        let done = false, firstByteMs, firstEventMs, receivedBytes = 0, events = 0, lastEventType, responseID, status, responseHeaders
        const elapsed = () => Math.round(performance.now() - started)
        active++
        emit({ ...base, phase: "request", engineVersion, concurrentRequests: active, ...summary })
        const finish = (outcome, extra = {}) => {
          if (done) return
          done = true; active--
          emit({ ...base, phase: "finish", outcome, elapsedMs: elapsed(), status, responseHeaders, firstByteMs, firstEventMs, receivedBytes, events, lastEventType, responseID, ...extra })
        }
        return {
          headers(response) {
            status = response.status
            responseHeaders = Object.fromEntries(selectedHeaders.filter((key) => response.headers.has(key)).map((key) => [key, response.headers.get(key).slice(0, 200)]))
            emit({ ...base, phase: "headers", headersMs: elapsed(), status, responseHeaders })
          },
          chunk(value) { firstByteMs ??= elapsed(); receivedBytes += value.byteLength },
          event(value, terminal) {
            firstEventMs ??= elapsed(); events++
            lastEventType = identifier(value?.type)
            responseID = identifier(value?.response?.id) ?? responseID
            if (terminal) finish(value.type, { usage: numbers(value.response?.usage), cache: numbers(value.response?.usage?.input_tokens_details), providerErrorCode: identifier(value.response?.error?.code), incompleteReason: identifier(value.response?.incomplete_details?.reason) })
          },
          httpError(response) {
            finish("http_error")
            try {
              void failureInfo(response.clone()).then((info) => emit({ ...base, phase: "http_error_detail", ...info })).catch(() => undefined)
            } catch { /* Diagnostics must never change the fetch result. */ }
          },
          finish,
          error(outcome, error, signal) { finish(outcome, errorInfo(error, signal)) },
        }
      } catch { warn(); return undefined }
    },
  }
}
