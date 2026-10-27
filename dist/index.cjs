"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  APIError: () => APIError,
  ActivityTracker: () => ActivityTracker,
  AppsService: () => AppsService,
  AssetsService: () => AssetsService,
  BrowserAuth: () => BrowserAuth,
  Client: () => RunApps,
  FilesRemote: () => FilesRemote,
  RealtimeSession: () => RealtimeSession,
  RunApps: () => RunApps,
  RunJobs: () => RunApps,
  SDKEvents: () => SDKEvents,
  ServerTools: () => ServerTools,
  SyncEngine: () => SyncEngine,
  acceptsField: () => acceptsField,
  acceptsModality: () => acceptsModality,
  allowedValuesFor: () => allowedValuesFor,
  appOriginFrom: () => appOriginFrom,
  appSlugOf: () => appSlugOf,
  assistantMessage: () => assistantMessage,
  audioPart: () => audioPart,
  base64ToBytes: () => base64ToBytes2,
  bytesToBase64: () => bytesToBase64,
  decodeHandoff: () => decodeHandoff,
  decodeMediaUrl: () => decodeMediaUrl,
  defaultModel: () => defaultModel,
  defaultVoice: () => defaultVoice,
  encodeHandoff: () => encodeHandoff,
  encodeImageUrl: () => encodeImageUrl,
  float32FromPCM16: () => float32FromPCM16,
  getOptionsSchema: () => getOptionsSchema,
  hasCapabilityTag: () => hasCapabilityTag,
  imagePart: () => imagePart,
  installIndexedDBHook: () => installIndexedDBHook,
  isAppOrigin: () => isAppOrigin,
  isFilesURL: () => isFilesURL,
  newRequestId: () => newRequestId,
  parseHandoffPayload: () => parseHandoffPayload,
  pcm16FromFloat32: () => pcm16FromFloat32,
  requiresField: () => requiresField,
  supportsInstructText: () => supportsInstructText,
  supportsVoiceClone: () => supportsVoiceClone,
  systemMessage: () => systemMessage,
  textPart: () => textPart,
  toolResultMessage: () => toolResultMessage,
  userMessage: () => userMessage,
  userMessageParts: () => userMessageParts,
  validateRequest: () => validateRequest,
  videoPart: () => videoPart
});
module.exports = __toCommonJS(src_exports);

// src/errors.ts
var APIError = class extends Error {
  constructor(statusCode, type, message, code, retryAfter) {
    super(`runapps: ${statusCode} ${type}: ${message}`);
    __publicField(this, "statusCode");
    __publicField(this, "type");
    /** The body's machine-readable `code` when it has one, e.g. "busy",
     *  "feature_not_enabled" (assets.verify). */
    __publicField(this, "code");
    /** Seconds to wait before retrying, from a 429's `retry_after` or
     *  `Retry-After`. */
    __publicField(this, "retryAfter");
    this.name = "APIError";
    this.statusCode = statusCode;
    this.type = type;
    if (code !== void 0) this.code = code;
    if (retryAfter !== void 0) this.retryAfter = retryAfter;
  }
};

// src/transport.ts
var Transport = class {
  constructor(opts) {
    __publicField(this, "baseURL");
    __publicField(this, "apiKey");
    __publicField(this, "apiKeyResolver");
    __publicField(this, "onUnauthorized");
    __publicField(this, "fetchImpl");
    if (!opts.apiKey && !opts.apiKeyResolver) {
      throw new Error(
        "RunApps: pass either `apiKey` or `apiKeyResolver` when constructing the client"
      );
    }
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.apiKeyResolver = opts.apiKeyResolver;
    this.onUnauthorized = opts.onUnauthorized;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }
  /** Absolute URLs pass through; paths are joined to the base. The files
   *  service uses this to send file calls to the files host. */
  resolve(path) {
    return /^https?:\/\//i.test(path) ? path : this.baseURL + path;
  }
  /** A short, non-secret fingerprint of the current token, so a service
   *  can notice that the signed-in user changed and drop per-user state
   *  (the files base is derived from the user). */
  async tokenFingerprint() {
    const t = await this.resolveToken();
    if (!t) return "";
    let h = 0;
    for (let i = 0; i < t.length; i++) h = h * 31 + t.charCodeAt(i) | 0;
    return (h >>> 0).toString(36) + ":" + t.length;
  }
  /** Resolve the bearer token for the next request. */
  async resolveToken() {
    if (this.apiKeyResolver) return await this.apiKeyResolver();
    return this.apiKey ?? "";
  }
  /** The current bearer token, for connections fetch can't make (WebSocket). */
  bearerToken() {
    return this.resolveToken();
  }
  /**
   * Wrap a fetch call with single-attempt 401 retry.  `build` produces a
   * fresh RequestInit each call (so headers can re-resolve a fresh token,
   * and bodies can be re-streamed for retry).  On 401, invokes
   * `onUnauthorized()` (giving the caller a chance to invalidate cached
   * auth state) then retries once with a fresh init.  No retry if
   * `onUnauthorized` is absent or already retried.
   */
  async fetchWithAuthRetry(path, build) {
    const url = this.resolve(path);
    let resp = await this.fetchImpl(url, await this.buildInit(build));
    if (resp.status !== 401 || !this.onUnauthorized) return resp;
    try {
      await this.onUnauthorized();
    } catch {
      return resp;
    }
    resp = await this.fetchImpl(url, await this.buildInit(build));
    return resp;
  }
  /**
   * Every request goes out uncacheable.
   *
   * Our identity lives in the Authorization header, never in the URL — so
   * two different apps calling e.g. `/v1/files/projects/index.json` hit the
   * *same* URL with different tokens.  The browser's HTTP cache doesn't key
   * on request headers, and it is partitioned by the top-level registrable
   * domain, which every `*.runapps.dev` bundle shares.  One cacheable
   * response was therefore enough for app A to read app B's file and then
   * save it back as its own.  The server no longer marks these cacheable;
   * this is the client-side half of that fix, and it also protects bundles
   * pinned to an older backend.
   */
  async buildInit(build) {
    const init = await build();
    return init.cache ? init : { ...init, cache: "no-store" };
  }
  /** POST JSON body; parse JSON response. */
  async postJSON(path, body, init) {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "POST",
      headers: await this.jsonHeaders(),
      body: JSON.stringify(body),
      signal: init?.signal
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return await resp.json();
  }
  /** GET path; parse JSON response. */
  async getJSON(path, init) {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "GET",
      headers: await this.authHeaders(),
      signal: init?.signal
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return await resp.json();
  }
  /** GET a public path: no Authorization header, so it never fetches a
   *  token — in browser sign-in mode that would send a signed-out user to
   *  the sign-in page just to read the model catalogue. */
  async getPublicJSON(path, init) {
    const resp = await this.fetchImpl(this.resolve(path), {
      method: "GET",
      cache: "no-store",
      ...init?.signal ? { signal: init.signal } : {}
    });
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return await resp.json();
  }
  /** GET path; return raw bytes + content-type (for video/audio downloads)
   *  and the ETag of those bytes, when the server sends one. */
  async getRaw(path, init) {
    const resp = await this.fetchWithAuthRetry(path, async () => {
      const headers = await this.authHeaders();
      if (init?.ifNoneMatch) headers["If-None-Match"] = `"${cleanETag(init.ifNoneMatch)}"`;
      return { method: "GET", headers, signal: init?.signal };
    });
    const serverTime = parseServerDate(resp.headers.get("date"));
    if (resp.status === 304) {
      const etag2 = cleanETag(resp.headers.get("etag")) || init?.ifNoneMatch;
      return { data: new Uint8Array(0), contentType: "", etag: etag2, notModified: true, serverTime };
    }
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const contentType = resp.headers.get("content-type") ?? "";
    const etag = cleanETag(resp.headers.get("etag")) || void 0;
    return { data: buf, contentType, etag, serverTime };
  }
  /** POST a multipart/form-data body. Used by audio.transcribe and image.edit. */
  async postMultipart(path, form, init) {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "POST",
      headers: await this.authHeaders(),
      // do NOT set Content-Type — fetch sets it with boundary
      body: form,
      signal: init?.signal
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return await resp.json();
  }
  /**
   * POST JSON body; return the raw streaming Response. Used by chat
   * streaming. Caller is responsible for consuming the SSE body.
   */
  async postJSONStream(path, body, init) {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "POST",
      headers: {
        ...await this.jsonHeaders(),
        "Accept-Encoding": "identity"
        // SSE lines arrive immediately, no gzip
      },
      body: JSON.stringify(body),
      signal: init?.signal
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return resp;
  }
  /** PUT raw bytes with caller-supplied content type and headers. */
  async putBytes(path, body, opts) {
    const resp = await this.fetchWithAuthRetry(path, async () => {
      const headers = {
        ...await this.authHeaders(),
        "Content-Type": opts?.contentType ?? "application/octet-stream"
      };
      const size = bodyByteLength(body);
      if (size !== void 0) headers["X-Content-Length"] = String(size);
      if (opts?.headers) Object.assign(headers, opts.headers);
      return {
        method: "PUT",
        headers,
        body,
        signal: opts?.signal
      };
    });
    if (!resp.ok) throw await this.parseError(resp);
    if (opts?.parse === "none") return void 0;
    return await resp.json();
  }
  /** DELETE path; parse JSON response (or no body). */
  async deletePath(path, init) {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "DELETE",
      headers: await this.authHeaders(),
      signal: init?.signal
    }));
    if (!resp.ok) throw await this.parseError(resp);
    if (init?.parse === "none") return void 0;
    return await resp.json();
  }
  /** HEAD path; surface status + selected response headers.  Used by
   *  exists / stat where the body would just be an opaque blob. */
  async head(path, init) {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "HEAD",
      headers: await this.authHeaders(),
      signal: init?.signal
    }));
    return { status: resp.status, headers: resp.headers };
  }
  async jsonHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await this.resolveToken()}`
    };
  }
  async authHeaders() {
    return { Authorization: `Bearer ${await this.resolveToken()}` };
  }
  async parseError(resp) {
    const text = await resp.text();
    let type = "error";
    let message = text || resp.statusText;
    let code;
    let retryAfter;
    try {
      const parsed = JSON.parse(text);
      if (parsed.type) type = parsed.type;
      if (parsed.message) message = parsed.message;
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.retry_after === "number") retryAfter = parsed.retry_after;
    } catch {
    }
    const header = Number(resp.headers.get("Retry-After"));
    if (retryAfter === void 0 && header > 0) retryAfter = header;
    return new APIError(resp.status, type, message, code, retryAfter);
  }
};
function cleanETag(raw) {
  return (raw ?? "").trim().replace(/^W\//i, "").replace(/"/g, "");
}
function parseServerDate(h) {
  if (!h) return void 0;
  const t = Date.parse(h);
  return Number.isNaN(t) ? void 0 : t;
}
function bodyByteLength(body) {
  if (typeof body === "string") {
    return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(body).byteLength : void 0;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return void 0;
}

// src/events.ts
var SDKEvents = class {
  constructor() {
    __publicField(this, "handlers", /* @__PURE__ */ new Map());
  }
  /**
   * Subscribe to an event. Returns a disposer; calling the disposer
   * removes the subscription. Multiple subscriptions to the same
   * event are supported.
   */
  on(name, handler) {
    let set = this.handlers.get(name);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.handlers.set(name, set);
    }
    const wrapped = handler;
    set.add(wrapped);
    return () => {
      this.handlers.get(name)?.delete(wrapped);
    };
  }
  /**
   * Fire an event. Handlers run synchronously in subscription order.
   * Throws inside one handler don't prevent the others from running —
   * the bus catches and logs (console.error) so a buggy listener can't
   * take down the rest of the UI.
   */
  emit(name, payload) {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        console.error("[runapps sdk] event listener for", name, "threw:", err);
      }
    }
  }
  /** Drop all subscriptions. Tests call this between cases. */
  clear() {
    this.handlers.clear();
  }
};
function newRequestId() {
  return "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// src/event-wrap.ts
async function wrapEvents(events, meta, fn, extractEnd) {
  const id = newRequestId();
  const startedAt = Date.now();
  events.emit("request:start", {
    id,
    model: meta.model,
    capability: meta.capability,
    startedAt,
    streaming: false
  });
  try {
    const result = await fn();
    const info = extractEnd ? extractEnd(result) : {};
    events.emit("request:end", {
      id,
      model: meta.model,
      capability: meta.capability,
      latencyMs: Date.now() - startedAt,
      totalTokens: info.totalTokens ?? 0,
      ...info.costUSD !== void 0 && { costUSD: info.costUSD },
      ...info.finishReason !== void 0 && { finishReason: info.finishReason }
    });
    return result;
  } catch (err) {
    const e = err;
    events.emit("request:error", {
      id,
      model: meta.model,
      capability: meta.capability,
      latencyMs: Date.now() - startedAt,
      error: e,
      ...typeof e.statusCode === "number" && { statusCode: e.statusCode }
    });
    throw err;
  }
}
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}
async function* wrapStream(events, meta, source, extractDelta) {
  const id = newRequestId();
  const startedAt = Date.now();
  events.emit("request:start", {
    id,
    model: meta.model,
    capability: meta.capability,
    startedAt,
    streaming: true
  });
  let totalTokens = 0;
  let lastUsageTokens;
  let costUSD;
  let finishReason;
  try {
    for await (const chunk of source()) {
      const info = extractDelta(chunk);
      if (info.deltaText) {
        const delta = estimateTokens(info.deltaText);
        totalTokens += delta;
        events.emit("request:streamDelta", {
          id,
          deltaTokens: delta,
          totalTokens
        });
      }
      if (info.completionTokens !== void 0) lastUsageTokens = info.completionTokens;
      if (info.costUSD !== void 0) costUSD = info.costUSD;
      if (info.finishReason !== void 0) finishReason = info.finishReason;
      yield chunk;
    }
    events.emit("request:end", {
      id,
      model: meta.model,
      capability: meta.capability,
      latencyMs: Date.now() - startedAt,
      // Prefer the exact upstream count over our heuristic when it
      // arrived in the final chunk.
      totalTokens: lastUsageTokens ?? totalTokens,
      ...costUSD !== void 0 && { costUSD },
      ...finishReason !== void 0 && { finishReason }
    });
  } catch (err) {
    const e = err;
    events.emit("request:error", {
      id,
      model: meta.model,
      capability: meta.capability,
      latencyMs: Date.now() - startedAt,
      error: e,
      ...typeof e.statusCode === "number" && { statusCode: e.statusCode }
    });
    throw err;
  }
}

// src/chat.ts
var ServerTools = {
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  TwitterSearch: "twitter_search"
};
var userMessage = (content) => ({ role: "user", content });
var systemMessage = (content) => ({ role: "system", content });
var assistantMessage = (content) => ({ role: "assistant", content });
var toolResultMessage = (toolCallId, content) => ({ role: "tool", tool_call_id: toolCallId, content });
var userMessageParts = (...parts) => ({ role: "user", content: parts });
var textPart = (text) => ({ type: "text", text });
var imagePart = (url, detail) => ({
  type: "image_url",
  image_url: detail ? { url, detail } : { url }
});
var videoPart = (url) => ({
  type: "video_url",
  video_url: { url }
});
var audioPart = (url) => ({
  type: "audio_url",
  audio_url: { url }
});
var ChatService = class {
  constructor(transport, events) {
    __publicField(this, "transport", transport);
    __publicField(this, "events", events);
  }
  /**
   * Create a chat completion (non-streaming).
   *
   * Streaming is forced off — pass `stream()` instead for incremental output.
   */
  async create(params, init) {
    const body = { ...params, stream: false };
    return wrapEvents(
      this.events,
      { model: params.model, capability: "text" },
      () => this.transport.postJSON(
        "/v1/chat/completions",
        body,
        init
      ),
      (r) => ({
        totalTokens: r.usage?.completion_tokens,
        costUSD: r.usage?.total_cost,
        finishReason: r.choices?.[0]?.finish_reason
      })
    );
  }
  /**
   * Create a streaming chat completion. Returns an async iterator over
   * `ChatCompletionChunk`. The final chunk carries `usage` (token / cost
   * totals) — `stream_options.include_usage` is set automatically.
   *
   * ```ts
   * let cost = 0;
   * for await (const chunk of client.chat.stream({ ... })) {
   *   for (const c of chunk.choices) process.stdout.write(c.delta.content ?? "");
   *   if (chunk.usage) cost = chunk.usage.total_cost;
   * }
   * ```
   *
   * Also fires `request:streamDelta` on `client.events` for each chunk
   * that carried text — drives the badge's tokens/sec rate display.
   */
  async *stream(params, init) {
    const body = {
      ...params,
      stream: true,
      stream_options: params.stream_options ?? { include_usage: true }
    };
    const sourceGen = async function* () {
      const resp = await this.transport.postJSONStream(
        "/v1/chat/completions",
        body,
        init
      );
      if (!resp.body) {
        throw new Error("runapps: streaming response had no body");
      }
      yield* parseSSE(resp.body);
    }.bind(this);
    yield* wrapStream(
      this.events,
      { model: params.model, capability: "text" },
      sourceGen,
      (chunk) => ({
        deltaText: chunk.choices?.[0]?.delta?.content ?? "",
        completionTokens: chunk.usage?.completion_tokens,
        costUSD: chunk.usage?.total_cost,
        finishReason: chunk.choices?.[0]?.finish_reason ?? void 0
      })
    );
  }
};
async function* parseSSE(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done: done2 } = await reader.read();
      if (done2) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        if (!data) continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          throw new Error(
            `runapps: decode stream chunk: ${e.message}`
          );
        }
        const err = parsed.error;
        if (err) {
          throw new APIError(
            err.code ?? 0,
            err.type ?? "upstream_error",
            err.message ?? data
          );
        }
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// src/models.ts
var hasCapabilityTag = (model, id) => Array.isArray(model.capability_tags) && model.capability_tags.some((t) => t.id === id);
var acceptsModality = (model, modality) => Array.isArray(model.input_modalities) && model.input_modalities.includes(modality);
function optBool(model, key) {
  const v = model.options?.[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return false;
}
var supportsVoiceClone = (model) => optBool(model, "supports_voice_clone");
var supportsInstructText = (model) => optBool(model, "supports_instruct_text");
var defaultVoice = (model) => {
  const v = model.options?.["default_voice"];
  return typeof v === "string" ? v : null;
};
var defaultModel = (models, capability) => {
  const pool = capability ? models.filter((m) => m.capability === capability) : models;
  return pool.find((m) => m.is_default) ?? null;
};
var ModelsService = class {
  constructor(transport) {
    __publicField(this, "transport", transport);
  }
  /**
   * List models available on the gateway. Pass `{ capability: "..." }` to
   * filter server-side. Needs no sign-in or key.
   */
  async list(opts = {}, init) {
    let path = "/v1/models";
    if (opts.capability) {
      path += `?capability=${encodeURIComponent(opts.capability)}`;
    }
    const resp = await this.transport.getPublicJSON(path, init);
    return resp.data;
  }
  /**
   * The platform's default model for a capability (`"text"` unless given):
   * the admin-starred one, else the first. What a request without `model`
   * would use before the user's own preference. Null when the capability
   * has no models.
   */
  async default(capability = "text", init) {
    return defaultModel(await this.list({ capability }, init), capability);
  }
};

// src/image.ts
var ImageService = class {
  constructor(transport, events) {
    __publicField(this, "transport", transport);
    __publicField(this, "events", events);
  }
  /** What `generate(model, params)` (or `generateAsync`) would cost, without running it. */
  async quote(model, params, init) {
    const r = await this.transport.postJSON(
      "/v1/quote/images/generations",
      { model, ...params },
      init
    );
    return r.quote;
  }
  /**
   * Generate images from a text prompt via the synchronous endpoint.
   * For long-running requests (large Seedream batches, slow upstreams)
   * use `generateAsync()` to avoid 100-second origin timeouts.
   */
  async generate(model, params, init) {
    return wrapEvents(
      this.events,
      { model, capability: "image_generation" },
      () => this.transport.postJSON(
        "/v1/images/generations",
        { model, ...params },
        init
      ),
      (r) => ({ costUSD: r.usage?.total_cost })
    );
  }
  /**
   * Async equivalent of `generate()`. Submits a job to
   * `/v1/async/images/generations`, polls `/v1/async/images/generations/:id`
   * until terminal, then resolves to a sync-shape `ImageResponse`. Use
   * this when a request may exceed the ~100s origin timeout (Cloudflare
   * otherwise replaces the real upstream error with its own 502 page).
   *
   * Implementation is `submitGenerate` + `getAsyncStatus` poll loop, so
   * the path layout matches the rest of the async API (`/v1/async/...`
   * everywhere). The caller's `signal` aborts both the submit and the
   * poll wait; `pollIntervalMs` defaults to 2s.
   */
  async generateAsync(model, params, init) {
    const interval = init?.pollIntervalMs ?? 2e3;
    const signal = init?.signal;
    return wrapEvents(
      this.events,
      { model, capability: "image_generation" },
      async () => {
        const job = await this.transport.postJSON(
          "/v1/async/images/generations",
          { model, ...params },
          { signal }
        );
        let current = job;
        while (current.status !== "succeeded" && current.status !== "failed") {
          await sleep(interval, signal);
          current = await this.getAsyncStatus(current.id, { signal });
        }
        if (current.status === "failed") {
          throw new Error(current.error ?? "image generation failed");
        }
        return {
          created: current.created_at ?? Math.floor(Date.now() / 1e3),
          data: current.data ?? [],
          usage: current.usage ?? { total_cost: 0 }
        };
      },
      (r) => ({ costUSD: r.usage?.total_cost })
    );
  }
  /**
   * Submit-only variant of `generate()`. Returns the gateway's job
   * descriptor (`id`, `status`, `usage`) without polling. Use this
   * when you want to PERSIST the job id and resume polling later
   * (e.g. across page reloads, in a separate worker process). Pair
   * with `getAsyncStatus(id)` to drive the polling loop yourself.
   *
   * For a one-shot "submit and wait" call site, use `generateAsync()`
   * — that wraps the same underlying endpoint with a built-in poll.
   *
   * Telemetry note: only the SUBMIT step fires start/end on
   * `client.events` — the per-call latency reflects the gateway
   * accepting the job, NOT how long the upstream takes to render.
   * Track render progress via your own poll loop's status responses.
   */
  async submitGenerate(model, params, init) {
    return wrapEvents(
      this.events,
      { model, capability: "image_generation" },
      () => this.transport.postJSON(
        "/v1/async/images/generations",
        { model, ...params },
        init
      )
    );
  }
  /**
   * Single poll of an in-flight async image job. Returns the same
   * shape `submitGenerate()` returned, with `data[]` populated once
   * `status` flips to `succeeded`. Caller decides cadence + bail-out;
   * the gateway's per-poll `current_time` / `created_at` together
   * give a server-truth elapsed reading regardless of client clock skew.
   */
  async getAsyncStatus(id, init) {
    return this.transport.getJSON(
      `/v1/async/images/generations/${encodeURIComponent(id)}`,
      init
    );
  }
  /**
   * Edit an image (inpaint / outpaint / variations) via multipart upload.
   * Provider-dependent — only available on `gpt-image-1` and similar.
   */
  async edit(model, params, init) {
    const form = buildEditForm(model, params);
    return wrapEvents(
      this.events,
      { model, capability: "image_edit" },
      () => this.transport.postMultipart(
        "/v1/images/edits",
        form,
        init
      ),
      (r) => ({ costUSD: r.usage?.total_cost })
    );
  }
};
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function buildEditForm(model, params) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", typeof params.prompt === "string" ? params.prompt : JSON.stringify(params.prompt));
  if (params.size) form.set("size", params.size);
  if (params.n !== void 0) form.set("n", String(params.n));
  if (params.user) form.set("user", params.user);
  form.set("image", toBlob(params.image), params.image.filename);
  if (params.mask) form.set("mask", toBlob(params.mask), params.mask.filename);
  return form;
}
function toBlob(input) {
  const ct = input.contentType ?? guessMime(input.filename);
  if (input.data instanceof Blob) {
    return input.data.type === ct ? input.data : new Blob([input.data], { type: ct });
  }
  if (typeof input.data === "string") {
    return new Blob([input.data], { type: ct });
  }
  return new Blob([input.data], { type: ct });
}
function guessMime(filename) {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

// src/media.ts
function encodeImageUrl(bytes) {
  if (bytes instanceof Blob) {
    throw new Error(
      "encodeImageUrl: Blob input requires async; await blob.arrayBuffer() and pass the result instead"
    );
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const mime = sniffImageMime(u8);
  const CHUNK = 32768;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, i + CHUNK))
    );
  }
  const b64 = globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return `data:${mime};base64,${b64}`;
}
async function decodeMediaUrl(url) {
  if (url.startsWith("data:")) {
    const rest = url.slice(5);
    const semi = rest.indexOf(";");
    const comma = rest.indexOf(",");
    if (semi === -1 || comma === -1 || comma < semi) {
      throw new Error("decodeMediaUrl: malformed data URI");
    }
    const mime = rest.slice(0, semi);
    const b64 = rest.slice(comma + 1);
    return { bytes: base64ToBytes(b64), contentType: mime };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`decodeMediaUrl: upstream ${resp.status}`);
    }
    const buf = await resp.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: resp.headers.get("Content-Type") ?? ""
    };
  }
  throw new Error(`decodeMediaUrl: unsupported url scheme: ${url.slice(0, 32)}`);
}
function base64ToBytes(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sniffImageMime(b) {
  if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
    return "image/jpeg";
  }
  if (b.length >= 6 && b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56) {
    return "image/gif";
  }
  if (b.length >= 12 && b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) {
    return "image/webp";
  }
  return "application/octet-stream";
}

// src/audio.ts
var AudioService = class {
  constructor(transport, events) {
    __publicField(this, "transport", transport);
    __publicField(this, "events", events);
  }
  // (Removed: listVoices — fetch voice metadata via client.models.get /
  //  client.models.list and read model.options.voices /
  //  model.options.supported_emotions.)
  /** What `speech(model, params)` (or `speechAsync`) would cost, without running it. */
  async quoteSpeech(model, params, init) {
    const r = await this.transport.postJSON(
      "/v1/quote/audio/speech",
      buildSpeechBody(model, params),
      init
    );
    return r.quote;
  }
  /**
   * Generate speech from text. Output bytes are base64-decoded by the SDK
   * — `response.data` is a `Uint8Array` you can write directly to disk:
   *
   * ```ts
   * await fs.writeFile("out.mp3", await client.audio.speech("OpenAI/TTS", {
   *   input: "Hello!",
   *   voice: "nova",
   * }).then(r => r.data));
   * ```
   */
  async speech(model, params, init) {
    return wrapEvents(
      this.events,
      { model, capability: "text_to_speech" },
      async () => {
        const raw = await this.transport.postJSON(
          "/v1/audio/speech",
          buildSpeechBody(model, params),
          init
        );
        const { bytes, contentType } = await decodeMediaUrl(raw.audio_url);
        return { data: bytes, contentType, usage: raw.usage };
      },
      (r) => ({ costUSD: r.usage?.total_cost })
    );
  }
  /**
   * Async equivalent of `speech()`. Submits the job to the gateway's
   * async TTS endpoint, polls every ~3s until terminal, then decodes
   * the result audio_url. Use this when a request may exceed the
   * ~100s origin timeout — ACE-Step music generation at high quality,
   * large CosyVoice batches, etc. The sync `speech()` method is the
   * right choice for short-clip TTS that fits inside Cloudflare's
   * timeout (skips the submit + poll round-trips).
   *
   * Returns the same `SpeechResponse` shape as `speech()` — `data` +
   * `usage` — so callers can swap the two methods with no other change.
   *
   * Caller's `signal` deadline bounds the poll wait. Without one,
   * an internal 10-minute cap applies.
   */
  async speechAsync(model, params, init) {
    return wrapEvents(
      this.events,
      { model, capability: "text_to_speech" },
      async () => {
        const submit = await this.transport.postJSON(
          "/v1/async/audio/speech",
          buildSpeechBody(model, params),
          init
        );
        if (!submit.id) {
          throw new Error("runapps: speech submit response missing job id");
        }
        return waitSpeechJob(this.transport, submit.id, init);
      },
      (r) => ({ costUSD: r.usage?.total_cost })
    );
  }
  /** Transcribe audio to text via multipart upload. */
  async transcribe(model, params, init) {
    const form = buildTranscribeForm(model, params);
    return wrapEvents(
      this.events,
      { model, capability: "speech_to_text" },
      () => this.transport.postMultipart(
        "/v1/audio/transcriptions",
        form,
        init
      ),
      (r) => ({ costUSD: r.usage?.total_cost })
    );
  }
  /**
   * Async equivalent of `transcribe()`. Submits the upload, polls
   * every ~3s until terminal, returns the same `TranscribeResponse`.
   * Use this for long audio (lectures, podcasts, multi-hour
   * recordings) where Whisper can take minutes — well past
   * Cloudflare's ~100s sync ceiling.
   *
   * Caller's `signal` deadline bounds the poll wait. Without one,
   * an internal 10-minute cap applies.
   */
  async transcribeAsync(model, params, init) {
    return wrapEvents(
      this.events,
      { model, capability: "speech_to_text" },
      async () => {
        const form = buildTranscribeForm(model, params);
        const submit = await this.transport.postMultipart(
          "/v1/async/audio/transcriptions",
          form,
          init
        );
        if (!submit.id) {
          throw new Error("runapps: transcribe submit response missing job id");
        }
        return waitTranscribeJob(this.transport, submit.id, init);
      },
      (r) => ({ costUSD: r.usage?.total_cost })
    );
  }
};
async function waitSpeechJob(transport, jobId, init) {
  const path = `/v1/async/audio/speech/${encodeURIComponent(jobId)}`;
  const interval = init?.pollIntervalMs ?? 3e3;
  await sleep2(2e3, init?.signal);
  const startedAt = Date.now();
  const internalDeadline = startedAt + 10 * 60 * 1e3;
  for (; ; ) {
    if (init?.signal?.aborted) {
      throw new DOMException("speech poll aborted", "AbortError");
    }
    if (!init?.signal && Date.now() > internalDeadline) {
      throw new Error("runapps: speech job timed out (10 min internal cap)");
    }
    const status = await transport.getJSON(path, init);
    if (status.status === "succeeded") {
      if (!status.audio_url) {
        throw new Error("runapps: speech job succeeded but no audio_url returned");
      }
      const { bytes, contentType } = await decodeMediaUrl(status.audio_url);
      return {
        data: bytes,
        contentType,
        usage: status.usage ?? { total_cost: 0 }
      };
    }
    if (status.status === "failed") {
      throw new Error(status.error || "runapps: speech job failed");
    }
    await sleep2(interval, init?.signal);
  }
}
async function waitTranscribeJob(transport, jobId, init) {
  const path = `/v1/async/audio/transcriptions/${encodeURIComponent(jobId)}`;
  const interval = init?.pollIntervalMs ?? 3e3;
  await sleep2(2e3, init?.signal);
  const internalDeadline = Date.now() + 10 * 60 * 1e3;
  for (; ; ) {
    if (init?.signal?.aborted) {
      throw new DOMException("transcribe poll aborted", "AbortError");
    }
    if (!init?.signal && Date.now() > internalDeadline) {
      throw new Error("runapps: transcribe job timed out (10 min internal cap)");
    }
    const status = await transport.getJSON(path, init);
    switch (status.status) {
      case "succeeded":
        return assembleTranscribeResponse(status);
      case "failed":
        throw new Error(status.error || "runapps: transcribe job failed");
      case "queued":
      case "running":
        await sleep2(interval, init?.signal);
        break;
      default:
        throw new Error(`runapps: unknown transcribe job status ${JSON.stringify(status.status)}`);
    }
  }
}
function assembleTranscribeResponse(payload) {
  const out = {
    text: payload.text ?? "",
    usage: payload.usage ?? { total_cost: 0 }
  };
  const raw = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "text" || k === "usage" || k === "id" || k === "status") continue;
    raw[k] = v;
  }
  if (Object.keys(raw).length > 0) {
    out.raw = raw;
  }
  return out;
}
function sleep2(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function buildSpeechBody(model, params) {
  const { extra, ...canonical } = params;
  const body = { model, ...canonical };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k in body) continue;
      body[k] = v;
    }
  }
  return body;
}
function buildTranscribeForm(model, params) {
  const form = new FormData();
  form.set("model", model);
  if (params.language) form.set("language", params.language);
  if (params.prompt) form.set("prompt", typeof params.prompt === "string" ? params.prompt : JSON.stringify(params.prompt));
  if (params.response_format) form.set("response_format", params.response_format);
  if (params.timestamp_granularities) {
    for (const g of params.timestamp_granularities) {
      form.append("timestamp_granularities[]", g);
    }
  }
  if (params.user) form.set("user", params.user);
  if (!params.file) {
    if (!params.url) throw new Error("runapps: transcribe needs `file` or `url`");
    form.set("url", params.url);
    return form;
  }
  const ct = params.file.contentType ?? guessAudioMime(params.file.filename);
  const blob = params.file.data instanceof Blob ? params.file.data : new Blob([params.file.data], { type: ct });
  form.set("file", blob, params.file.filename);
  return form;
}
function guessAudioMime(filename) {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "ogg":
      return "audio/ogg";
    case "webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

// src/realtime.ts
var OPEN = 1;
var CLOSE_TIMEOUT_MS = 1e4;
var RealtimeSession = class {
  /** @internal */
  constructor(ws) {
    __publicField(this, "ws", ws);
    /** The upstream session id (from `session.created`); pass it as
     *  `session.id` to a later session to continue the conversation. */
    __publicField(this, "sessionId", "");
    /** Settles when the socket closes, however that happens. */
    __publicField(this, "closed");
    __publicField(this, "handlers", /* @__PURE__ */ new Map());
    __publicField(this, "usage", null);
    __publicField(this, "resolveClosed");
    __publicField(this, "isClosed", false);
    __publicField(this, "queue", []);
    __publicField(this, "waiters", []);
    __publicField(this, "iterating", false);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let event;
      try {
        event = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!event || typeof event.type !== "string") return;
      if (event.type === "session.created") {
        const id = event.session?.id;
        if (typeof id === "string") this.sessionId = id;
      } else if (event.type === "gateway.usage") {
        this.usage = event.usage ?? null;
      }
      this.dispatch(event);
    });
    ws.addEventListener("close", (ev) => {
      if (this.isClosed) return;
      this.isClosed = true;
      for (const w of this.waiters.splice(0)) w({ value: void 0, done: true });
      this.resolveClosed({ code: ev.code ?? 1006, reason: ev.reason ?? "", usage: this.usage });
    });
  }
  /**
   * Subscribe to events of one type, or `"*"` for all of them. Returns
   * the unsubscribe function.
   */
  on(type, handler) {
    let set = this.handlers.get(type);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }
  /** Send a raw protocol event. */
  send(event) {
    if (this.ws.readyState !== OPEN) throw new Error("runapps: realtime session is closed");
    this.ws.send(JSON.stringify(event));
  }
  /**
   * Stream a chunk of microphone audio: 16-bit little-endian PCM, 16 kHz
   * mono (`pcm16FromFloat32` converts Web Audio samples). Send ~20 ms
   * (640 bytes) at a time, as it is captured.
   */
  appendAudio(pcm16) {
    this.send({ type: "input_audio_buffer.append", audio: bytesToBase64(asBytes(pcm16)) });
  }
  /** Tell the model the user has finished speaking (skips end-of-speech
   *  detection). For a transcription model this ends the audio: the last
   *  sentence settles, then the session closes. */
  commitAudio() {
    this.send({ type: "input_audio_buffer.commit" });
  }
  /** The microphone is off: stops the model waiting on audio. */
  mute() {
    this.send({ type: "input_audio_mute.commit" });
  }
  /** The microphone is back on. */
  unmute() {
    this.send({ type: "input_audio_unmute.commit" });
  }
  /** Have the model speak `text` (a greeting, or a scripted line). */
  say(text) {
    this.send({ type: "speech_text_buffer.commit", text });
  }
  /** Interrupt the model's current reply. */
  cancelResponse() {
    this.send({ type: "response.cancel" });
  }
  /** Change session settings mid-session (instructions, voice, tools, …). */
  update(session) {
    this.send({ type: "session.update", session });
  }
  /** Answer a `response.function_call_arguments.done` tool call. */
  sendFunctionResult(callId, output) {
    this.send({
      type: "conversation.item.create",
      items: [{ call_id: callId, role: "tool", content: [{ type: "input_text", text: output }] }]
    });
  }
  /**
   * End the session: asks the model to close, waits for the server to
   * hang up (so the closing `gateway.usage` arrives), and resolves with
   * how it ended, including the cost.
   */
  async close() {
    if (!this.isClosed && this.ws.readyState === OPEN) {
      try {
        this.send({ type: "session.close" });
      } catch {
      }
      const timer = setTimeout(() => this.ws.close(1e3, "client timeout"), CLOSE_TIMEOUT_MS);
      try {
        return await this.closed;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!this.isClosed) this.ws.close(1e3);
    return this.closed;
  }
  /** Iterate events until the session closes. */
  [Symbol.asyncIterator]() {
    this.iterating = true;
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.isClosed) return Promise.resolve({ value: void 0, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.iterating = false;
        this.queue = [];
        return Promise.resolve({ value: void 0, done: true });
      }
    };
  }
  dispatch(event) {
    for (const type of [event.type, "*"]) {
      const set = this.handlers.get(type);
      if (!set) continue;
      for (const h of [...set]) {
        try {
          h(event);
        } catch (err) {
          setTimeout(() => {
            throw err;
          });
        }
      }
    }
    if (this.iterating) {
      const w = this.waiters.shift();
      if (w) w({ value: event, done: false });
      else this.queue.push(event);
    }
  }
};
var RealtimeService = class {
  constructor(transport, events) {
    __publicField(this, "transport", transport);
    __publicField(this, "events", events);
  }
  /**
   * Open a realtime voice session. Resolves once the model has accepted
   * it (`session.created`); rejects if the connection fails first.
   */
  async connect(options = {}) {
    const WS = options.WebSocket ?? globalThis.WebSocket;
    if (!WS) {
      throw new Error("runapps: no WebSocket available \u2014 pass `WebSocket` (e.g. from the `ws` package) on Node < 22");
    }
    const token = await this.transport.bearerToken();
    const ws = new WS(realtimeURL(this.transport.baseURL, options), ["realtime", "runapps-key." + token]);
    const session = new RealtimeSession(ws);
    const model = options.model ?? "";
    const id = newRequestId();
    const startedAt = Date.now();
    this.events.emit("request:start", { id, model, capability: "realtime", startedAt, streaming: true });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(new Error("runapps: realtime session did not open in time"));
          ws.close(1e3, "open timeout");
        }, options.timeoutMs ?? 15e3);
        const onAbort = () => {
          fail(new Error("runapps: realtime connect aborted"));
          ws.close(1e3, "aborted");
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        let settled = false;
        function fail(err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(err);
        }
        const offCreated = session.on("session.created", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          offCreated();
          offError();
          resolve();
        });
        const offError = session.on("error", (ev) => {
          const e = ev.error ?? {};
          fail(new Error(`runapps: realtime error: ${e.message ?? JSON.stringify(ev)}`));
        });
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify(openingEvent(options)));
        });
        void session.closed.then((info) => {
          const hint = info.code === 1006 ? " \u2014 check the API key, the model name and the account balance" : "";
          fail(new Error(`runapps: realtime connection closed (${info.code}${info.reason ? " " + info.reason : ""})${hint}`));
        });
      });
    } catch (err) {
      try {
        ws.close(1e3, "connect failed");
      } catch {
      }
      this.events.emit("request:error", {
        id,
        model,
        capability: "realtime",
        latencyMs: Date.now() - startedAt,
        error: err
      });
      throw err;
    }
    void session.closed.then((info) => {
      this.events.emit("request:end", {
        id,
        model,
        capability: "realtime",
        latencyMs: Date.now() - startedAt,
        totalTokens: info.usage?.output_tokens ?? 0,
        ...info.usage?.total_cost !== void 0 && { costUSD: info.usage.total_cost }
      });
    });
    return session;
  }
};
function openingEvent(options) {
  const event = { type: "session.create", session: options.session ?? {} };
  if (options.extension) event.extension = options.extension;
  return event;
}
function realtimeURL(baseURL, options) {
  const u = new URL(baseURL.replace(/\/+$/, "") + "/v1/realtime");
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  for (const [k, v] of Object.entries(options.query ?? {})) u.searchParams.set(k, v);
  if (options.model) u.searchParams.set("model", options.model);
  if (options.maxCost !== void 0 && options.maxCost > 0) u.searchParams.set("max_cost", String(options.maxCost));
  return u.toString();
}
function pcm16FromFloat32(samples, sampleRate, targetRate = 16e3) {
  const ratio = sampleRate / targetRate;
  const n = ratio === 1 ? samples.length : Math.floor(samples.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s;
    if (ratio === 1) {
      s = samples[i];
    } else {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      const a = samples[j];
      const b = samples[Math.min(j + 1, samples.length - 1)];
      s = a + (b - a) * frac;
    }
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}
function float32FromPCM16(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(bin);
}
function base64ToBytes2(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function asBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

// src/video.ts
var VideoService = class {
  constructor(transport, events) {
    __publicField(this, "transport", transport);
    __publicField(this, "events", events);
  }
  /** Submit a video generation task.
   *
   * Telemetry note: only the submit step fires start/end on
   * `client.events` — the per-call latency reflects the gateway
   * accepting the job, NOT how long upstream takes to render. The
   * caller's poll loop sees status flips but the SDK doesn't emit
   * end events for those (would otherwise leave the badge "active"
   * for as long as the upstream renders, sometimes minutes). */
  async generate(model, params, init) {
    return wrapEvents(
      this.events,
      { model, capability: "video_generation" },
      () => this.transport.postJSON(
        "/v1/videos/generations",
        { model, ...params },
        init
      )
    );
  }
  /** What `generate(model, params)` would cost, without running it. */
  async quote(model, params, init) {
    const r = await this.transport.postJSON(
      "/v1/quote/videos/generations",
      { model, ...params },
      init
    );
    return r.quote;
  }
  /** Fetch the current status of a task. */
  async getStatus(taskID, init) {
    return this.transport.getJSON(
      `/v1/videos/generations/${encodeURIComponent(taskID)}`,
      init
    );
  }
  /**
   * Poll `getStatus()` until the task reaches a terminal state
   * (`succeeded` / `failed`). Default poll interval is 5s.
   */
  async wait(taskID, opts = {}) {
    const interval = opts.pollIntervalMs ?? 5e3;
    while (true) {
      const status = await this.getStatus(taskID, { signal: opts.signal });
      if (status.status === "succeeded" || status.status === "failed") {
        return status;
      }
      await sleep3(interval, opts.signal);
    }
  }
  /** Download the raw video bytes for a completed task. */
  async getContent(taskID, init) {
    return this.transport.getRaw(
      `/v1/videos/${encodeURIComponent(taskID)}/content`,
      init
    );
  }
};
function sleep3(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/files.ts
function pathToURL(base, p) {
  const trimmed = p.replace(/^\/+/, "");
  return base + "/" + trimmed.split("/").map(encodeURIComponent).join("/");
}
var FilesService = class {
  constructor(transport, project, events, filesBase) {
    __publicField(this, "transport", transport);
    __publicField(this, "events", events);
    /**
     * URL prefix for every file call.
     *
     * When the client was constructed with `project`, requests go to the
     * project-scoped form — `/v1/p/<project>/files/...` — instead of the
     * bare `/v1/files/...`.
     *
     * This matters because the unscoped URL is byte-identical across apps:
     * two bundles built from the same template both read
     * `projects/index.json`, so anything keying on URL alone (starting
     * with the browser's HTTP cache, which ignores request headers and is
     * partitioned by registrable domain, not by subdomain) cannot tell
     * them apart.  Putting the project in the path makes the URL unique
     * per app.  The gateway still authorizes purely from the token and
     * rejects a scope that disagrees with it, so this is a correctness
     * measure, not a permission one.
     */
    __publicField(this, "legacyBase");
    __publicField(this, "project");
    __publicField(this, "filesBase");
    __publicField(this, "baseCache", null);
    __publicField(this, "basePending", null);
    this.project = project;
    this.filesBase = filesBase;
    this.legacyBase = project ? "/v1/p/" + encodeURIComponent(project) + "/files" : "/v1/files";
  }
  /**
   * The URL prefix for file calls, resolved once per signed-in user.
   *
   * Newer gateways answer `GET /v1/files-base` with a per-user base on
   * the files host — `https://files.runapps.ai/u/<hash>` — so every
   * file URL is unique to its user as well as to its app, and file
   * traffic leaves the main site. The `/files` or `/p/<app>/files` tail
   * is appended here. A gateway without that endpoint, or a failure to
   * reach it, falls back to the classic path on the main base. The
   * result is cached against a fingerprint of the token: a different
   * user signing in gets their own base.
   */
  async base() {
    if (this.filesBase === false) return this.legacyBase;
    const tail = this.project ? "/p/" + encodeURIComponent(this.project) + "/files" : "/files";
    if (typeof this.filesBase === "string") return this.filesBase.replace(/\/+$/, "") + tail;
    const fp = await this.transport.tokenFingerprint();
    if (this.baseCache && this.baseCache.fp === fp) return this.baseCache.base;
    if (!this.basePending) {
      this.basePending = (async () => {
        let base = this.legacyBase;
        try {
          const r = await this.transport.getJSON("/v1/files-base");
          if (r && typeof r.base === "string" && /^https?:\/\//i.test(r.base)) base = r.base.replace(/\/+$/, "") + tail;
        } catch {
        }
        this.baseCache = { fp, base };
        return base;
      })().finally(() => {
        this.basePending = null;
      });
    }
    return this.basePending;
  }
  /** Run one file call, with badge events when the service has a bus. */
  run(op, fn) {
    return this.events ? wrapEvents(this.events, { model: op, capability: "files" }, fn) : fn();
  }
  /**
   * Upload `body` to `path`.  Returns the resulting FileObject — its
   * `url` is the stable public address for that path.
   *
   * `body` accepts anything `fetch` accepts as a request body: Blob,
   * File, ArrayBuffer, ArrayBufferView, FormData (rare here),
   * ReadableStream, or a string.
   */
  async put(path, body, opts) {
    const headers = {};
    if (opts?.ifNoneMatch) headers["If-None-Match"] = "*";
    if (opts?.ifMatch) headers["If-Match"] = `"${cleanETag(opts.ifMatch)}"`;
    return this.run("files.put", async () => this.transport.putBytes(pathToURL(await this.base(), path), body, {
      contentType: opts?.contentType,
      headers: Object.keys(headers).length ? headers : void 0,
      signal: opts?.signal
    }));
  }
  /** Convenience: upload string content with sensible content-type. */
  async putString(path, content, opts) {
    return this.put(path, content, {
      ...opts,
      contentType: opts?.contentType ?? "text/plain; charset=utf-8"
    });
  }
  /**
   * Download the bytes at `path` as a Blob.  Use `URL.createObjectURL`
   * to get a temporary local URL, or persist the bytes elsewhere.
   * Bundles that just need to render an asset should use the FileObject's
   * `.url` directly instead — that's a stable public URL with no token.
   */
  async get(path, init) {
    return (await this.read(path, init)).blob;
  }
  /**
   * Like `get`, but also returns the ETag of the bytes, so a later
   * `put(path, body, { ifMatch: etag })` writes only if the file is
   * still the version that was read.
   */
  async read(path, init) {
    return this.run("files.read", () => this.readRaw(path, init));
  }
  async readRaw(path, init) {
    const { data, contentType, etag, notModified } = await this.transport.getRaw(pathToURL(await this.base(), path), init);
    return {
      blob: new Blob([new Uint8Array(data)], { type: contentType || "application/octet-stream" }),
      contentType,
      etag,
      ...notModified ? { notModified: true } : {}
    };
  }
  /**
   * Read a JSON file and its version in one call. A missing file is
   * `{ value: undefined, etag: undefined }`, so a first save can pass
   * `ifNoneMatch: true` and a later one `ifMatch: etag`.
   */
  async readJSON(path, init) {
    let r;
    try {
      r = await this.read(path, init);
    } catch (e) {
      if (e?.statusCode === 404 || e?.status === 404) {
        return { value: void 0, etag: void 0 };
      }
      throw e;
    }
    if (r.notModified) return { value: void 0, etag: r.etag, notModified: true };
    return { value: JSON.parse(await r.blob.text()), etag: r.etag };
  }
  /** Stat: HEAD-only object metadata. */
  async stat(path, init) {
    const { status, headers } = await this.run("files.stat", async () => this.transport.head(pathToURL(await this.base(), path), init));
    if (status === 404) {
      throw Object.assign(new Error("not found"), { status: 404 });
    }
    if (status >= 400) {
      throw Object.assign(new Error("stat failed"), { status });
    }
    const size = parseInt(headers.get("content-length") ?? "0", 10);
    return {
      path: headers.get("x-file-path") ?? path,
      size,
      content_type: headers.get("content-type") ?? void 0,
      etag: (headers.get("etag") ?? "").replace(/"/g, "") || void 0,
      url: headers.get("x-file-url") ?? ""
    };
  }
  /** Returns true iff the path resolves to an existing object. */
  async exists(path, init) {
    const { status } = await this.run("files.exists", async () => this.transport.head(pathToURL(await this.base(), path), init));
    return status >= 200 && status < 400;
  }
  /** Delete the object at `path`.  Idempotent. */
  async del(path, init) {
    await this.run("files.del", async () => this.transport.deletePath(pathToURL(await this.base(), path), init));
  }
  /** List objects.  Pass an empty / omitted prefix for the root. */
  async list(opts) {
    const params = new URLSearchParams();
    if (opts?.prefix) params.set("prefix", opts.prefix);
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.glob) params.set("glob", opts.glob);
    const qs = params.toString();
    return this.run("files.list", async () => this.transport.getJSON(
      await this.base() + (qs ? "?" + qs : ""),
      opts?.signal ? { signal: opts.signal } : void 0
    ));
  }
  /**
   * Bulk delete: removes every object whose path starts with `prefix`
   * AND (when set) matches `glob`.  Returns the count of deleted
   * objects.  Refuses an empty prefix + empty glob — the caller must
   * be explicit about wiping the project namespace.
   *
   *   client.files.deleteMany({ prefix: "tmp/" })          // wipe a directory
   *   client.files.deleteMany({ glob: "**\/*.tmp" })       // wipe by pattern
   *   client.files.deleteMany({ prefix: "logs/", glob: "*.bak" })
   */
  async deleteMany(opts, init) {
    return this.run("files.deleteMany", async () => this.transport.postJSON(
      await this.base() + "/delete",
      { prefix: opts.prefix ?? "", glob: opts.glob ?? "" },
      init
    ));
  }
  /** Atomic rename (copy + delete server-side). */
  async move(from, to, init) {
    return this.run("files.move", async () => this.transport.postJSON(await this.base() + "/move", { from, to }, init));
  }
  /** Server-side copy. */
  async copy(from, to, init) {
    return this.run("files.copy", async () => this.transport.postJSON(await this.base() + "/copy", { from, to }, init));
  }
  /**
   * A time-limited link to a private file that needs no token: put it in
   * `<img src>`, `<video src>` or `<a href download>`. The link is for
   * this user's copy of the file in this app; it expires after
   * `expiresIn` seconds (default one hour, at most seven days) and is
   * never cached, so it always shows the current bytes. For a permanent
   * public address use the FileObject's `url` instead.
   */
  async url(path, opts) {
    const urls = await this.urls([path], opts);
    const u = urls[path];
    if (!u) throw new Error("RunApps: no signed URL returned for " + path);
    return u;
  }
  /** Signed links for several paths at once (up to 200): `{ path: url }`. */
  async urls(paths, opts) {
    const body = { paths };
    if (opts?.expiresIn) body.expires_in = Math.floor(opts.expiresIn);
    const r = await this.run("files.sign", async () => this.transport.postJSON(
      await this.base() + "/sign",
      body,
      opts?.signal ? { signal: opts.signal } : void 0
    ));
    const out = {};
    for (const [p, u] of Object.entries(r.urls || {})) {
      out[p] = opts?.download ? u + (u.includes("?") ? "&" : "?") + "download=1" : u;
    }
    return out;
  }
  /**
   * Ask the gateway to fetch `srcURL` and store the body at `path`.
   * Saves a round trip vs downloading then re-uploading.  `srcURL`
   * must be a public http(s) URL (private/loopback hosts rejected).
   */
  async putFromURL(path, srcURL, opts) {
    return this.run("files.putFromURL", async () => this.transport.postJSON(
      await this.base() + "/put-url",
      {
        path,
        src_url: srcURL,
        content_type: opts?.contentType,
        if_none_match: opts?.ifNoneMatch,
        if_match: opts?.ifMatch
      },
      opts?.signal ? { signal: opts.signal } : void 0
    ));
  }
  /**
   * Pipeline several file ops in one round trip.  Operations execute
   * sequentially server-side; one op failing does not abort the rest.
   * Inspect each result.ok individually.
   *
   * Auto-chunks: the gateway caps a single batch at 64 ops and returns
   * 400 "too many ops" above that.  This method splits long input into
   * 30-op chunks, awaits each chunk in order, and concatenates the
   * results — so callers can hand it 1000 ops in a single call.
   * Chunks run serially (not in parallel) to preserve the
   * "operations execute in submission order" contract.
   */
  async batch(ops, init) {
    if (ops.length === 0) return [];
    return this.run("files.batch", () => this.batchRaw(ops, init));
  }
  async batchRaw(ops, init) {
    const chunkSize = 30;
    if (ops.length <= chunkSize) {
      const resp = await this.transport.postJSON(
        await this.base() + "/batch",
        { ops },
        init
      );
      return resp.results;
    }
    const all = [];
    for (let i = 0; i < ops.length; i += chunkSize) {
      const chunk = ops.slice(i, i + chunkSize);
      const resp = await this.transport.postJSON(
        await this.base() + "/batch",
        { ops: chunk },
        init
      );
      all.push(...resp.results);
    }
    return all;
  }
};

// src/embeddings.ts
var EmbeddingsService = class {
  constructor(transport, events) {
    __publicField(this, "transport", transport);
    __publicField(this, "events", events);
  }
  /**
   * Create one or more embeddings.
   *
   * ```ts
   * const r = await client.embeddings.create("text-embedding-3-small", {
   *   input: ["alpha", "beta"],
   *   dimensions: 1536,
   * });
   * for (const e of r.data) {
   *   console.log(e.index, (e.embedding as number[]).slice(0, 4));
   * }
   * console.log(`Cost: $${r.usage.total_cost.toFixed(6)}`);
   * ```
   */
  async create(model, params, init) {
    return wrapEvents(
      this.events,
      { model, capability: "embedding" },
      () => this.transport.postJSON(
        "/v1/embeddings",
        { model, ...params },
        init
      ),
      (r) => ({
        totalTokens: r.usage?.total_tokens,
        costUSD: r.usage?.total_cost
      })
    );
  }
};

// src/assets.ts
var AssetsService = class {
  constructor(transport) {
    __publicField(this, "transport", transport);
  }
  /** Verify a picture (an http(s) URL or a data: URI) for Seedance. */
  async verify(url, init) {
    return this.transport.postJSON("/v1/assets/verify", { url }, init);
  }
};

// src/apps.ts
var SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var ID = /^[A-Za-z0-9_-]{8,64}$/;
var MAX_FILES = 20;
var HASH_PARAM = "runapps_handoff";
var INBOX_PREFIX = "runapps_inbox:";
var INBOX_CHANNEL = "runapps_inbox";
var INBOX_PATH = "/__runapps/handoff.html";
var KEEP_MS = 7 * 24 * 3600 * 1e3;
var SEND_LINK_SECONDS = 7 * 24 * 3600;
function encodeHandoff(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeHandoff(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function appSlugOf(hostname) {
  const m = /^([a-z0-9-]+)\.(runapps\.dev|localhost)$/i.exec(hostname);
  return m && SLUG.test(m[1].toLowerCase()) ? m[1].toLowerCase() : "";
}
function appOriginFrom(pageOrigin, slug) {
  const u = new URL(pageOrigin);
  if (/\.localhost$/i.test(u.hostname) || u.hostname === "localhost") {
    return `http://${slug}.localhost${u.port ? ":" + u.port : ":8080"}`;
  }
  return `https://${slug}.runapps.dev`;
}
function isAppOrigin(origin) {
  return /^https:\/\/[a-z0-9-]+\.runapps\.dev$/.test(origin) || /^http:\/\/[a-z0-9-]+\.localhost(:\d+)?$/.test(origin);
}
function isFilesURL(url, local) {
  if (/^https:\/\/files\.runapps\.ai\/(f|s)\/[^\s]+$/.test(url)) return true;
  return local && /^http:\/\/localhost(:\d+)?\/(f|s)\/[^\s]+$/.test(url);
}
function cleanFiles(files, local) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return null;
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== "object") return null;
    const { url, name, type, size } = f;
    if (typeof url !== "string" || !isFilesURL(url, local)) return null;
    const safeName = typeof name === "string" ? name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) : "";
    out.push({
      url,
      name: safeName || "file",
      type: typeof type === "string" ? type.slice(0, 120) : "",
      ...typeof size === "number" && size >= 0 ? { size } : {}
    });
  }
  return out;
}
function parseHandoffPayload(raw, local) {
  if (!raw || typeof raw !== "object") return null;
  const p = raw;
  if (p.v !== 2 || typeof p.id !== "string" || !ID.test(p.id)) return null;
  if (typeof p.from !== "string" || !SLUG.test(p.from)) return null;
  const action = p.action === "open" ? "open" : p.action === "edit" ? "edit" : null;
  if (!action) return null;
  const files = cleanFiles(p.files, local);
  if (!files) return null;
  return { v: 2, id: p.id, from: p.from, action, files };
}
function newId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsDel(key) {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}
function lsKeys(prefix) {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch {
  }
  return out;
}
var AppsService = class {
  constructor(transport, files, project, signedIn) {
    __publicField(this, "transport", transport);
    __publicField(this, "files", files);
    __publicField(this, "project", project);
    __publicField(this, "signedIn", signedIn);
    __publicField(this, "local");
    __publicField(this, "handlers", []);
    __publicField(this, "delivering", /* @__PURE__ */ new Set());
    __publicField(this, "listening", false);
    this.local = typeof location !== "undefined" && /\.localhost$/i.test(location.hostname);
    if (typeof localStorage !== "undefined") this.prune();
  }
  /** This app's slug: its host's subdomain, else the `project` option. */
  get self() {
    const fromHost = typeof location !== "undefined" ? appSlugOf(location.hostname) : "";
    return fromHost || this.project || "";
  }
  /**
   * The apps that take a file type, as their bundles declare, in library
   * order and the page's language; this app is left out. Signed in, the
   * list also has the unlisted apps the user has.
   */
  async receivers(opts) {
    const q = new URLSearchParams({ type: opts.type });
    if (opts.action) q.set("action", opts.action);
    const lang = typeof document !== "undefined" ? document.documentElement.lang || navigator.language || "" : "";
    if (/^zh/i.test(lang)) q.set("lang", "zh");
    const path = "/v1/apps/receivers?" + q.toString();
    const init = opts.signal ? { signal: opts.signal } : void 0;
    const r = this.signedIn() ? await this.transport.getJSON(path, init) : await this.transport.getPublicJSON(path, init);
    const self = this.self;
    return (r.data || []).filter((a) => a.slug !== self);
  }
  /**
   * Send files to another app. Call it straight from the click that asks
   * for it: the app's inbox opens in a new tab (that needs the user
   * gesture), so the window is opened first and pointed at the inbox once
   * the links are signed. If the app is already open in a tab, that tab
   * takes the files and the new tab says so; otherwise the new tab becomes
   * the app.
   */
  async send(to, opts) {
    if (!SLUG.test(to)) throw new Error("RunApps: send: not an app slug: " + to);
    if (!opts.files?.length || opts.files.length > MAX_FILES) throw new Error(`RunApps: send: 1\u2013${MAX_FILES} files`);
    const id = newId();
    const win = openBlank("_blank");
    try {
      const files = await this.prepare(id, opts.files);
      const payload = { v: 2, id, from: this.self || "app", action: opts.action ?? "edit", files };
      const q = new URLSearchParams();
      const lang = document.documentElement.lang || "";
      if (/^(zh|en)/i.test(lang)) q.set("lang", lang.slice(0, 2).toLowerCase());
      const target = appOriginFrom(location.origin, to) + INBOX_PATH + (q.toString() ? "?" + q : "") + "#" + HASH_PARAM + "=" + encodeHandoff(payload);
      await navigateOrOpen(win, target, "_blank");
      return { id };
    } catch (e) {
      try {
        win?.close();
      } catch {
      }
      throw e;
    }
  }
  /**
   * Receive what other apps send this one: each handoff once, whether it
   * arrives now (in this tab or, with the app open in several tabs, in one
   * of them) or arrived while the app was closed. A handoff is forgotten
   * once a handler returns (or its promise resolves); a handler that throws
   * leaves it for later (another tab, the next start, or a new handler).
   */
  onReceive(handler) {
    this.handlers.push(handler);
    this.listen();
    if (typeof localStorage !== "undefined") {
      queueMicrotask(() => {
        for (const k of lsKeys(INBOX_PREFIX)) void this.deliver(k.slice(INBOX_PREFIX.length));
      });
    }
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  /** Handoffs waiting for this app (sent while it was closed, or not yet
   *  taken), without taking them. An app checks it at start, to skip its
   *  start screen or last document when it was opened to receive files. */
  waiting() {
    const out = [];
    for (const k of lsKeys(INBOX_PREFIX)) {
      try {
        const p = parseHandoffPayload(JSON.parse(lsGet(k) || "null")?.payload, this.local);
        if (p) out.push({ id: p.id, from: p.from, action: p.action, files: p.files });
      } catch {
      }
    }
    return out;
  }
  /** Hears the inbox page (BroadcastChannel) and other tabs (storage). */
  listen() {
    if (this.listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    this.listening = true;
    window.addEventListener("storage", (e) => {
      if (e.key && e.key.startsWith(INBOX_PREFIX) && e.newValue) void this.deliver(e.key.slice(INBOX_PREFIX.length));
    });
    if (typeof BroadcastChannel === "function") {
      const ch = new BroadcastChannel(INBOX_CHANNEL);
      ch.onmessage = (e) => {
        const d = e.data;
        if (d?.type !== "new" || typeof d.id !== "string" || !this.handlers.length) return;
        ch.postMessage({ type: "here", id: d.id });
        void this.deliver(d.id);
      };
    }
  }
  /**
   * Hands one inbox entry to the handlers. Every open tab hears of it, so
   * tabs take turns under a lock named after the handoff (Web Locks,
   * shared by the origin's tabs): the one holding it reads the entry again
   * — another tab may have taken it — and only a tab whose handlers all
   * succeed removes it.
   */
  async deliver(id) {
    if (!this.handlers.length || this.delivering.has(id) || !lsGet(INBOX_PREFIX + id)) return;
    this.delivering.add(id);
    try {
      await withLock(INBOX_PREFIX + id, () => this.deliverLocked(id));
    } finally {
      this.delivering.delete(id);
    }
  }
  async deliverLocked(id) {
    const raw = lsGet(INBOX_PREFIX + id);
    if (!raw) return;
    let p = null;
    try {
      p = parseHandoffPayload(JSON.parse(raw)?.payload, this.local);
    } catch {
      p = null;
    }
    if (!p || p.id !== id) {
      lsDel(INBOX_PREFIX + id);
      return;
    }
    const h = this.received(p);
    try {
      for (const fn of this.handlers) await fn(h);
      lsDel(INBOX_PREFIX + id);
    } catch (e) {
      console.warn("RunApps: a handler could not take the files another app sent; kept for later", e);
    }
  }
  received(p) {
    const svc = this;
    const file = (i) => {
      const f = p.files[i];
      if (!f) throw new Error("RunApps: no sent file " + i);
      return f;
    };
    return {
      id: p.id,
      from: p.from,
      action: p.action,
      files: p.files,
      importTo(path, index = 0) {
        return svc.files.putFromURL(path, file(index).url);
      },
      async blob(index = 0) {
        const r = await fetch(file(index).url);
        if (!r.ok) throw new Error(`RunApps: sent file ${index}: HTTP ${r.status}`);
        return r.blob();
      },
      async fromApp() {
        try {
          const r = await svc.transport.getPublicJSON("/api/projects/" + p.from);
          return { name: r.data?.name || p.from, icon_url: r.data?.icon_url || "" };
        } catch {
          return { name: p.from, icon_url: "" };
        }
      }
    };
  }
  /** Drops inbox entries older than a week. */
  prune() {
    const cutoff = Date.now() - KEEP_MS;
    for (const k of lsKeys(INBOX_PREFIX)) {
      try {
        if ((JSON.parse(lsGet(k) || "{}").received_at ?? 0) < cutoff) lsDel(k);
      } catch {
        lsDel(k);
      }
    }
  }
  /** Links for the files to send; paths are signed, blobs stored first. */
  async prepare(id, sources) {
    const out = [];
    const toSign = [];
    for (const [i, s] of sources.entries()) {
      if ("url" in s) {
        if (!isFilesURL(s.url, this.local)) throw new Error("RunApps: send files-host links only: " + s.url);
        out[i] = { url: s.url, name: s.name, type: s.type ?? "", ...s.size !== void 0 ? { size: s.size } : {} };
      } else if ("blob" in s) {
        const name = s.name.replace(/[\\/]/g, "_") || "file";
        const obj = await this.files.put(`handoff/${id}/${name}`, s.blob);
        out[i] = { url: "", name, type: s.type ?? s.blob.type ?? "", size: obj.size };
        toSign.push({ path: obj.path, i });
      } else {
        const st = await this.files.stat(s.path);
        out[i] = { url: "", name: s.name ?? s.path.split("/").pop() ?? "file", type: s.type ?? st.content_type ?? "", size: st.size };
        toSign.push({ path: s.path, i });
      }
    }
    if (toSign.length) {
      const urls = await this.files.urls(toSign.map((t) => t.path), { expiresIn: SEND_LINK_SECONDS });
      for (const t of toSign) {
        const u = urls[t.path];
        if (!u) throw new Error("RunApps: could not sign " + t.path);
        out[t.i].url = u;
      }
    }
    return out;
  }
};
function withLock(name, fn) {
  const locks = typeof navigator !== "undefined" ? navigator.locks : void 0;
  return locks && typeof locks.request === "function" ? locks.request(name, fn) : fn();
}
function openBlank(name, features) {
  if (typeof window === "undefined") return null;
  const w = window.open("about:blank", name, features);
  if (w) {
    try {
      w.document.title = "RunApps";
      w.document.body.style.cssText = "margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#888";
      w.document.body.textContent = "\u2026";
    } catch {
    }
  }
  return w;
}
function navigateOrOpen(win, url, name, features) {
  if (win) {
    win.location.href = url;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const types = ["pointerdown", "keydown", "touchend"];
    const handler = () => {
      for (const t of types) window.removeEventListener(t, handler, true);
      const w = window.open(url, name, features);
      if (w) resolve();
      else reject(new Error("RunApps: the browser blocked the new window"));
    };
    for (const t of types) window.addEventListener(t, handler, true);
  });
}

// src/activity-tracker.ts
var RATE_WINDOW_MS = 1500;
var RECENT_MAX = 20;
var ERROR_HIGHLIGHT_MS = 3e4;
var ActivityTracker = class {
  constructor() {
    __publicField(this, "active", /* @__PURE__ */ new Map());
    __publicField(this, "recent", []);
    __publicField(this, "session", {
      totalCalls: 0,
      totalCostUSD: 0,
      errorCount: 0,
      startedAt: Date.now()
    });
    /** Track most recent error wall-clock so the LED stays red for
     *  ERROR_HIGHLIGHT_MS even after the error scrolls out of recent. */
    __publicField(this, "lastErrorAt", 0);
    /** "Snapshot changed" listeners. Fired AFTER every event handler
     *  runs (start / delta / end / error), letting UIs re-render in
     *  push-mode instead of polling. Without this hook, the badge's
     *  ring/LED stayed idle until the user opened the popover —
     *  events landed in the tracker but nobody told the DOM. */
    __publicField(this, "changeListeners", /* @__PURE__ */ new Set());
    __publicField(this, "sync");
  }
  /**
   * Subscribe the tracker to a bus. Returns a single disposer that
   * unsubscribes all four handlers — callers (BrowserAuth in our
   * case) attach this on construction and dispose on teardown.
   */
  attach(events) {
    const offs = [
      events.on("request:start", (e) => {
        this.onStart(e);
        this.notify();
      }),
      events.on("request:streamDelta", (e) => {
        this.onDelta(e);
        this.notify();
      }),
      events.on("request:end", (e) => {
        this.onEnd(e);
        this.notify();
      }),
      events.on("request:error", (e) => {
        this.onError(e);
        this.notify();
      }),
      events.on("sync:state", (e) => {
        this.sync = { ...e };
        this.notify();
      })
    ];
    return () => {
      for (const o of offs) o();
    };
  }
  /**
   * Subscribe to "snapshot may have changed" notifications. Fires
   * synchronously after each event handler runs — typical consumer
   * is the badge's `requestRedraw()` which coalesces multiple
   * notifications into one rAF paint.
   *
   * Returns a disposer; call to unsubscribe.
   */
  onChange(handler) {
    this.changeListeners.add(handler);
    return () => this.changeListeners.delete(handler);
  }
  notify() {
    for (const h of this.changeListeners) {
      try {
        h();
      } catch (err) {
        console.error("[runapps sdk] ActivityTracker onChange listener threw:", err);
      }
    }
  }
  /** O(active+recent) — small in practice, fine on every frame. */
  snapshot() {
    const now = Date.now();
    return {
      active: Array.from(this.active.values()),
      recent: this.recent.slice(),
      session: { ...this.session },
      ...this.sync ? { sync: { ...this.sync } } : {},
      status: now - this.lastErrorAt < ERROR_HIGHLIGHT_MS ? "error" : this.active.size > 0 ? "active" : "idle"
    };
  }
  // ─── handlers ─────────────────────────────────────────────────
  onStart(e) {
    this.active.set(e.id, {
      id: e.id,
      model: e.model,
      capability: e.capability,
      startedAt: e.startedAt,
      streaming: e.streaming,
      tokensSoFar: 0,
      tokensPerSec: 0,
      rateSamples: []
    });
  }
  onDelta(e) {
    const call = this.active.get(e.id);
    if (!call) return;
    call.tokensSoFar = e.totalTokens;
    const now = Date.now();
    call.rateSamples.push({ t: now, tokens: e.deltaTokens });
    const cutoff = now - RATE_WINDOW_MS;
    while (call.rateSamples.length > 0 && call.rateSamples[0].t < cutoff) {
      call.rateSamples.shift();
    }
    if (call.rateSamples.length >= 2) {
      const sumTokens = call.rateSamples.reduce((s, x) => s + x.tokens, 0);
      const spanMs = now - call.rateSamples[0].t;
      call.tokensPerSec = spanMs > 0 ? sumTokens * 1e3 / spanMs : 0;
    }
  }
  onEnd(e) {
    const call = this.active.get(e.id);
    this.active.delete(e.id);
    if (e.capability === "files") return;
    this.pushRecent({
      id: e.id,
      model: e.model,
      capability: e.capability,
      latencyMs: e.latencyMs,
      totalTokens: e.totalTokens || call?.tokensSoFar || 0,
      ...e.costUSD !== void 0 && { costUSD: e.costUSD },
      ...e.finishReason !== void 0 && { finishReason: e.finishReason },
      ok: true,
      endedAt: Date.now()
    });
    this.session.totalCalls += 1;
    if (e.costUSD !== void 0) this.session.totalCostUSD += e.costUSD;
  }
  onError(e) {
    const call = this.active.get(e.id);
    this.active.delete(e.id);
    if (e.capability === "files") {
      if (e.statusCode !== 404) this.lastErrorAt = Date.now();
      return;
    }
    this.pushRecent({
      id: e.id,
      model: e.model,
      capability: e.capability,
      latencyMs: e.latencyMs,
      totalTokens: call?.tokensSoFar || 0,
      ok: false,
      errorMessage: e.error.message,
      endedAt: Date.now()
    });
    this.session.totalCalls += 1;
    this.session.errorCount += 1;
    this.lastErrorAt = Date.now();
  }
  pushRecent(c) {
    this.recent.unshift(c);
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
  }
};

// src/sync/codec.ts
var TAG = "$rt";
var BIN_CTORS = {
  ArrayBuffer: (b) => b,
  Uint8Array: (b) => new Uint8Array(b),
  Int8Array: (b) => new Int8Array(b),
  Uint8ClampedArray: (b) => new Uint8ClampedArray(b),
  Int16Array: (b) => new Int16Array(b),
  Uint16Array: (b) => new Uint16Array(b),
  Int32Array: (b) => new Int32Array(b),
  Uint32Array: (b) => new Uint32Array(b),
  Float32Array: (b) => new Float32Array(b),
  Float64Array: (b) => new Float64Array(b),
  BigInt64Array: (b) => new BigInt64Array(b),
  BigUint64Array: (b) => new BigUint64Array(b),
  DataView: (b) => new DataView(b)
};
function bytesToBase642(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(s);
}
function base64ToBytes3(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
async function encodeValue(value, sink) {
  if (value === void 0) return { [TAG]: "undef" };
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Number.isNaN(value)) return { [TAG]: "num", v: "NaN" };
      if (value === Infinity) return { [TAG]: "num", v: "Infinity" };
      if (value === -Infinity) return { [TAG]: "num", v: "-Infinity" };
      if (Object.is(value, -0)) return { [TAG]: "num", v: "-0" };
      return value;
    case "bigint":
      return { [TAG]: "bigint", v: value.toString() };
    case "function":
    case "symbol":
      throw new TypeError(`runapps sync: ${typeof value} values cannot be stored`);
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return { [TAG]: "date", v: Number.isNaN(t) ? "invalid" : t };
  }
  if (value instanceof RegExp) return { [TAG]: "re", s: value.source, f: value.flags };
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    if (!sink) throw new TypeError("runapps sync: Blob values need a blob sink");
    const ref = await sink(value);
    const out2 = { [TAG]: "blob", r: ref.ref, t: ref.type, s: ref.size };
    const f = value;
    if (typeof File !== "undefined" && value instanceof File) {
      out2.n = f.name;
      out2.m = f.lastModified;
    }
    return out2;
  }
  if (value instanceof ArrayBuffer) {
    return { [TAG]: "bin", c: "ArrayBuffer", v: bytesToBase642(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    const name = value.constructor.name;
    if (!(name in BIN_CTORS)) throw new TypeError(`runapps sync: unsupported binary type ${name}`);
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { [TAG]: "bin", c: name, v: bytesToBase642(bytes) };
  }
  if (value instanceof Map) {
    const v = [];
    for (const [k, x] of value) v.push([await encodeValue(k, sink), await encodeValue(x, sink)]);
    return { [TAG]: "map", v };
  }
  if (value instanceof Set) {
    const v = [];
    for (const x of value) v.push(await encodeValue(x, sink));
    return { [TAG]: "set", v };
  }
  if (Array.isArray(value)) {
    const out2 = new Array(value.length);
    for (let i = 0; i < value.length; i++) out2[i] = await encodeValue(value[i], sink);
    return out2;
  }
  if (isPlainObject(value)) {
    const needsWrap = Object.prototype.hasOwnProperty.call(value, TAG);
    const out2 = {};
    for (const k of Object.keys(value)) out2[k] = await encodeValue(value[k], sink);
    return needsWrap ? { [TAG]: "obj", v: out2 } : out2;
  }
  const out = {};
  for (const k of Object.keys(value)) out[k] = await encodeValue(value[k], sink);
  return out;
}
async function decodeValue(value, source) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out2 = new Array(value.length);
    for (let i = 0; i < value.length; i++) out2[i] = await decodeValue(value[i], source);
    return out2;
  }
  const obj = value;
  const tag = obj[TAG];
  if (typeof tag === "string") {
    const t = obj;
    switch (t[TAG]) {
      case "undef":
        return void 0;
      case "date":
        return t.v === "invalid" ? /* @__PURE__ */ new Date(NaN) : new Date(t.v);
      case "num":
        return t.v === "NaN" ? NaN : t.v === "Infinity" ? Infinity : t.v === "-Infinity" ? -Infinity : -0;
      case "bigint":
        return BigInt(t.v);
      case "re":
        return new RegExp(t.s, t.f);
      case "bin": {
        const bytes = base64ToBytes3(t.v);
        const buf = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buf).set(bytes);
        const make = BIN_CTORS[t.c];
        if (!make) throw new TypeError(`runapps sync: unsupported binary type ${t.c}`);
        return make(buf);
      }
      case "map": {
        const m = /* @__PURE__ */ new Map();
        for (const pair of t.v) {
          m.set(await decodeValue(pair[0], source), await decodeValue(pair[1], source));
        }
        return m;
      }
      case "set": {
        const s = /* @__PURE__ */ new Set();
        for (const x of t.v) s.add(await decodeValue(x, source));
        return s;
      }
      case "blob": {
        if (!source) throw new TypeError("runapps sync: Blob values need a blob source");
        const blob = await source({ ref: t.r, type: t.t, size: t.s });
        if (t.n !== void 0 && typeof File !== "undefined") {
          return new File([blob], t.n, { type: t.t, lastModified: t.m ?? Date.now() });
        }
        return blob;
      }
      case "obj":
        return decodeValue(t.v, source);
    }
  }
  const out = {};
  for (const k of Object.keys(obj)) out[k] = await decodeValue(obj[k], source);
  return out;
}
function encodeKey(key) {
  if (typeof key === "number") {
    if (Number.isNaN(key)) throw new TypeError("runapps sync: NaN is not a valid key");
    return key;
  }
  if (typeof key === "string") return key;
  if (key instanceof Date) return { [TAG]: "date", v: key.getTime() };
  if (key instanceof ArrayBuffer) return { [TAG]: "bin", c: "ArrayBuffer", v: bytesToBase642(new Uint8Array(key)) };
  if (ArrayBuffer.isView(key)) {
    return {
      [TAG]: "bin",
      c: "ArrayBuffer",
      v: bytesToBase642(new Uint8Array(key.buffer, key.byteOffset, key.byteLength))
    };
  }
  if (Array.isArray(key)) return key.map((k) => encodeKey(k));
  throw new TypeError("runapps sync: invalid IndexedDB key");
}
function decodeKey(encoded) {
  if (typeof encoded === "number" || typeof encoded === "string") return encoded;
  if (Array.isArray(encoded)) return encoded.map(decodeKey);
  if (encoded && typeof encoded === "object") {
    const t = encoded;
    if (t[TAG] === "date") return new Date(t.v);
    if (t[TAG] === "bin") {
      const bytes = base64ToBytes3(t.v);
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      return buf;
    }
  }
  throw new TypeError("runapps sync: invalid encoded key");
}
function keyId(key) {
  return JSON.stringify(encodeKey(key));
}
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (typeof Blob !== "undefined" && (a instanceof Blob || b instanceof Blob)) return false;
  if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer || ArrayBuffer.isView(b) || b instanceof ArrayBuffer) {
    const toBytes = (x) => x instanceof ArrayBuffer ? new Uint8Array(x) : ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : null;
    const ba = toBytes(a);
    const bb = toBytes(b);
    if (!ba || !bb || ba.length !== bb.length || a.constructor !== b.constructor) return false;
    for (let i = 0; i < ba.length; i++) if (ba[i] !== bb[i]) return false;
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}
function changedFields(prior, value) {
  if (!isPlainObject(prior) || !isPlainObject(value)) return void 0;
  const out = [];
  for (const k of /* @__PURE__ */ new Set([...Object.keys(prior), ...Object.keys(value)])) {
    const inP = Object.prototype.hasOwnProperty.call(prior, k);
    const inV = Object.prototype.hasOwnProperty.call(value, k);
    if (inP !== inV || !deepEqual(prior[k], value[k])) out.push(k);
  }
  return out;
}
function extractKey(value, keyPath) {
  if (keyPath === null || keyPath === void 0) return void 0;
  const one = (path) => {
    let cur = value;
    if (path === "") return cur;
    for (const part of path.split(".")) {
      if (cur === null || typeof cur !== "object") return void 0;
      cur = cur[part];
    }
    return cur;
  };
  if (Array.isArray(keyPath)) {
    const parts = keyPath.map(one);
    return parts.some((p) => p === void 0) ? void 0 : parts;
  }
  const k = one(keyPath);
  return k === void 0 ? void 0 : k;
}

// src/browser-auth.ts
var TOKEN_REFRESH_MARGIN_S = 60;
var STORAGE_KEY_BASE = "__runapps_auth_v1__";
var POPUP_NAME = "runapps-signin";
var POPUP_PARAM = "runapps_popup";
var POPUP_CALLBACK_PATH = "/__runapps/signin.html";
var hasCallbackPage = (hostname) => /\.runapps\.dev$/i.test(hostname) || /\.localhost$/i.test(hostname);
var LEGACY_STORAGE_KEY_BASE = "__runjobs_auth_v1__";
var SIGNED_OUT_KEY_BASE = "__runapps_signed_out_v1__";
var LEGACY_SIGNED_OUT_KEY_BASE = "__runjobs_signed_out_v1__";
function storageKey(project) {
  return project ? `${STORAGE_KEY_BASE}:${project}` : STORAGE_KEY_BASE;
}
function signedOutKey(project) {
  return project ? `${SIGNED_OUT_KEY_BASE}:${project}` : SIGNED_OUT_KEY_BASE;
}
function legacyStorageKey(project) {
  return project ? `${LEGACY_STORAGE_KEY_BASE}:${project}` : LEGACY_STORAGE_KEY_BASE;
}
function legacySignedOutKey(project) {
  return project ? `${LEGACY_SIGNED_OUT_KEY_BASE}:${project}` : LEGACY_SIGNED_OUT_KEY_BASE;
}
var BrowserAuth = class {
  constructor(opts = {}) {
    __publicField(this, "origin");
    __publicField(this, "hideBadge");
    __publicField(this, "project");
    __publicField(this, "events");
    /** Lazily-constructed when events are present — drives the badge's
     *  activity ring / LED / popover. nullable for tests / non-browser. */
    __publicField(this, "tracker");
    __publicField(this, "badgePosition");
    __publicField(this, "token", null);
    __publicField(this, "expiresAt", 0);
    __publicField(this, "signInMode");
    __publicField(this, "popupWait", null);
    __publicField(this, "popupOpenedAt", 0);
    __publicField(this, "userInfo", null);
    __publicField(this, "listeners", []);
    __publicField(this, "parentHandshake", null);
    __publicField(this, "signingIn", false);
    /** Public token-fetcher; pass to RunApps as `apiKeyResolver`. */
    __publicField(this, "getToken", async () => {
      if (this.tokenIsFresh()) return this.token;
      if (this.isSignedOut() && !(this.signInMode === "popup" && !this.inIframe())) {
        throw new Error("RunApps: signed out \u2014 call client.signIn() to authenticate");
      }
      if (this.inIframe()) {
        try {
          if (this.parentHandshake) {
            await this.parentHandshake;
            this.parentHandshake = null;
          }
          if (!this.tokenIsFresh()) {
            await this.requestTokenFromParent();
          }
        } catch {
        }
        if (this.tokenIsFresh()) return this.token;
        throw new Error("RunApps: could not obtain a token from the dashboard");
      }
      if (this.parentHandshake) {
        await this.parentHandshake;
        if (this.tokenIsFresh()) return this.token;
      }
      if (this.signInMode === "popup") {
        await this.signInPopup();
        if (this.tokenIsFresh()) return this.token;
        throw new Error("RunApps: sign-in did not complete");
      }
      this.signIn();
      return new Promise(() => {
      });
    });
    this.origin = (opts.origin ?? "https://www.runapps.ai").replace(/\/$/, "");
    this.hideBadge = !!opts.hideBadge;
    this.project = opts.project ?? null;
    this.events = opts.events ?? null;
    this.badgePosition = opts.badgePosition ?? "bottom-right";
    this.signInMode = opts.signInMode ?? "redirect";
    if (this.events && !this.hideBadge) {
      this.tracker = new ActivityTracker();
      this.tracker.attach(this.events);
    } else {
      this.tracker = null;
    }
    if (typeof window === "undefined") return;
    this.loadPersisted();
    if (this.consumeFragment()) {
      this.clearSignedOut();
      if (new URLSearchParams(location.search).has(POPUP_PARAM)) {
        this.finishPopup();
        return;
      }
    }
    if (this.isSignedOut()) {
    } else if (this.inIframe() && !this.tokenIsFresh()) {
      this.parentHandshake = this.requestTokenFromParent().catch(() => {
      });
    } else if (this.tokenIsFresh() && this.userInfo && !this.hideBadge) {
      this.renderBadge();
    }
  }
  /** Subscribe to (re)acquisition events. Returns an unsubscribe fn. */
  onTokenChange(handler) {
    this.listeners.push(handler);
    return () => {
      const i = this.listeners.indexOf(handler);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  /** Currently-authenticated user, or null. */
  get user() {
    return this.userInfo;
  }
  /**
   * True iff a cached bearer token is present AND not within the
   * 60-second pre-expiry refresh margin.  Use this — not `user !==
   * null` — to decide whether to show "please sign in" UI: the user
   * metadata is only populated when the SDK was fed fresh user info
   * (post-redirect fragment carries it; iframe handshake carries it;
   * an older localStorage save format may have persisted only the
   * token).  A token without metadata is still a fully-usable
   * session — every gateway call will succeed — and prompting the
   * user to sign in there causes a redirect that loses session
   * continuity for no reason.
   */
  hasFreshToken() {
    return this.tokenIsFresh();
  }
  /**
   * A stable id for whose data is on this browser, or null when nobody
   * is signed in. The user's id when the grant carried one; otherwise
   * derived from the token, which is bound to one user and one app and
   * never rotates. Used by Sync to tell an account switch.
   */
  ownerId() {
    if (!this.tokenIsFresh()) return null;
    if (this.userInfo?.id) return this.userInfo.id;
    return "t" + hash32(this.token).toString(36);
  }
  /**
   * Clear the cached token / user / badge and the persisted copy in
   * localStorage.  Next gateway call will trigger a redirect to the
   * grant page — i.e. the standard sign-in flow.  Wire this to a
   * "Sign out" button in the bundle's settings UI.
   *
   * Does NOT redirect on its own; the bundle decides whether to
   * also navigate the user (e.g. to a logged-out splash page) or
   * just refresh state and let the next API call re-prompt.
   */
  signOut() {
    this.token = null;
    this.expiresAt = 0;
    this.userInfo = null;
    this.parentHandshake = null;
    this.signingIn = false;
    this.clearPersisted();
    this.markSignedOut();
    this.removeBadge();
  }
  /**
   * Drop the in-memory + persisted token without setting the sticky
   * "signed out" flag.  Used by the transport layer when the gateway
   * returns 401 (token revoked server-side, e.g. user unsubscribed in
   * another tab).  The next `getToken()` will trigger the standard
   * `signIn()` redirect-grant flow and the user re-auths transparently.
   */
  invalidate() {
    this.token = null;
    this.expiresAt = 0;
    this.userInfo = null;
    this.parentHandshake = null;
    this.signingIn = false;
    this.clearPersisted();
  }
  /** Start the grant flow: a redirect (default) or, in popup mode, a
   *  popup window — then the returned promise resolves once the token
   *  has arrived (and rejects if the popup is closed first). */
  signIn() {
    if (typeof window === "undefined") return;
    if (this.signInMode === "popup") return this.signInPopup();
    if (this.signingIn) return;
    this.clearSignedOut();
    this.signingIn = true;
    location.href = this.grantUrlForThisPage();
  }
  grantUrlForThisPage(popup = false) {
    let ret = location.href.split("#")[0] ?? location.href;
    if (popup) {
      if (hasCallbackPage(location.hostname)) {
        const q = new URLSearchParams({ key: storageKey(this.project), origin: this.origin });
        ret = location.origin + POPUP_CALLBACK_PATH + "?" + q.toString();
      } else {
        const u = new URL(ret);
        u.searchParams.set(POPUP_PARAM, "1");
        ret = u.toString();
      }
    }
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    return this.buildGrantUrl({
      pageOrigin: location.origin,
      app: location.host,
      redirectTo: ret,
      scheme
    });
  }
  /** Popup grant flow. One popup at a time; concurrent callers share it. */
  signInPopup() {
    const now = Date.now();
    if (this.popupWait && now - this.popupOpenedAt < 3e3) return this.popupWait;
    this.clearSignedOut();
    const key = storageKey(this.project);
    const open = () => window.open(this.grantUrlForThisPage(true), POPUP_NAME, "popup=yes,width=520,height=700");
    let win = open();
    if (!win) {
      if (this.popupWait) return this.popupWait;
      this.popupWait = this.waitForUserGesture().then(() => {
        this.popupWait = null;
        win = open();
        if (!win) {
          this.signingIn = true;
          location.href = this.grantUrlForThisPage();
          return new Promise(() => {
          });
        }
        return this.waitForPopupToken(key, Date.now());
      });
      return this.popupWait;
    }
    if (this.popupWait) {
      this.popupOpenedAt = now;
      return this.popupWait;
    }
    return this.waitForPopupToken(key, now);
  }
  /** Resolves on the next click, tap or key press anywhere in the page. */
  waitForUserGesture() {
    return new Promise((resolve) => {
      const types = ["pointerdown", "keydown", "touchend"];
      const handler = () => {
        for (const t of types) window.removeEventListener(t, handler, true);
        resolve();
      };
      for (const t of types) window.addEventListener(t, handler, true);
    });
  }
  waitForPopupToken(key, openedAt) {
    this.popupOpenedAt = openedAt;
    this.popupWait = new Promise((resolve) => {
      let timer = 0;
      const adopt = () => {
        const before = this.token;
        this.loadPersisted();
        if (!this.tokenIsFresh()) return false;
        if (this.token !== before) this.setToken(this.token, this.expiresAt, this.userInfo ?? void 0);
        else if (this.userInfo && !this.hideBadge) this.renderBadge();
        window.removeEventListener("storage", onStorage);
        window.clearInterval(timer);
        this.popupWait = null;
        resolve();
        return true;
      };
      const onStorage = (e) => {
        if (e.key === key && e.newValue) adopt();
      };
      window.addEventListener("storage", onStorage);
      timer = window.setInterval(adopt, 1e3);
    });
    return this.popupWait;
  }
  /** Inside the popup, after the token landed: close, or say so. */
  finishPopup() {
    try {
      window.close();
    } catch {
    }
    if (window.closed) return;
    try {
      window.stop();
    } catch {
    }
    try {
      document.open();
      document.write(
        '<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#333;background:#fafafa;text-align:center"><div><p>Signed in. You can go back to the app.</p><button onclick="window.close()" style="padding:8px 16px;font:inherit;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer">Close this window</button></div></body></html>'
      );
      document.close();
    } catch {
    }
  }
  /**
   * Build the `/api/sdk/grant?…` URL the user is redirected to.  Split
   * out so tests can assert URL formation without a `window` context;
   * `signIn` is the only production caller.
   *
   * Public surface, but namespaced under `_buildGrantUrlForTest` so it
   * doesn't show up in IntelliSense as a normal API.
   */
  _buildGrantUrlForTest(args) {
    return this.buildGrantUrl(args);
  }
  /**
   * Return the localStorage keys this instance reads / writes for its
   * persisted token + sign-out flag.  Exposed for tests so we can
   * assert per-project namespacing without a real DOM; not part of
   * the public API surface (the leading underscore + `ForTest` suffix
   * is the SDK's convention for this).
   */
  _storageKeysForTest() {
    return {
      auth: storageKey(this.project),
      signedOut: signedOutKey(this.project)
    };
  }
  buildGrantUrl(args) {
    const params = new URLSearchParams();
    params.set("origin", args.pageOrigin);
    params.set("app", args.app);
    params.set("redirect_to", args.redirectTo);
    params.set("scheme", args.scheme);
    if (this.project) params.set("project_id", this.project);
    params.set("token_name", "runapps_token");
    return this.origin + "/api/sdk/grant?" + params.toString();
  }
  // ── Internals ────────────────────────────────────────────────────
  nowSec() {
    return Math.floor(Date.now() / 1e3);
  }
  tokenIsFresh() {
    return !!this.token && this.nowSec() < this.expiresAt - TOKEN_REFRESH_MARGIN_S;
  }
  inIframe() {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  }
  setToken(token, expiresAt, user) {
    this.token = token;
    this.expiresAt = expiresAt || this.nowSec() + 3600;
    if (user) {
      this.userInfo = user;
      if (!this.hideBadge) this.renderBadge();
    }
    this.savePersisted();
    for (const fn of this.listeners) {
      try {
        fn(token);
      } catch (err) {
        console.warn("[runapps] onTokenChange handler threw", err);
      }
    }
  }
  savePersisted() {
    if (typeof localStorage === "undefined" || !this.token) return;
    try {
      const data = {
        token: this.token,
        expiresAt: this.expiresAt,
        origin: this.origin,
        ...this.userInfo ? { user: this.userInfo } : {}
      };
      localStorage.setItem(storageKey(this.project), JSON.stringify(data));
    } catch {
    }
  }
  loadPersisted() {
    if (typeof localStorage === "undefined") return;
    try {
      let raw = localStorage.getItem(storageKey(this.project));
      if (!raw) {
        raw = localStorage.getItem(legacyStorageKey(this.project));
        if (!raw) return;
        localStorage.setItem(storageKey(this.project), raw);
        localStorage.removeItem(legacyStorageKey(this.project));
      }
      const data = JSON.parse(raw);
      if (!data.token || !data.origin) return;
      if (data.origin !== this.origin) return;
      if (typeof data.expiresAt === "number" && data.expiresAt > 0 && this.nowSec() >= data.expiresAt - TOKEN_REFRESH_MARGIN_S) {
        this.clearPersisted();
        return;
      }
      this.token = data.token;
      this.expiresAt = data.expiresAt ?? 0;
      if (data.user) this.userInfo = data.user;
    } catch {
      this.clearPersisted();
    }
  }
  clearPersisted() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(storageKey(this.project));
      localStorage.removeItem(legacyStorageKey(this.project));
    } catch {
    }
  }
  isSignedOut() {
    if (typeof localStorage === "undefined") return false;
    try {
      return localStorage.getItem(signedOutKey(this.project)) === "1" || localStorage.getItem(legacySignedOutKey(this.project)) === "1";
    } catch {
      return false;
    }
  }
  markSignedOut() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(signedOutKey(this.project), "1");
    } catch {
    }
  }
  clearSignedOut() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(signedOutKey(this.project));
      localStorage.removeItem(legacySignedOutKey(this.project));
    } catch {
    }
  }
  removeBadge() {
    if (typeof document === "undefined") return;
    document.getElementById("__runapps_identity__")?.remove();
  }
  /** Parse the #runapps_token=… fragment (or the older #runjobs_token=…),
   *  install, then strip it. */
  consumeFragment() {
    if (!location.hash || !/(^#|&)run(apps|jobs)_token=/.test(location.hash))
      return false;
    const params = {};
    location.hash.replace(/^#/, "").split("&").forEach((kv) => {
      const i = kv.indexOf("=");
      if (i >= 0) params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " "));
    });
    const token = params.runapps_token || params.runjobs_token;
    if (!token) return false;
    let user;
    if (params.user) {
      try {
        user = JSON.parse(params.user);
      } catch {
      }
    }
    this.setToken(
      token,
      parseInt(params.expires_at ?? "", 10) || 0,
      user
    );
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
    }
    return true;
  }
  /** postMessage handshake with the dashboard parent (iframe path). */
  requestTokenFromParent() {
    return new Promise((resolve, reject) => {
      let done2 = false;
      const timers = [];
      const cleanup = () => {
        done2 = true;
        window.removeEventListener("message", onMessage);
        for (const t of timers) clearTimeout(t);
      };
      const onMessage = (e) => {
        if (e.origin !== this.origin) return;
        const data = e.data;
        if (data && (data.type === "runapps:token" || data.type === "runjobs:token") && data.token) {
          this.setToken(data.token, data.expires_at ?? 0, data.user);
          cleanup();
          resolve();
        }
      };
      window.addEventListener("message", onMessage);
      const post = () => {
        if (done2) return;
        try {
          window.parent.postMessage({ type: "runapps:request-token" }, this.origin);
          window.parent.postMessage({ type: "runjobs:request-token" }, this.origin);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };
      post();
      for (const d of [250, 750, 1500, 3e3]) timers.push(setTimeout(post, d));
      timers.push(
        setTimeout(() => {
          if (done2) return;
          cleanup();
          reject(new Error("runapps: parent handshake timeout"));
        }, 5e3)
      );
    });
  }
  /** Floating identity badge — bottom-right pill showing the user.
   *  Click opens the runapps.ai dashboard in a new tab so the user
   *  can manage their account / billing without losing the bundle's
   *  in-flight state.  Uses `noopener,noreferrer` so the new tab
   *  can't reach back into the bundle window via `window.opener`. */
  renderBadge() {
    if (typeof document === "undefined" || !this.userInfo) return;
    const ID2 = "__runapps_identity__";
    const dashboardUrl = `${this.origin}/dashboard`;
    const ready = (cb) => document.body ? cb() : document.addEventListener("DOMContentLoaded", cb);
    ready(() => {
      document.getElementById(ID2)?.remove();
      const root = mountActivityBadge({
        id: ID2,
        user: this.userInfo,
        dashboardUrl,
        tracker: this.tracker,
        position: this.badgePosition,
        // Bind through `this` so the popover's Sign-out button runs
        // BrowserAuth.signOut (clears token cache + flips signed-out
        // flag + dispatches the auth event); a plain method reference
        // would lose `this`.
        //
        // Then hard-reload the page. signOut() deliberately doesn't
        // navigate (its contract leaves that to the host bundle), but
        // the badge IS the SDK's own UI, and a user clicking its
        // "Sign out" expects to land back on the app's signed-out /
        // login view — not keep staring at a now-stale authed page.
        // The reload re-runs the bundle's bootstrap against a cleared
        // token + the sticky signed-out flag, so the app naturally
        // shows its login state. Guard window for non-browser hosts.
        onSignOut: () => {
          this.signOut();
          if (typeof window !== "undefined") window.location.reload();
        }
      });
      document.body.appendChild(root);
    });
  }
};
function ensurePulseKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById("__runapps_kf__")) return;
  const style = document.createElement("style");
  style.id = "__runapps_kf__";
  style.textContent = "@keyframes __runapps_led_pulse__ {  0%   { box-shadow: 0 0 0 0   rgba(59,130,246,0.7); }  70%  { box-shadow: 0 0 0 6px rgba(59,130,246,0);   }  100% { box-shadow: 0 0 0 0   rgba(59,130,246,0);   }}@keyframes __runapps_sync_ping__ {  0%   { transform: scale(1);   opacity: 0.9; }  100% { transform: scale(2.1); opacity: 0;   }}";
  (document.head ?? document.documentElement).appendChild(style);
}
function badgeCornerStyles(position) {
  const v = position.startsWith("top") ? "top" : "bottom";
  const h = position.endsWith("right") ? "right" : "left";
  const popoverVerticalAnchor = v === "bottom" ? "bottom:calc(100% + 8px);top:auto" : "top:calc(100% + 8px);bottom:auto";
  const popoverHorizontalAnchor = h === "right" ? "right:0;left:auto" : "left:0;right:auto";
  return {
    badge: `${v}:16px;${h}:16px`,
    popover: `${popoverVerticalAnchor};${popoverHorizontalAnchor}`
  };
}
var BADGE_POS_COOKIE = "__runapps_badge_pos__";
var LEGACY_BADGE_POS_COOKIE = "__runjobs_badge_pos__";
var BADGE_DRAG_THRESHOLD_PX = 5;
var BADGE_EDGE_INSET_PX = 8;
function readBadgePosCookie() {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split(";").map((s) => s.trim());
  let name = BADGE_POS_COOKIE;
  let raw = cookies.find((s) => s.startsWith(name + "="));
  if (!raw) {
    name = LEGACY_BADGE_POS_COOKIE;
    raw = cookies.find((s) => s.startsWith(name + "="));
  }
  if (!raw) return null;
  const value = decodeURIComponent(raw.slice(name.length + 1));
  const parts = value.split(",");
  const rawX = parts[0];
  const rawY = parts[1];
  if (parts.length !== 2 || rawX === void 0 || rawY === void 0) return null;
  const x = Number.parseInt(rawX, 10);
  const y = Number.parseInt(rawY, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}
function writeBadgePosCookie(x, y) {
  if (typeof document === "undefined") return;
  const maxAge = 60 * 60 * 24 * 365;
  const secure = typeof window !== "undefined" && window.location?.protocol === "https:" ? ";Secure" : "";
  document.cookie = `${BADGE_POS_COOKIE}=${encodeURIComponent(`${Math.round(x)},${Math.round(y)}`)};path=/;max-age=${maxAge};SameSite=Lax${secure}`;
}
function clampToViewport(x, y, w, h) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const maxX = Math.max(BADGE_EDGE_INSET_PX, vw - w - BADGE_EDGE_INSET_PX);
  const maxY = Math.max(BADGE_EDGE_INSET_PX, vh - h - BADGE_EDGE_INSET_PX);
  return {
    x: Math.min(Math.max(BADGE_EDGE_INSET_PX, x), maxX),
    y: Math.min(Math.max(BADGE_EDGE_INSET_PX, y), maxY)
  };
}
function popoverCssForRect(rect) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const verticalAnchor = cy < vh / 2 ? "top:calc(100% + 8px);bottom:auto" : "bottom:calc(100% + 8px);top:auto";
  const horizontalAnchor = cx < vw / 2 ? "left:0;right:auto" : "right:0;left:auto";
  return `${verticalAnchor};${horizontalAnchor}`;
}
function mountActivityBadge(opts) {
  const { id, user, dashboardUrl, tracker, position, onSignOut } = opts;
  const corners = badgeCornerStyles(position);
  let currentPopoverCss = corners.popover;
  ensurePulseKeyframes();
  const el = document.createElement("button");
  el.id = id;
  el.type = "button";
  el.setAttribute("aria-label", "RunApps activity status");
  el.style.cssText = [
    "position:fixed",
    corners.badge,
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:5px",
    "border-radius:50%",
    "font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
    "color:#fff",
    "background:rgba(15,15,20,0.55)",
    "backdrop-filter:blur(10px) saturate(1.2)",
    "-webkit-backdrop-filter:blur(10px) saturate(1.2)",
    "border:1px solid rgba(255,255,255,0.12)",
    "box-shadow:0 4px 16px rgba(0,0,0,0.15)",
    "user-select:none",
    "-webkit-user-select:none",
    // Touch: without this the browser claims the first finger move as a
    // page scroll and fires pointercancel, so the badge could not be
    // dragged on phones. No callout either: a long press is a drag.
    "touch-action:none",
    "-webkit-touch-callout:none",
    "overflow:visible",
    // popover spills out the top
    "cursor:pointer",
    "appearance:none",
    "-webkit-appearance:none",
    "transition:background-color 120ms ease-out, box-shadow 120ms ease-out"
  ].join(";");
  el.addEventListener("mouseenter", () => {
    el.style.backgroundColor = "rgba(30,30,40,0.7)";
    el.style.boxShadow = "0 6px 20px rgba(0,0,0,0.22)";
  });
  el.addEventListener("mouseleave", () => {
    el.style.backgroundColor = "rgba(15,15,20,0.55)";
    el.style.boxShadow = "0 4px 16px rgba(0,0,0,0.15)";
  });
  const avatarWrap = document.createElement("span");
  avatarWrap.style.cssText = [
    "position:relative",
    "width:26px;height:26px",
    "flex-shrink:0",
    "display:inline-flex;align-items:center;justify-content:center"
  ].join(";");
  const ringNS = "http://www.w3.org/2000/svg";
  const ring = document.createElementNS(ringNS, "svg");
  ring.setAttribute("viewBox", "0 0 26 26");
  ring.setAttribute("width", "26");
  ring.setAttribute("height", "26");
  ring.style.cssText = [
    "position:absolute;inset:0",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity 200ms ease-out"
  ].join(";");
  const ringTrack = document.createElementNS(ringNS, "circle");
  ringTrack.setAttribute("cx", "13");
  ringTrack.setAttribute("cy", "13");
  ringTrack.setAttribute("r", "12");
  ringTrack.setAttribute("fill", "none");
  ringTrack.setAttribute("stroke", "rgba(255,255,255,0.08)");
  ringTrack.setAttribute("stroke-width", "1.5");
  const ringArc = document.createElementNS(ringNS, "circle");
  ringArc.setAttribute("cx", "13");
  ringArc.setAttribute("cy", "13");
  ringArc.setAttribute("r", "12");
  ringArc.setAttribute("fill", "none");
  ringArc.setAttribute("stroke", "#3b82f6");
  ringArc.setAttribute("stroke-width", "2");
  ringArc.setAttribute("stroke-linecap", "round");
  ringArc.setAttribute("transform", "rotate(-90 13 13)");
  const RING_CIRC = 2 * Math.PI * 12;
  ringArc.setAttribute("stroke-dasharray", String(RING_CIRC));
  ringArc.setAttribute("stroke-dashoffset", String(RING_CIRC));
  ring.appendChild(ringTrack);
  ring.appendChild(ringArc);
  const avatar = document.createElement("div");
  avatar.textContent = (user.name || "?").charAt(0).toUpperCase();
  avatar.style.cssText = [
    "width:22px;height:22px;border-radius:50%;flex-shrink:0",
    "display:flex;align-items:center;justify-content:center",
    "background:linear-gradient(135deg,#3b82f6,#8b5cf6)",
    "font-size:11px;font-weight:600;color:#fff",
    "position:relative"
  ].join(";");
  const led = document.createElement("span");
  led.style.cssText = [
    "position:absolute",
    "bottom:-1px;right:-1px",
    "width:7px;height:7px;border-radius:50%",
    "background:rgba(255,255,255,0.2)",
    "border:1.5px solid rgba(15,15,20,1)",
    "box-shadow:0 0 0 0 transparent",
    // Hidden at rest: it only appears while something is happening
    // (syncing, offline, an error, the green flash after a sync).
    "opacity:0",
    "transition:background-color 150ms ease-out, box-shadow 200ms ease-out, opacity 200ms ease-out",
    "pointer-events:none"
  ].join(";");
  avatarWrap.appendChild(ring);
  avatarWrap.appendChild(avatar);
  avatarWrap.appendChild(led);
  el.appendChild(avatarWrap);
  let popover = null;
  let popoverOpen = false;
  let popoverOpenedBy = null;
  let openTimer = null;
  let closeTimer = null;
  const cancelOpen = () => {
    if (openTimer !== null) {
      window.clearTimeout(openTimer);
      openTimer = null;
    }
  };
  const cancelClose = () => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = window.setTimeout(() => {
      if (popoverOpenedBy === "hover") closePopover();
    }, 300);
  };
  const openPopover = (by) => {
    cancelOpen();
    cancelClose();
    if (popoverOpen) {
      if (by === "click") popoverOpenedBy = "click";
      return;
    }
    if (!popover) {
      popover = createPopover(user, dashboardUrl, currentPopoverCss, () => {
        closePopover();
        onSignOut();
      });
      popover.addEventListener("mouseenter", cancelClose);
      popover.addEventListener("mouseleave", () => {
        if (popoverOpenedBy === "hover") scheduleClose();
      });
    }
    el.appendChild(popover);
    popoverOpen = true;
    popoverOpenedBy = by;
    requestRedraw();
  };
  const closePopover = () => {
    cancelClose();
    if (!popoverOpen) return;
    popover?.remove();
    popoverOpen = false;
    popoverOpenedBy = null;
  };
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    popoverOpen ? closePopover() : openPopover("click");
  });
  el.addEventListener("mouseenter", () => {
    cancelClose();
    cancelOpen();
    openTimer = window.setTimeout(() => {
      if (!popoverOpen) openPopover("hover");
    }, 400);
  });
  el.addEventListener("mouseleave", () => {
    cancelOpen();
    if (popoverOpenedBy === "hover") scheduleClose();
  });
  document.addEventListener("click", (e) => {
    if (popoverOpen && !el.contains(e.target)) closePopover();
  });
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragStartBadgeLeft = 0;
  let dragStartBadgeTop = 0;
  let pointerDown = false;
  let isDragging = false;
  let suppressNextClick = false;
  const applyAbsolutePos = (x, y) => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  };
  const recomputePopoverAnchor = () => {
    const r = el.getBoundingClientRect();
    currentPopoverCss = popoverCssForRect({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height
    });
    if (popover) {
      popover.style.top = "";
      popover.style.bottom = "";
      popover.style.left = "";
      popover.style.right = "";
      for (const decl of currentPopoverCss.split(";")) {
        const [prop, val] = decl.split(":");
        if (prop && val) popover.style.setProperty(prop.trim(), val.trim());
      }
    }
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pointerDown = true;
    isDragging = false;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    const r = el.getBoundingClientRect();
    dragStartBadgeLeft = r.left;
    dragStartBadgeTop = r.top;
  });
  el.addEventListener("pointermove", (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - dragStartClientX;
    const dy = e.clientY - dragStartClientY;
    if (!isDragging) {
      if (Math.abs(dx) < BADGE_DRAG_THRESHOLD_PX && Math.abs(dy) < BADGE_DRAG_THRESHOLD_PX) {
        return;
      }
      isDragging = true;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
      }
      el.style.cursor = "grabbing";
      if (popoverOpen) closePopover();
    }
    const rect = el.getBoundingClientRect();
    const clamped = clampToViewport(
      dragStartBadgeLeft + dx,
      dragStartBadgeTop + dy,
      rect.width,
      rect.height
    );
    applyAbsolutePos(clamped.x, clamped.y);
  });
  const endDrag = (e) => {
    if (!pointerDown) return;
    pointerDown = false;
    if (!isDragging) return;
    isDragging = false;
    el.style.cursor = "pointer";
    try {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
    }
    const r = el.getBoundingClientRect();
    writeBadgePosCookie(r.left, r.top);
    recomputePopoverAnchor();
    suppressNextClick = true;
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener(
    "click",
    (e) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
  const savedPos = readBadgePosCookie();
  if (savedPos) {
    applyAbsolutePos(savedPos.x, savedPos.y);
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const clamped = clampToViewport(savedPos.x, savedPos.y, r.width, r.height);
      applyAbsolutePos(clamped.x, clamped.y);
      recomputePopoverAnchor();
    });
  }
  let rafScheduled = false;
  let intervalHandle = null;
  let seenChangeAt = void 0;
  const reconcile = () => {
    rafScheduled = false;
    if (!tracker) {
      ring.style.opacity = "0";
      led.style.background = "rgba(255,255,255,0.2)";
      led.style.opacity = "0";
      return;
    }
    const snap = tracker.snapshot();
    const changeAt = snap.sync?.lastChangeAt;
    if (changeAt && changeAt !== seenChangeAt) {
      seenChangeAt = changeAt;
      syncedPing(avatarWrap, led);
    }
    updateRing(ring, ringArc, RING_CIRC, snap);
    updateLED(led, snap);
    if (popoverOpen && popover) updatePopover(popover, snap);
    const needsLoop = snap.status !== "idle" || popoverOpen;
    if (needsLoop && intervalHandle === null) {
      intervalHandle = window.setInterval(requestRedraw, 160);
    } else if (!needsLoop && intervalHandle !== null) {
      window.clearInterval(intervalHandle);
      intervalHandle = null;
    }
  };
  function requestRedraw() {
    if (rafScheduled) return;
    rafScheduled = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(reconcile);
    } else {
      setTimeout(reconcile, 0);
    }
  }
  if (tracker) {
    tracker.onChange(requestRedraw);
  }
  requestRedraw();
  return el;
}
function updateRing(ring, arc, circ, snap) {
  if (snap.active.length === 0) {
    ring.style.opacity = "0";
    return;
  }
  ring.style.opacity = "1";
  const primary = snap.active.reduce((best, c) => c.tokensPerSec > best.tokensPerSec ? c : best, snap.active[0]);
  if (primary.streaming && primary.tokensPerSec > 0) {
    const fraction = Math.min(primary.tokensPerSec / 60, 1);
    arc.setAttribute("stroke-dashoffset", String(circ * (1 - fraction)));
    arc.setAttribute("stroke", "#3b82f6");
  } else if (snap.status === "error") {
    arc.setAttribute("stroke-dashoffset", "0");
    arc.setAttribute("stroke", "#ef4444");
  } else {
    arc.setAttribute("stroke-dashoffset", String(circ * 0.75));
    arc.setAttribute("stroke", "#a78bfa");
  }
}
var syncFlashUntil = 0;
function syncedPing(avatarWrap, led) {
  const ping = document.createElement("span");
  ping.style.cssText = [
    "position:absolute;inset:0",
    "border-radius:50%",
    "border:2px solid #10b981",
    "pointer-events:none",
    "animation:__runapps_sync_ping__ 700ms ease-out forwards"
  ].join(";");
  ping.addEventListener("animationend", () => ping.remove());
  avatarWrap.appendChild(ping);
  setTimeout(() => ping.remove(), 1e3);
  syncFlashUntil = Date.now() + 1200;
  led.style.opacity = "1";
  led.style.background = "#10b981";
  led.style.boxShadow = "0 0 0 2px rgba(16,185,129,0.35)";
  led.style.animation = "";
  setTimeout(() => {
    if (Date.now() >= syncFlashUntil) {
      led.style.background = "rgba(255,255,255,0.2)";
      led.style.opacity = "0";
      led.style.boxShadow = "0 0 0 0 transparent";
    }
  }, 1250);
}
function updateLED(led, snap) {
  led.style.opacity = "1";
  switch (snap.status) {
    case "idle": {
      const sync = snap.sync;
      if (Date.now() < syncFlashUntil) {
        led.style.background = "#10b981";
        led.style.boxShadow = "0 0 0 2px rgba(16,185,129,0.35)";
        led.style.animation = "";
      } else if (sync && sync.state === "syncing") {
        led.style.background = "#3b82f6";
        led.style.boxShadow = "0 0 0 0 rgba(59,130,246,0.7)";
        led.style.animation = "__runapps_led_pulse__ 1.2s ease-out infinite";
      } else if (sync && (sync.state === "offline" || sync.state === "error")) {
        led.style.background = "#f59e0b";
        led.style.boxShadow = "0 0 0 2px rgba(245,158,11,0.3)";
        led.style.animation = "";
      } else {
        led.style.background = "rgba(255,255,255,0.2)";
        led.style.opacity = "0";
        led.style.boxShadow = "0 0 0 0 transparent";
        led.style.animation = "";
      }
      break;
    }
    case "active":
      led.style.background = "#3b82f6";
      led.style.boxShadow = "0 0 0 0 rgba(59,130,246,0.7)";
      led.style.animation = "__runapps_led_pulse__ 1.2s ease-out infinite";
      break;
    case "error":
      led.style.background = "#ef4444";
      led.style.boxShadow = "0 0 0 2px rgba(239,68,68,0.3)";
      led.style.animation = "";
      break;
  }
}
function createPopover(user, dashboardUrl, anchorCss, onSignOut) {
  const pop = document.createElement("div");
  pop.style.cssText = [
    "position:absolute",
    // Anchor varies by badge corner — see badgeCornerStyles. Splits
    // top/bottom + left/right so the popover always grows TOWARDS
    // the viewport interior.
    anchorCss,
    "min-width:280px;max-width:340px",
    "padding:10px 12px",
    "border-radius:10px",
    "background:rgba(15,15,20,0.92)",
    "backdrop-filter:blur(20px) saturate(1.3)",
    "-webkit-backdrop-filter:blur(20px) saturate(1.3)",
    "border:1px solid rgba(255,255,255,0.12)",
    "box-shadow:0 10px 30px rgba(0,0,0,0.4)",
    "color:#fff",
    "font:400 11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
    "cursor:default",
    "text-align:left"
  ].join(";");
  pop.setAttribute("data-runapps-popover", "1");
  pop.addEventListener("click", (e) => e.stopPropagation());
  const header = document.createElement("div");
  header.style.cssText = [
    "display:flex;align-items:center;gap:8px",
    "margin-bottom:10px;padding-bottom:8px",
    "border-bottom:1px solid rgba(255,255,255,0.08)"
  ].join(";");
  const headAvatar = document.createElement("div");
  headAvatar.textContent = (user.name || "?").charAt(0).toUpperCase();
  headAvatar.style.cssText = [
    "width:24px;height:24px;border-radius:50%;flex-shrink:0",
    "display:flex;align-items:center;justify-content:center",
    "background:linear-gradient(135deg,#3b82f6,#8b5cf6)",
    "font-size:11px;font-weight:600;color:#fff"
  ].join(";");
  const headName = document.createElement("div");
  headName.textContent = user.name || "Signed in";
  headName.title = user.name || "";
  headName.style.cssText = "font-size:12px;font-weight:500;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const headSub = document.createElement("div");
  headSub.textContent = "Signed in with RunApps";
  headSub.style.cssText = "font-size:10px;color:rgba(255,255,255,0.5)";
  const headText = document.createElement("div");
  headText.style.cssText = "min-width:0";
  headText.appendChild(headName);
  headText.appendChild(headSub);
  header.appendChild(headAvatar);
  header.appendChild(headText);
  pop.appendChild(header);
  const inner = document.createElement("div");
  inner.setAttribute("data-runapps-popover-content", "1");
  pop.appendChild(inner);
  const footer = document.createElement("div");
  footer.style.cssText = [
    "margin-top:10px;padding-top:8px",
    "border-top:1px solid rgba(255,255,255,0.08)",
    "display:flex;justify-content:space-between;align-items:center",
    "font-size:10px;color:rgba(255,255,255,0.6)"
  ].join(";");
  const dash = document.createElement("a");
  dash.textContent = "Open dashboard \u2192";
  dash.href = dashboardUrl;
  dash.target = "_blank";
  dash.rel = "noopener noreferrer";
  dash.style.cssText = "color:#a78bfa;text-decoration:none";
  footer.appendChild(dash);
  const signOutBtn = document.createElement("button");
  signOutBtn.type = "button";
  signOutBtn.textContent = "Sign out";
  signOutBtn.style.cssText = [
    "background:none;border:0;padding:0;margin:0",
    "font:inherit;cursor:pointer",
    "color:rgba(255,255,255,0.55)",
    "transition:color 120ms ease"
  ].join(";");
  signOutBtn.addEventListener("mouseenter", () => {
    signOutBtn.style.color = "#f87171";
  });
  signOutBtn.addEventListener("mouseleave", () => {
    signOutBtn.style.color = "rgba(255,255,255,0.55)";
  });
  signOutBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onSignOut();
  });
  footer.appendChild(signOutBtn);
  pop.appendChild(footer);
  return pop;
}
function updatePopover(pop, snap) {
  const inner = pop.querySelector("[data-runapps-popover-content]");
  if (!inner) return;
  inner.innerHTML = "";
  const now = Date.now();
  inner.appendChild(renderActiveSection(snap, now));
  inner.appendChild(renderRecentSection(snap, now));
  if (snap.sync) inner.appendChild(renderSyncSection(snap.sync, now));
  inner.appendChild(renderSessionSection(snap.session, now));
}
function renderSyncSection(sync, now) {
  const sec = document.createElement("div");
  sec.style.marginBottom = "10px";
  const hint = sync.lastSyncedAt ? `synced ${relativeTime(now - sync.lastSyncedAt)}` : "\u2014";
  sec.appendChild(sectionLabel("Sync", hint));
  const row = document.createElement("div");
  row.style.cssText = "display:flex;justify-content:space-between;gap:8px;padding:3px 0;font-size:10px";
  const left = document.createElement("span");
  const dot = document.createElement("span");
  dot.textContent = "\u25CF ";
  const label = {
    off: ["Not signed in", "rgba(255,255,255,0.4)"],
    idle: ["Up to date", "#10b981"],
    syncing: ["Syncing\u2026", "#3b82f6"],
    offline: ["Offline", "#f59e0b"],
    error: ["Retrying", "#f59e0b"]
  };
  const [text, color] = label[sync.state] ?? ["", "#fff"];
  dot.style.color = color;
  left.style.color = "#fff";
  left.appendChild(dot);
  left.appendChild(document.createTextNode(text));
  const right = document.createElement("span");
  right.style.cssText = "color:rgba(255,255,255,0.7);font-variant-numeric:tabular-nums";
  right.textContent = sync.pending > 0 ? `${sync.pending} pending` : "";
  right.title = sync.error ?? "";
  row.appendChild(left);
  row.appendChild(right);
  sec.appendChild(row);
  return sec;
}
function renderActiveSection(snap, now) {
  const sec = document.createElement("div");
  sec.style.marginBottom = "10px";
  sec.appendChild(sectionLabel("Active", snap.active.length > 0 ? `${snap.active.length} in flight` : "\u2014"));
  if (snap.active.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:rgba(255,255,255,0.4);font-size:10px;padding:2px 0";
    empty.textContent = "No calls in flight.";
    sec.appendChild(empty);
    return sec;
  }
  for (const c of snap.active) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:8px;padding:3px 0";
    const left = document.createElement("span");
    left.style.cssText = "color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px";
    left.textContent = c.model;
    const right = document.createElement("span");
    right.style.cssText = "color:rgba(255,255,255,0.7);font-variant-numeric:tabular-nums;font-size:10px";
    const elapsed = ((now - c.startedAt) / 1e3).toFixed(1);
    const rate = c.tokensPerSec > 0 ? ` \xB7 ${Math.round(c.tokensPerSec)} tok/s` : "";
    right.textContent = `${elapsed}s${rate}`;
    row.appendChild(left);
    row.appendChild(right);
    sec.appendChild(row);
  }
  return sec;
}
function renderRecentSection(snap, now) {
  const sec = document.createElement("div");
  sec.style.marginBottom = "10px";
  sec.appendChild(sectionLabel("Recent", snap.recent.length > 0 ? `last ${Math.min(snap.recent.length, 5)}` : "\u2014"));
  if (snap.recent.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:rgba(255,255,255,0.4);font-size:10px;padding:2px 0";
    empty.textContent = "Nothing yet this session.";
    sec.appendChild(empty);
    return sec;
  }
  for (const c of snap.recent.slice(0, 5)) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:8px;padding:3px 0";
    const left = document.createElement("span");
    left.style.cssText = "color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px";
    const bullet = document.createElement("span");
    bullet.textContent = c.ok ? "\u2713 " : "\u2717 ";
    bullet.style.color = c.ok ? "#10b981" : "#ef4444";
    left.appendChild(bullet);
    left.appendChild(document.createTextNode(c.model));
    const right = document.createElement("span");
    right.style.cssText = "color:rgba(255,255,255,0.7);font-variant-numeric:tabular-nums;font-size:10px";
    const latency = `${(c.latencyMs / 1e3).toFixed(1)}s`;
    const cost = c.costUSD !== void 0 ? ` \xB7 $${c.costUSD.toFixed(4)}` : "";
    const ago = ` \xB7 ${relativeTime(now - c.endedAt)}`;
    right.textContent = `${latency}${cost}${ago}`;
    row.appendChild(left);
    row.appendChild(right);
    sec.appendChild(row);
  }
  return sec;
}
function renderSessionSection(s, now) {
  const sec = document.createElement("div");
  sec.appendChild(sectionLabel("Session", relativeTime(now - s.startedAt)));
  const row = document.createElement("div");
  row.style.cssText = "display:flex;justify-content:space-between;gap:12px;color:rgba(255,255,255,0.85);font-size:10px";
  const calls = document.createElement("span");
  calls.textContent = `${s.totalCalls} call${s.totalCalls === 1 ? "" : "s"}`;
  const cost = document.createElement("span");
  cost.textContent = `$${s.totalCostUSD.toFixed(4)}`;
  const errors = document.createElement("span");
  errors.textContent = s.errorCount > 0 ? `${s.errorCount} error${s.errorCount === 1 ? "" : "s"}` : "0 errors";
  if (s.errorCount > 0) errors.style.color = "#ef4444";
  row.appendChild(calls);
  row.appendChild(cost);
  row.appendChild(errors);
  sec.appendChild(row);
  return sec;
}
function sectionLabel(title, hint) {
  const lbl = document.createElement("div");
  lbl.style.cssText = [
    "display:flex;justify-content:space-between;align-items:baseline",
    "margin-bottom:4px",
    "color:rgba(255,255,255,0.55)",
    "font-size:10px;text-transform:uppercase;letter-spacing:0.05em"
  ].join(";");
  const t = document.createElement("span");
  t.textContent = title;
  const h = document.createElement("span");
  h.textContent = hint;
  h.style.cssText = "font-size:9px;letter-spacing:0";
  lbl.appendChild(t);
  lbl.appendChild(h);
  return lbl;
}
function relativeTime(ms) {
  if (ms < 1500) return "just now";
  if (ms < 6e4) return `${Math.round(ms / 1e3)}s ago`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)}m ago`;
  return `${Math.round(ms / 36e5)}h ago`;
}

// src/sync/hook.ts
var txState = /* @__PURE__ */ new WeakMap();
var observedDbs = /* @__PURE__ */ new WeakMap();
var subscribers = /* @__PURE__ */ new Set();
var originals = null;
function clone(v) {
  try {
    return typeof structuredClone === "function" ? structuredClone(v) : v;
  } catch {
    return v;
  }
}
function isPlainObject2(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function makeEvent(type, init, target) {
  let ev;
  if (init && typeof IDBVersionChangeEvent === "function") {
    ev = new IDBVersionChangeEvent(type, { oldVersion: init.oldVersion, newVersion: init.newVersion ?? null });
  } else {
    ev = new Event(type, { bubbles: false, cancelable: type === "error" });
    if (init) Object.assign(ev, init);
  }
  if (target) {
    for (const p of ["target", "currentTarget", "srcElement"]) {
      try {
        Object.defineProperty(ev, p, { value: target, configurable: true });
      } catch {
      }
    }
  }
  return ev;
}
var HookedOpenRequest = class {
  constructor(real, name, subs) {
    __publicField(this, "readyState", "pending");
    __publicField(this, "result");
    __publicField(this, "error", null);
    __publicField(this, "transaction", null);
    __publicField(this, "source", null);
    __publicField(this, "listeners", /* @__PURE__ */ new Map());
    __publicField(this, "handlers", { success: null, error: null, blocked: null, upgradeneeded: null });
    real.addEventListener("upgradeneeded", (ev) => {
      const e = ev;
      this.result = real.result;
      this.transaction = real.transaction;
      observedDbs.set(real.result, { name, subs });
      this.dispatch(makeEvent("upgradeneeded", { oldVersion: e.oldVersion, newVersion: e.newVersion }, this));
    });
    real.addEventListener("blocked", (ev) => {
      const e = ev;
      this.dispatch(makeEvent("blocked", { oldVersion: e.oldVersion, newVersion: e.newVersion }, this));
    });
    real.addEventListener("error", () => {
      this.error = real.error;
      this.readyState = "done";
      this.transaction = null;
      this.dispatch(makeEvent("error", void 0, this));
    });
    real.addEventListener("success", () => {
      const db = real.result;
      observedDbs.set(db, { name, subs });
      this.transaction = null;
      let settled = false;
      const deliver = () => {
        if (settled) return;
        settled = true;
        this.result = db;
        this.readyState = "done";
        this.dispatch(makeEvent("success", void 0, this));
      };
      const waits = [];
      let timeout = 0;
      for (const s of subs) {
        try {
          const p = s.opts.onOpen(db, name);
          if (p && typeof p.then === "function") {
            waits.push(p.catch(() => {
            }));
            timeout = Math.max(timeout, s.opts.openTimeoutMs);
          }
        } catch {
        }
      }
      if (waits.length === 0) {
        deliver();
        return;
      }
      const timer = setTimeout(deliver, timeout);
      Promise.all(waits).then(() => {
        clearTimeout(timer);
        deliver();
      });
    });
  }
  addEventListener(type, listener) {
    if (!listener) return;
    const fn = typeof listener === "function" ? listener : (ev) => listener.handleEvent(ev);
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, set = /* @__PURE__ */ new Set());
    set.add(fn);
    listener.__rtFn = fn;
  }
  removeEventListener(type, listener) {
    if (!listener) return;
    const fn = typeof listener === "function" ? listener : listener.__rtFn;
    if (fn) this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(ev) {
    this.dispatch(ev);
    return !ev.defaultPrevented;
  }
  dispatch(ev) {
    const h = this.handlers[ev.type];
    if (h) {
      try {
        h.call(this, ev);
      } catch (err) {
        reportListenerError(err);
      }
    }
    for (const fn of this.listeners.get(ev.type) ?? []) {
      try {
        fn.call(this, ev);
      } catch (err) {
        reportListenerError(err);
      }
    }
  }
  get onsuccess() {
    return this.handlers.success ?? null;
  }
  set onsuccess(h) {
    this.handlers.success = h;
  }
  get onerror() {
    return this.handlers.error ?? null;
  }
  set onerror(h) {
    this.handlers.error = h;
  }
  get onblocked() {
    return this.handlers.blocked ?? null;
  }
  set onblocked(h) {
    this.handlers.blocked = h;
  }
  get onupgradeneeded() {
    return this.handlers.upgradeneeded ?? null;
  }
  set onupgradeneeded(h) {
    this.handlers.upgradeneeded = h;
  }
};
function reportListenerError(err) {
  setTimeout(() => {
    throw err;
  }, 0);
}
if (typeof IDBOpenDBRequest === "function") {
  Object.setPrototypeOf(HookedOpenRequest.prototype, IDBOpenDBRequest.prototype);
}
function cursorStore(cursor) {
  const src = cursor.source;
  return typeof IDBIndex === "function" && src instanceof IDBIndex ? src.objectStore : src;
}
function subscribersFor(factory, name) {
  if (name.startsWith("__runapps")) return [];
  const out = [];
  for (const s of subscribers) {
    if ((s.factory === null || s.factory === factory) && s.opts.include(name)) out.push(s);
  }
  return out;
}
function patchPrototypes() {
  const F = IDBFactory.prototype;
  const D = IDBDatabase.prototype;
  const S = IDBObjectStore.prototype;
  const C = IDBCursor.prototype;
  const o = originals = {
    open: F.open,
    deleteDatabase: F.deleteDatabase,
    transaction: D.transaction,
    put: S.put,
    add: S.add,
    get: S.get,
    delete: S.delete,
    clear: S.clear,
    getAllKeys: S.getAllKeys,
    cursorUpdate: C.update,
    cursorDelete: C.delete
  };
  const tracked = (store) => txState.get(store.transaction) ?? null;
  F.open = function(name, version) {
    const real = version === void 0 ? o.open.call(this, name) : o.open.call(this, name, version);
    const subs = subscribersFor(this, name);
    if (subs.length === 0) return real;
    return new HookedOpenRequest(real, name, subs);
  };
  F.deleteDatabase = function(name) {
    for (const s of subscribersFor(this, name)) {
      try {
        s.opts.onDeleteDatabase(name);
      } catch {
      }
    }
    return o.deleteDatabase.call(this, name);
  };
  D.transaction = function(storeNames, mode, options) {
    const tx = options !== void 0 ? o.transaction.call(this, storeNames, mode, options) : mode !== void 0 ? o.transaction.call(this, storeNames, mode) : o.transaction.call(this, storeNames);
    const info = observedDbs.get(this);
    if (info && tx.mode === "readwrite") {
      const st = { db: info.name, subs: info.subs, ops: [] };
      txState.set(tx, st);
      tx.addEventListener("complete", () => {
        if (st.ops.length === 0) return;
        const ops = st.ops;
        st.ops = [];
        for (const s of st.subs) {
          const mine = ops.filter((op) => !s.opts.excludeStore(st.db, op.store));
          if (mine.length === 0) continue;
          try {
            s.opts.onCommit(st.db, mine);
          } catch (err) {
            reportListenerError(err);
          }
        }
      });
    }
    return tx;
  };
  S.put = function(value, key) {
    const st = tracked(this);
    let prior = null;
    if (st && isPlainObject2(value)) {
      const k = key !== void 0 ? key : extractKey(value, this.keyPath);
      if (k !== void 0) {
        try {
          const g = o.get.call(this, k);
          const slot = prior = { value: void 0 };
          g.addEventListener("success", () => {
            slot.value = g.result;
          });
        } catch {
          prior = null;
        }
      }
    }
    const r = key === void 0 ? o.put.call(this, value) : o.put.call(this, value, key);
    if (st) {
      const store = this.name;
      const snapshot = clone(value);
      const priorSlot = prior;
      r.addEventListener("success", () => {
        st.ops.push({ store, kind: "put", key: r.result, value: snapshot, prior: priorSlot?.value });
      });
    }
    return r;
  };
  S.add = function(value, key) {
    const r = key === void 0 ? o.add.call(this, value) : o.add.call(this, value, key);
    const st = tracked(this);
    if (st) {
      const store = this.name;
      const snapshot = clone(value);
      r.addEventListener("success", () => {
        st.ops.push({ store, kind: "put", key: r.result, value: snapshot });
      });
    }
    return r;
  };
  S.delete = function(query) {
    const st = tracked(this);
    if (st) {
      const store = this.name;
      if (typeof IDBKeyRange === "function" && query instanceof IDBKeyRange) {
        const kr = o.getAllKeys.call(this, query);
        kr.addEventListener("success", () => {
          for (const k of kr.result) st.ops.push({ store, kind: "del", key: k });
        });
      } else {
        st.ops.push({ store, kind: "del", key: query });
      }
    }
    return o.delete.call(this, query);
  };
  S.clear = function() {
    const st = tracked(this);
    const r = o.clear.call(this);
    if (st) {
      const store = this.name;
      r.addEventListener("success", () => {
        st.ops.push({ store, kind: "clear" });
      });
    }
    return r;
  };
  C.update = function(value) {
    const store = cursorStore(this);
    const st = tracked(store);
    const prior = st ? clone(this.value) : void 0;
    const r = o.cursorUpdate.call(this, value);
    if (st) {
      const name = store.name;
      const snapshot = clone(value);
      const key = this.primaryKey;
      r.addEventListener("success", () => {
        st.ops.push({ store: name, kind: "put", key, value: snapshot, prior });
      });
    }
    return r;
  };
  C.delete = function() {
    const store = cursorStore(this);
    const st = tracked(store);
    if (st) st.ops.push({ store: store.name, kind: "del", key: this.primaryKey });
    return o.cursorDelete.call(this);
  };
}
function restorePrototypes() {
  if (!originals) return;
  const o = originals;
  IDBFactory.prototype.open = o.open;
  IDBFactory.prototype.deleteDatabase = o.deleteDatabase;
  IDBDatabase.prototype.transaction = o.transaction;
  IDBObjectStore.prototype.put = o.put;
  IDBObjectStore.prototype.add = o.add;
  IDBObjectStore.prototype.delete = o.delete;
  IDBObjectStore.prototype.clear = o.clear;
  IDBCursor.prototype.update = o.cursorUpdate;
  IDBCursor.prototype.delete = o.cursorDelete;
  originals = null;
}
function installIndexedDBHook(opts) {
  if (typeof indexedDB === "undefined" || typeof IDBFactory !== "function" || typeof IDBDatabase !== "function" || typeof IDBObjectStore !== "function" || typeof IDBCursor !== "function") {
    return null;
  }
  if (!originals) patchPrototypes();
  const o = originals;
  const sub = { opts, factory: opts.factory ?? indexedDB };
  subscribers.add(sub);
  const factory = sub.factory;
  return {
    originalOpen: (name, version) => version === void 0 ? o.open.call(factory, name) : o.open.call(factory, name, version),
    uninstall() {
      subscribers.delete(sub);
      if (subscribers.size === 0) restorePrototypes();
    }
  };
}

// src/sync/log.ts
var SYNC_DB_NAME = "__runapps_sync__";
var SYNC_DB_VERSION = 1;
function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}
var SyncLog = class {
  constructor(open) {
    __publicField(this, "open", open);
    __publicField(this, "dbPromise", null);
  }
  db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const r = this.open(SYNC_DB_NAME, SYNC_DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("ops")) {
            const ops = db.createObjectStore("ops", { keyPath: "id", autoIncrement: true });
            ops.createIndex("store", ["db", "store"], { unique: false });
          }
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        };
        r.onsuccess = () => {
          const db = r.result;
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };
        r.onerror = () => reject(r.error ?? new Error("cannot open sync log"));
        r.onblocked = () => reject(new Error("sync log open blocked"));
      });
      this.dbPromise.catch(() => {
        this.dbPromise = null;
      });
    }
    return this.dbPromise;
  }
  async append(ops) {
    if (ops.length === 0) return;
    const db = await this.db();
    const tx = db.transaction("ops", "readwrite");
    const st = tx.objectStore("ops");
    for (const op of ops) st.add(op);
    await done(tx);
  }
  async pending() {
    const db = await this.db();
    const tx = db.transaction("ops", "readonly");
    const all = await req(tx.objectStore("ops").getAll());
    return all;
  }
  async pendingCount() {
    const db = await this.db();
    const tx = db.transaction("ops", "readonly");
    return req(tx.objectStore("ops").count());
  }
  async remove(ids) {
    if (ids.length === 0) return;
    const db = await this.db();
    const tx = db.transaction("ops", "readwrite");
    const st = tx.objectStore("ops");
    for (const id of ids) st.delete(id);
    await done(tx);
  }
  async clearOps() {
    const db = await this.db();
    const tx = db.transaction("ops", "readwrite");
    tx.objectStore("ops").clear();
    await done(tx);
  }
  async getMeta(key) {
    const db = await this.db();
    const tx = db.transaction("meta", "readonly");
    return await req(tx.objectStore("meta").get(key));
  }
  async setMeta(entries) {
    const db = await this.db();
    const tx = db.transaction("meta", "readwrite");
    const st = tx.objectStore("meta");
    for (const k of Object.keys(entries)) {
      if (entries[k] === void 0) st.delete(k);
      else st.put(entries[k], k);
    }
    await done(tx);
  }
  /** Every meta entry whose key starts with `prefix`, as a map. */
  async metaWithPrefix(prefix) {
    const db = await this.db();
    const tx = db.transaction("meta", "readonly");
    const st = tx.objectStore("meta");
    const range = IDBKeyRange.bound(prefix, prefix + "\uFFFF");
    const keys = await req(st.getAllKeys(range));
    const vals = await req(st.getAll(range));
    const out = /* @__PURE__ */ new Map();
    keys.forEach((k, i) => out.set(k, vals[i]));
    return out;
  }
  async clearAll() {
    const db = await this.db();
    const tx = db.transaction(["ops", "meta"], "readwrite");
    tx.objectStore("ops").clear();
    tx.objectStore("meta").clear();
    await done(tx);
  }
  close() {
    this.dbPromise?.then((db) => db.close()).catch(() => {
    });
    this.dbPromise = null;
  }
};

// src/sync/engine.ts
function isPlainRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !("$rt" in v);
}
function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function mergeRecord(cur, inc, changed) {
  if (!cur) return inc;
  if (inc.d || cur.d || !isPlainRecord(cur.v) || !isPlainRecord(inc.v)) {
    return inc.t >= cur.t ? inc : cur;
  }
  const curF = cur.f ?? {};
  const touched = changed ? new Set(changed) : null;
  const out = {};
  const f = {};
  const fields = /* @__PURE__ */ new Set([...Object.keys(cur.v), ...Object.keys(inc.v)]);
  for (const name of fields) {
    const inCur = name in cur.v;
    const inInc = name in inc.v;
    const curT = curF[name] ?? cur.t;
    const untouched = touched ? !touched.has(name) : inCur && inInc && sameJSON(cur.v[name], inc.v[name]);
    if (untouched) {
      if (inCur) {
        out[name] = cur.v[name];
        if (curF[name] !== void 0) f[name] = curF[name];
      }
      continue;
    }
    const incomingWins = inc.t >= curT;
    if (incomingWins) {
      if (inInc) {
        out[name] = inc.v[name];
        f[name] = inc.t;
      }
    } else if (inCur) {
      out[name] = cur.v[name];
      f[name] = curT;
    }
  }
  return { k: inc.k, v: out, t: Math.max(cur.t, inc.t), f };
}
var TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1e3;
var PUSH_CONCURRENCY = 6;
var SHARD_CACHE_MAX = 256;
var MAX_PUSH_DELAY_MS = 1e4;
var BACKOFF_MIN_MS = 5e3;
var BACKOFF_MAX_MS = 5 * 6e4;
var Clock = class {
  constructor() {
    __publicField(this, "last", 0);
    __publicField(this, "offset", 0);
  }
  now() {
    const t = Date.now() + this.offset;
    this.last = t > this.last ? t : this.last + 1;
    return this.last;
  }
  observe(serverTime, localBefore, localAfter) {
    const mid = (localBefore + localAfter) / 2;
    const off = serverTime - mid;
    if (Math.abs(off - this.offset) > 2e3) this.offset = off;
  }
};
function pathSeg(s) {
  return encodeURIComponent(s).replace(/%2F/gi, "%2F");
}
var SyncEngine = class {
  constructor(deps, options = {}) {
    __publicField(this, "deps", deps);
    __publicField(this, "options");
    __publicField(this, "log");
    __publicField(this, "hook");
    __publicField(this, "clock", new Clock());
    __publicField(this, "schemas", /* @__PURE__ */ new Map());
    __publicField(this, "etags", /* @__PURE__ */ new Map());
    /** The last copy of a shard this engine read or wrote, with its etag:
     *  the next write merges into it and sends If-Match, and only a 412
     *  (someone else wrote in between) costs a read. Oldest first. */
    __publicField(this, "shardCache", /* @__PURE__ */ new Map());
    /** Every shard path the last listing showed, and the prefixes that
     *  listing covered: a path under a covered prefix that isn't listed
     *  does not exist, and is created with If-None-Match, unread. */
    __publicField(this, "listedPaths", /* @__PURE__ */ new Set());
    __publicField(this, "listedPrefixes", /* @__PURE__ */ new Set());
    __publicField(this, "conns", /* @__PURE__ */ new Map());
    __publicField(this, "state", { state: "off", pending: 0 });
    __publicField(this, "paused", false);
    __publicField(this, "disposed", false);
    __publicField(this, "leader", true);
    __publicField(this, "pushTimer", null);
    __publicField(this, "pushDeadline", 0);
    __publicField(this, "pullTimer", null);
    __publicField(this, "backoffMs", 0);
    __publicField(this, "backoffUntil", 0);
    __publicField(this, "chain", Promise.resolve());
    __publicField(this, "cleanup", []);
    __publicField(this, "channel", null);
    __publicField(this, "metaLoaded", null);
    __publicField(this, "logChain", Promise.resolve());
    // ── State ────────────────────────────────────────────────────────
    /** Set while a sync cycle pushes or applies something. */
    __publicField(this, "moved", false);
    this.options = {
      databases: options.databases ?? [],
      exclude: options.exclude ?? [],
      shards: Math.max(1, Math.min(64, options.shards ?? 8)),
      pushDelayMs: options.pushDelayMs ?? 2500,
      pullIntervalMs: options.pullIntervalMs ?? 6e4,
      openTimeoutMs: options.openTimeoutMs ?? 5e3,
      prefix: (options.prefix ?? "db").replace(/^\/+|\/+$/g, "")
    };
    const excludedDbs = new Set(this.options.exclude.filter((e) => !e.includes("/")));
    const excludedStores = new Set(this.options.exclude.filter((e) => e.includes("/")));
    const only = new Set(this.options.databases);
    this.hook = installIndexedDBHook({
      include: (name) => (only.size === 0 || only.has(name)) && !excludedDbs.has(name),
      excludeStore: (db, store) => excludedStores.has(db + "/" + store),
      onCommit: (db, ops) => this.onCommit(db, ops),
      onOpen: (db, name) => this.onOpen(db, name),
      onDeleteDatabase: (name) => this.onDeleteDatabase(name),
      openTimeoutMs: this.options.openTimeoutMs,
      factory: deps.factory
    });
    this.log = new SyncLog(
      (name, version) => this.hook ? this.hook.originalOpen(name, version) : indexedDB.open(name, version)
    );
    if (typeof window !== "undefined") this.attachBrowserTriggers();
    this.cleanup.push(deps.onAuthChange(() => this.schedule("auth")));
    void this.refreshPending();
    void this.schedule("start");
  }
  // ── Public surface ───────────────────────────────────────────────
  status() {
    return { ...this.state };
  }
  /** Push pending changes and pull remote ones now. */
  now() {
    if (!this.leader) {
      this.post({ type: "sync:request" });
      return Promise.resolve();
    }
    return this.enqueue(() => this.sync());
  }
  /** Send to the other tabs of this origin. */
  post(msg) {
    try {
      this.channel?.postMessage(msg);
    } catch {
    }
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    void this.schedule("resume");
  }
  dispose() {
    this.disposed = true;
    for (const c of this.cleanup) c();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.channel?.close();
    for (const p of this.conns.values()) p.then((db) => db.close()).catch(() => {
    });
    this.conns.clear();
    this.log.close();
    this.hook?.uninstall();
  }
  // ── Hook callbacks ───────────────────────────────────────────────
  onCommit(db, ops) {
    const logged = [];
    for (const op of ops) {
      const ts = this.clock.now();
      if (op.kind === "clear") logged.push({ db, store: op.store, kind: "clear", kid: "", ts });
      else if (op.kind === "del") logged.push({ db, store: op.store, kind: "del", kid: keyId(op.key), key: encodeKey(op.key), ts });
      else {
        logged.push({
          db,
          store: op.store,
          kind: "put",
          kid: keyId(op.key),
          key: encodeKey(op.key),
          value: op.value,
          changed: op.prior === void 0 ? void 0 : changedFields(op.prior, op.value),
          ts
        });
      }
    }
    this.enqueueLog(logged);
    const byStore = /* @__PURE__ */ new Map();
    for (const op of ops) {
      let e = byStore.get(op.store);
      if (!e) byStore.set(op.store, e = { keys: [], cleared: false });
      if (op.kind === "clear") {
        e.cleared = true;
        e.keys = [];
      } else if (!e.cleared) {
        e.keys.push(op.key);
      }
    }
    for (const [store, e] of byStore) {
      const change = { db, store, keys: e.keys, cleared: e.cleared, source: "tab" };
      this.post({ type: "db:change", change });
    }
  }
  enqueueLog(ops) {
    this.logChain = this.logChain.then(() => this.log.append(ops)).then(() => this.refreshPending()).then(() => {
      if (!this.leader) this.post({ type: "sync:request" });
    }).catch((err) => this.fail(err));
    this.schedulePush();
  }
  async onOpen(db, name) {
    const schema = /* @__PURE__ */ new Map();
    const names = Array.from(db.objectStoreNames);
    if (names.length > 0) {
      const tx = db.transaction(names, "readonly");
      for (const n of names) {
        const st = tx.objectStore(n);
        schema.set(n, { keyPath: st.keyPath, autoIncrement: st.autoIncrement });
        if (st.autoIncrement && typeof console !== "undefined") {
          console.warn(
            `[runapps sync] "${name}/${n}" uses autoIncrement keys: records created on two devices while offline can get the same key, and only one survives. Prefer client-generated ids (e.g. crypto.randomUUID()).`
          );
        }
      }
    }
    this.schemas.set(name, schema);
    void this.log.setMeta({ ["schema:" + name]: Object.fromEntries(schema) }).catch(() => {
    });
    if (!this.deps.userId() || this.paused || !this.leader) return;
    await this.enqueue(() => this.pullDatabase(name)).catch(() => {
    });
  }
  onDeleteDatabase(name) {
    const schema = this.schemas.get(name);
    const stores = schema ? Array.from(schema.keys()) : [];
    this.schemas.delete(name);
    this.conns.get(name)?.then((db) => db.close()).catch(() => {
    });
    this.conns.delete(name);
    const ts = this.clock.now();
    this.enqueueLog(stores.map((store) => ({ db: name, store, kind: "clear", kid: "", ts })));
  }
  // ── Scheduling ───────────────────────────────────────────────────
  attachBrowserTriggers() {
    const on = (target, type, fn) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    on(window, "online", () => {
      this.backoffUntil = 0;
      void this.schedule("online");
    });
    on(window, "focus", () => void this.schedule("focus"));
    if (typeof document !== "undefined") {
      on(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") void this.schedule("visible");
        this.updatePullTimer();
      });
    }
    this.updatePullTimer();
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel("__runapps_db_change__");
      this.channel.onmessage = (ev) => {
        const d = ev.data;
        if (!d) return;
        if (d.type === "db:change") {
          this.deps.events.emit("db:change", d.change);
        } else if (d.type === "sync:state") {
          if (!this.leader) {
            this.state = { ...d.state };
            this.deps.events.emit("sync:state", { ...d.state });
          }
        } else if (d.type === "sync:request") {
          if (this.leader) {
            this.post({ type: "sync:state", state: { ...this.state } });
            void this.schedule("peer");
          }
        } else if (d.source === "remote") {
          this.deps.events.emit("db:change", d);
        }
      };
    }
    const locks = navigator.locks;
    if (locks && typeof locks.request === "function") {
      this.leader = false;
      this.post({ type: "sync:request" });
      void locks.request("__runapps_sync__", () => {
        this.leader = true;
        void this.schedule("leader");
        return new Promise(() => {
        });
      }).catch(() => {
        this.leader = true;
      });
    }
  }
  updatePullTimer() {
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (visible && !this.pullTimer && this.options.pullIntervalMs > 0) {
      this.pullTimer = setInterval(() => void this.schedule("interval"), this.options.pullIntervalMs);
      this.pullTimer.unref?.();
    } else if (!visible && this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
  }
  schedulePush() {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.pushDeadline) this.pushDeadline = now + MAX_PUSH_DELAY_MS;
    const delay = Math.max(0, Math.min(this.options.pushDelayMs, this.pushDeadline - now));
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushDeadline = 0;
      void this.schedule("push");
    }, delay);
    this.pushTimer.unref?.();
  }
  schedule(_reason) {
    if (this.disposed || this.paused || !this.leader) return Promise.resolve();
    if (!this.deps.userId()) {
      this.setState({ state: "off" });
      return Promise.resolve();
    }
    if (Date.now() < this.backoffUntil) return Promise.resolve();
    return this.enqueue(() => this.sync());
  }
  enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {
    });
    return run;
  }
  setState(patch) {
    const next = { ...this.state, ...patch };
    if (patch.state && patch.state !== "error") delete next.error;
    const changed = next.state !== this.state.state || next.pending !== this.state.pending || next.lastSyncedAt !== this.state.lastSyncedAt || next.lastChangeAt !== this.state.lastChangeAt || next.error !== this.state.error;
    this.state = next;
    if (changed) {
      this.deps.events.emit("sync:state", { ...next });
      if (this.leader) this.post({ type: "sync:state", state: { ...next } });
    }
  }
  async refreshPending() {
    try {
      const n = await this.log.pendingCount();
      this.setState({ pending: n });
    } catch {
    }
  }
  fail(err) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const msg = err instanceof Error ? err.message : String(err);
    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    this.backoffUntil = Date.now() + this.backoffMs;
    this.setState({ state: offline ? "offline" : "error", error: msg });
    if (!offline && typeof console !== "undefined") console.warn("[runapps sync]", msg);
  }
  // ── Sync ─────────────────────────────────────────────────────────
  async loadMeta() {
    if (!this.metaLoaded) {
      this.metaLoaded = (async () => {
        for (const [k, v] of await this.log.metaWithPrefix("etag:")) this.etags.set(k.slice(5), v);
        for (const [k, v] of await this.log.metaWithPrefix("schema:")) {
          const name = k.slice(7);
          if (!this.schemas.has(name)) {
            this.schemas.set(name, new Map(Object.entries(v)));
          }
        }
      })();
      this.metaLoaded.catch(() => {
        this.metaLoaded = null;
      });
    }
    return this.metaLoaded;
  }
  /** The local copy belongs to one user. Another user signing in on the
   *  same browser starts from the server's copy, never from theirs. */
  async ensureOwner(userId) {
    const owner = await this.log.getMeta("owner");
    if (owner === userId) return;
    if (owner !== void 0) {
      for (const [db, schema] of this.schemas) {
        for (const store of schema.keys()) {
          if (this.storeExcluded(db, store)) continue;
          await this.withStore(db, store, "readwrite", (st) => {
            st.clear();
          }).catch(() => {
          });
          this.emitChange({ db, store, keys: [], cleared: true, source: "remote" });
        }
      }
      await this.log.clearAll();
      this.etags.clear();
      this.shardCache.clear();
      this.listedPaths.clear();
      this.listedPrefixes.clear();
      this.metaLoaded = null;
      await this.loadMeta();
    }
    await this.log.setMeta({ owner: userId });
  }
  async sync() {
    if (this.disposed || this.paused || !this.leader) return;
    const userId = this.deps.userId();
    if (!userId) {
      this.setState({ state: "off" });
      return;
    }
    this.setState({ state: "syncing" });
    this.moved = false;
    try {
      await this.loadMeta();
      await this.ensureOwner(userId);
      await this.logChain;
      await this.push();
      await this.pull();
      this.backoffMs = 0;
      this.backoffUntil = 0;
      await this.refreshPending();
      const now = Date.now();
      this.setState({ state: "idle", lastSyncedAt: now, ...this.moved ? { lastChangeAt: now } : {} });
    } catch (err) {
      await this.refreshPending();
      this.fail(err);
    }
  }
  storeExcluded(db, store) {
    return this.options.exclude.includes(db + "/" + store) || this.options.exclude.includes(db);
  }
  shardPath(db, store, shard) {
    return `${this.options.prefix}/${pathSeg(db)}/${pathSeg(store)}/${shard}.json`;
  }
  shardOf(kid) {
    return hash32(kid) % this.options.shards;
  }
  async readShard(path) {
    const before = Date.now();
    const r = await this.deps.remote.getJSON(path);
    if (r.status === "ok") {
      if (r.serverTime) this.clock.observe(r.serverTime, before, Date.now());
      const s = r.value;
      const shard = { v: 1, cleared: s?.cleared ?? 0, r: s?.r ?? {} };
      this.etags.set(path, r.etag);
      return { shard, etag: r.etag };
    }
    this.etags.delete(path);
    return { shard: { v: 1, cleared: 0, r: {} } };
  }
  // ── Push ─────────────────────────────────────────────────────────
  async push() {
    const ops = await this.log.pending();
    if (ops.length === 0) return;
    const groups = /* @__PURE__ */ new Map();
    for (const op of ops) {
      const k = op.db + "\0" + op.store;
      let g = groups.get(k);
      if (!g) groups.set(k, g = []);
      g.push(op);
    }
    const idsOf = (list) => list.map((op) => op.id).filter((id) => id !== void 0);
    const settle = async (ids) => {
      if (ids.length === 0) return;
      await this.log.remove(ids);
      this.moved = true;
      await this.refreshPending();
    };
    const limit = limiter(PUSH_CONCURRENCY);
    const work = [];
    for (const [, g] of groups) {
      const db = g[0].db;
      const store = g[0].store;
      if (this.storeExcluded(db, store)) {
        work.push(settle(idsOf(g)));
        continue;
      }
      let clearedAt = 0;
      let lastClear = -1;
      g.forEach((op, i) => {
        if (op.kind === "clear") {
          clearedAt = Math.max(clearedAt, op.ts);
          lastClear = i;
        }
      });
      const live = g.slice(lastClear + 1);
      const byShard = /* @__PURE__ */ new Map();
      for (const op of live) {
        const s = this.shardOf(op.kid);
        let list = byShard.get(s);
        if (!list) byShard.set(s, list = []);
        list.push(op);
      }
      const shards = clearedAt > 0 ? Array.from({ length: this.options.shards }, (_, i) => i) : Array.from(byShard.keys());
      const written = shards.map(
        (n) => limit(async () => {
          const path = this.shardPath(db, store, n);
          const shardOps = byShard.get(n) ?? [];
          const encoded = await Promise.all(shardOps.map((op) => this.encodeOp(op)));
          const etag = await this.writeShard(path, clearedAt, encoded);
          await this.log.setMeta({ ["etag:" + path]: etag });
          await settle(idsOf(shardOps));
        })
      );
      work.push(Promise.all(written).then(() => settle(idsOf(g.slice(0, lastClear + 1)))));
    }
    const results = await Promise.allSettled(work);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }
  async encodeOp(op) {
    if (op.kind === "del") return { kid: op.kid, rec: { k: op.key, v: null, t: op.ts, d: 1 } };
    const v = await encodeValue(op.value, (blob) => this.storeBlob(blob));
    return { kid: op.kid, rec: { k: op.key, v, t: op.ts }, changed: op.changed };
  }
  /** Merge ops into one shard and write it; retried on a 412. The first
   *  try starts from the cached copy, or from nothing when the last
   *  listing showed no such shard — no read either way. */
  async writeShard(path, clearedAt, ops) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cached = attempt === 0 ? this.shardCache.get(path) : void 0;
      const { shard, etag } = cached ? { shard: copyShard(cached.shard), etag: cached.etag } : attempt === 0 && this.knownAbsent(path) ? { shard: { v: 1, cleared: 0, r: {} }, etag: void 0 } : await this.readShard(path);
      const now = this.clock.now();
      if (clearedAt > shard.cleared) {
        shard.cleared = clearedAt;
        for (const kid of Object.keys(shard.r)) {
          if (shard.r[kid].t <= clearedAt) delete shard.r[kid];
        }
      }
      for (const { kid, rec, changed } of ops) {
        if (rec.t <= shard.cleared) continue;
        shard.r[kid] = mergeRecord(shard.r[kid], rec, changed);
      }
      for (const kid of Object.keys(shard.r)) {
        const rec = shard.r[kid];
        if (rec.d && now - rec.t > TOMBSTONE_TTL_MS) delete shard.r[kid];
      }
      const before = Date.now();
      const r = await this.deps.remote.putJSON(path, shard, etag ? { ifMatch: etag } : { ifNoneMatch: true });
      if (r.status === "ok") {
        if (r.serverTime) this.clock.observe(r.serverTime, before, Date.now());
        this.etags.set(path, r.etag);
        this.cacheShard(path, r.etag, shard);
        this.listedPaths.add(path);
        return r.etag;
      }
      this.etags.delete(path);
      this.shardCache.delete(path);
      this.listedPaths.add(path);
    }
    throw new Error(`could not write ${path}: too many concurrent writers`);
  }
  cacheShard(path, etag, shard) {
    this.shardCache.delete(path);
    this.shardCache.set(path, { etag, shard });
    while (this.shardCache.size > SHARD_CACHE_MAX) {
      const oldest = this.shardCache.keys().next().value;
      if (oldest === void 0) break;
      this.shardCache.delete(oldest);
    }
  }
  knownAbsent(path) {
    if (this.listedPaths.has(path)) return false;
    for (const p of this.listedPrefixes) if (path.startsWith(p)) return true;
    return false;
  }
  /** Remember what a listing of `prefix` showed (see listedPaths). */
  rememberListing(prefix, listing) {
    for (const p of [...this.listedPaths]) if (p.startsWith(prefix)) this.listedPaths.delete(p);
    for (const e of listing) this.listedPaths.add(e.path);
    this.listedPrefixes.add(prefix);
  }
  async storeBlob(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const ref = `${this.options.prefix}/_blobs/${hex}`;
    await this.deps.remote.putBlob(ref, blob);
    return { ref, type: blob.type, size: blob.size };
  }
  // ── Pull ─────────────────────────────────────────────────────────
  async pull() {
    const prefix = this.options.prefix + "/";
    const listing = await this.deps.remote.list(prefix);
    this.rememberListing(prefix, listing);
    await this.applyListing(listing);
  }
  async pullDatabase(name) {
    if (!this.deps.userId()) return;
    await this.loadMeta();
    const prefix = `${this.options.prefix}/${pathSeg(name)}/`;
    const listing = await this.deps.remote.list(prefix);
    this.rememberListing(prefix, listing);
    await this.applyListing(listing);
  }
  async applyListing(listing) {
    const re = new RegExp("^" + this.options.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/([^/]+)/([^/]+)/(\\d+)\\.json$");
    const pending = await this.log.pending();
    const etagUpdates = {};
    for (const entry of listing) {
      const m = re.exec(entry.path);
      if (!m) continue;
      const db = decodeURIComponent(m[1]);
      const store = decodeURIComponent(m[2]);
      if (this.etags.get(entry.path) === entry.etag) continue;
      if (this.storeExcluded(db, store)) continue;
      const schema = this.schemas.get(db);
      if (!schema || !schema.has(store)) continue;
      const r = await this.deps.remote.getJSON(entry.path, this.etags.get(entry.path));
      if (r.status === "unchanged") {
        continue;
      }
      if (r.status === "missing") {
        this.etags.delete(entry.path);
        etagUpdates["etag:" + entry.path] = void 0;
        continue;
      }
      const s = r.value;
      const shard = { v: 1, cleared: s?.cleared ?? 0, r: s?.r ?? {} };
      this.cacheShard(entry.path, r.etag, copyShard(shard));
      await this.applyShard(db, store, shard, pending);
      this.etags.set(entry.path, r.etag);
      etagUpdates["etag:" + entry.path] = r.etag;
    }
    if (Object.keys(etagUpdates).length) await this.log.setMeta(etagUpdates);
  }
  async applyShard(db, store, shard, pending) {
    const localNewer = /* @__PURE__ */ new Map();
    let localClear = 0;
    for (const op of pending) {
      if (op.db !== db || op.store !== store) continue;
      if (op.kind === "clear") localClear = Math.max(localClear, op.ts);
      else localNewer.set(op.kid, Math.max(localNewer.get(op.kid) ?? 0, op.ts));
    }
    const clearKey = `cleared:${db}/${store}`;
    const appliedClear = await this.log.getMeta(clearKey) ?? 0;
    const schema = this.schemas.get(db)?.get(store);
    const keys = [];
    let clearedLocally = false;
    await this.withStore(db, store, "readwrite", (st) => {
      if (shard.cleared > appliedClear && shard.cleared > localClear) {
        st.clear();
        clearedLocally = true;
      }
      for (const kid of Object.keys(shard.r)) {
        const rec = shard.r[kid];
        if ((localNewer.get(kid) ?? 0) >= rec.t) continue;
        if (rec.t <= localClear) continue;
        const key = decodeKey(rec.k);
        keys.push(key);
        if (rec.d) {
          st.delete(key);
        } else {
          const value = rec._decoded;
          if (schema && schema.keyPath !== null) st.put(value);
          else st.put(value, key);
        }
      }
      if (clearedLocally) {
        for (const op of pending) {
          if (op.db !== db || op.store !== store || op.kind !== "put" || op.ts <= shard.cleared) continue;
          if (schema && schema.keyPath !== null) st.put(op.value);
          else st.put(op.value, decodeKey(op.key));
        }
      }
    }, async () => {
      for (const kid of Object.keys(shard.r)) {
        const rec = shard.r[kid];
        if (rec.d || (localNewer.get(kid) ?? 0) >= rec.t || rec.t <= localClear) continue;
        rec._decoded = await decodeValue(
          rec.v,
          (ref) => this.deps.remote.getBlob(ref.ref)
        );
      }
    });
    if (shard.cleared > appliedClear) await this.log.setMeta({ [clearKey]: shard.cleared });
    if (keys.length > 0 || clearedLocally) {
      this.emitChange({ db, store, keys, cleared: clearedLocally, source: "remote" });
    }
  }
  emitChange(change) {
    this.moved = true;
    this.deps.events.emit("db:change", change);
    try {
      this.post(change);
    } catch {
    }
  }
  // ── The engine's own connections ─────────────────────────────────
  conn(db) {
    let p = this.conns.get(db);
    if (!p) {
      p = new Promise((resolve, reject) => {
        const open = this.hook ? this.hook.originalOpen : (n) => indexedDB.open(n);
        const r = open(db);
        r.onsuccess = () => {
          const h = r.result;
          h.onversionchange = () => {
            h.close();
            this.conns.delete(db);
          };
          resolve(h);
        };
        r.onerror = () => reject(r.error ?? new Error(`cannot open ${db}`));
        r.onblocked = () => reject(new Error(`open of ${db} blocked`));
      });
      this.conns.set(db, p);
      p.catch(() => this.conns.delete(db));
    }
    return p;
  }
  async withStore(db, store, mode, fn, prepare) {
    if (prepare) await prepare();
    const h = await this.conn(db);
    if (!h.objectStoreNames.contains(store)) return;
    const tx = h.transaction(store, mode);
    fn(tx.objectStore(store));
    await done(tx);
  }
};
function copyShard(shard) {
  return JSON.parse(JSON.stringify(shard));
}
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n) return;
    const start = queue.shift();
    if (start) start();
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push(() => {
      active++;
      task().then(resolve, reject).finally(() => {
        active--;
        next();
      });
    });
    next();
  });
}

// src/sync/remote.ts
var FilesRemote = class {
  constructor(files) {
    __publicField(this, "files", files);
  }
  async list(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await this.files.list({ prefix, limit: 1e3, ...cursor ? { cursor } : {} });
      for (const f of page.files) if (f.etag) out.push({ path: f.path, etag: f.etag });
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }
  async getJSON(path, ifNoneMatch) {
    let r;
    try {
      r = await this.files.readJSON(path, ifNoneMatch ? { ifNoneMatch } : void 0);
    } catch (e) {
      if (e instanceof SyntaxError) {
        console.warn("[runapps sync] unreadable shard, will be rewritten", path);
        try {
          const st = await this.files.stat(path);
          return { status: "ok", value: null, etag: st.etag ?? "", serverTime: st.last_modified ? Date.parse(st.last_modified) : void 0 };
        } catch {
          return { status: "missing" };
        }
      }
      throw e;
    }
    if (r.notModified) return { status: "unchanged" };
    if (r.value === void 0) return { status: "missing" };
    return { status: "ok", value: r.value, etag: r.etag ?? "" };
  }
  async putJSON(path, value, cond) {
    try {
      const obj = await this.files.put(path, JSON.stringify(value), {
        contentType: "application/json",
        ...cond.ifMatch ? { ifMatch: cond.ifMatch } : {},
        ...cond.ifNoneMatch ? { ifNoneMatch: true } : {}
      });
      return { status: "ok", etag: obj.etag ?? "", serverTime: obj.last_modified ? Date.parse(obj.last_modified) : void 0 };
    } catch (e) {
      const code = e.statusCode;
      if (code === 412 || code === 409) return { status: "conflict" };
      throw e;
    }
  }
  async putBlob(path, blob) {
    try {
      await this.files.put(path, blob, { contentType: blob.type || "application/octet-stream", ifNoneMatch: true });
    } catch (e) {
      if (e.statusCode !== 409) throw e;
    }
  }
  getBlob(path) {
    return this.files.get(path);
  }
};

// src/client.ts
var DEFAULT_BASE_URL = "https://www.runapps.ai";
var RunApps = class {
  constructor(options = {}) {
    __publicField(this, "chat");
    __publicField(this, "models");
    __publicField(this, "image");
    __publicField(this, "audio");
    __publicField(this, "video");
    __publicField(this, "files");
    __publicField(this, "embeddings");
    /** Realtime voice sessions over WebSocket — see `RealtimeService.connect`. */
    __publicField(this, "realtime");
    /** Seedance asset verification (a gated feature) — see `AssetsService`. */
    __publicField(this, "assets");
    /** App handoff: send files to another app and receive what other apps
     *  send this one — see `AppsService`. */
    __publicField(this, "apps");
    __publicField(this, "transport");
    /**
     * Browser auth helper, populated only when `authProvider: "runapps"`.
     * Use `client.signIn()` and `client.user` for the common cases; the
     * full instance is exposed for advanced flows (manual `onTokenChange`
     * subscription, etc.).
     */
    __publicField(this, "auth", null);
    /**
     * RunApps Sync (see `ClientOptions.sync`), or null when it
     * is off. `status()` gives the state the badge shows; `now()` pushes
     * and pulls immediately; `client.events.on("db:change", …)` tells the
     * app which store received remote changes so it can re-read.
     */
    __publicField(this, "sync", null);
    /**
     * Runtime event bus for SDK-call telemetry. Every LLM-ish service
     * (chat / embeddings / image / audio / video) fires
     * `request:start`, `request:streamDelta`, `request:end`, and
     * `request:error` events here so UI overlays — like the bottom-right
     * identity badge's activity ring — can render real-time state
     * without business code threading anything through.
     *
     * Zero-cost when nobody subscribes (emit is a few property reads).
     * Subscribe via `client.events.on("request:start", handler)` — the
     * returned closure is the unsubscribe.
     */
    __publicField(this, "events", new SDKEvents());
    const provider = options.authProvider ?? (!options.apiKey && !options.apiKeyResolver && typeof window !== "undefined" ? "runapps" : "static");
    let apiKeyResolver = options.apiKeyResolver;
    let baseURL = options.baseURL;
    let onUnauthorized;
    if (provider === "runapps" || provider === "runjobs") {
      baseURL = baseURL ?? "https://www.runapps.ai";
      const showBadge = options.showIdentityBadge !== void 0 ? options.showIdentityBadge : options.hideIdentityBadge !== void 0 ? !options.hideIdentityBadge : true;
      const auth = new BrowserAuth({
        origin: baseURL,
        hideBadge: !showBadge,
        // Pipe the shared event bus into BrowserAuth so the badge can
        // render its real-time activity ring / LED / popover. Safe to
        // pass even when the caller never subscribes — emit is a few
        // property reads when nobody's listening.
        events: this.events,
        ...options.badgePosition !== void 0 && { badgePosition: options.badgePosition },
        ...options.project !== void 0 && { project: options.project },
        ...options.signInMode !== void 0 && { signInMode: options.signInMode }
      });
      this.auth = auth;
      apiKeyResolver = auth.getToken;
      onUnauthorized = () => auth.invalidate();
    }
    if (!options.apiKey && !apiKeyResolver) {
      throw new Error(
        "runapps: pass `apiKey` (or `apiKeyResolver`); outside a browser there is no sign-in to fall back to"
      );
    }
    const transport = new Transport({
      baseURL: baseURL ?? DEFAULT_BASE_URL,
      ...options.apiKey !== void 0 && { apiKey: options.apiKey },
      ...apiKeyResolver !== void 0 && { apiKeyResolver },
      ...onUnauthorized !== void 0 && { onUnauthorized },
      ...options.fetch ? { fetchImpl: options.fetch } : {}
    });
    this.chat = new ChatService(transport, this.events);
    this.models = new ModelsService(transport);
    this.image = new ImageService(transport, this.events);
    this.audio = new AudioService(transport, this.events);
    this.video = new VideoService(transport, this.events);
    this.files = new FilesService(transport, options.project, this.events, options.filesBase);
    this.embeddings = new EmbeddingsService(transport, this.events);
    this.realtime = new RealtimeService(transport, this.events);
    this.assets = new AssetsService(transport);
    this.apps = new AppsService(
      transport,
      this.files,
      options.project,
      () => !!options.apiKey || !!options.apiKeyResolver || !!this.auth?.user
    );
    this.transport = transport;
    const wantSync = options.sync ?? this.auth !== null;
    if (wantSync && typeof indexedDB !== "undefined" && this.auth) {
      const auth = this.auth;
      const engine = new SyncEngine(
        {
          // Its own file service, without the event bus: sync traffic
          // must not spin the badge every minute.
          remote: new FilesRemote(new FilesService(transport, options.project, void 0, options.filesBase)),
          events: this.events,
          userId: () => auth.ownerId(),
          onAuthChange: (cb) => auth.onTokenChange(() => cb())
        },
        typeof wantSync === "object" ? wantSync : {}
      );
      this.sync = engine;
    }
  }
  /** Force a redirect to the runapps.ai grant page.  No-op in static
   *  auth mode or in Node. */
  signIn() {
    return this.auth?.signIn();
  }
  /**
   * Clear the cached token + identity from memory and localStorage.
   * The next API call will trigger sign-in again (redirect to grant
   * page).  Wire this to a "Sign out" button in your settings UI.
   *
   * No-op in static auth mode or in Node.
   */
  signOut() {
    this.auth?.signOut();
  }
  /**
   * The caller as the platform sees them, with the gated features the
   * platform enabled for them (e.g. "seedance_asset_verify"), so an app
   * shows a gated control only to those who have it.
   */
  me(init) {
    return this.transport.getJSON("/v1/me", init);
  }
  /** Currently-authenticated user (runapps auth mode), or null. */
  get user() {
    return this.auth?.user ?? null;
  }
};

// src/model_options.ts
function normalizeGroups(g) {
  if (!g) return [];
  return g.map(
    (item) => Array.isArray(item) ? { fields: item } : item
  );
}
function getOptionsSchema(model) {
  const opts = model.options;
  if (!opts || typeof opts !== "object") return null;
  return opts;
}
function acceptsField(model, name) {
  const schema = getOptionsSchema(model);
  const f = schema?.inputs?.[name];
  if (!f) return false;
  return f.presence !== "forbidden";
}
function requiresField(model, name) {
  const schema = getOptionsSchema(model);
  return schema?.inputs?.[name]?.presence === "required";
}
function allowedValuesFor(model, name) {
  const schema = getOptionsSchema(model);
  return schema?.inputs?.[name]?.enum ?? null;
}

// src/validate.ts
function validateRequest(schema, req2 = {}) {
  if (!schema) return [];
  const errors = [];
  if (schema.inputs) {
    for (const [name, field] of Object.entries(schema.inputs)) {
      const set = name in req2;
      const val = req2[name];
      if (set && !isEmpty(val)) {
        errors.push(...validateFieldValue(name, field, val));
      } else if (set && field.min_items !== void 0) {
        if (Array.isArray(val) && val.length < field.min_items) {
          errors.push({ field: name, reason: `at least ${field.min_items} items` });
        }
      }
      errors.push(...validatePresence(name, field, val, set));
    }
  }
  for (const c of schema.constraints ?? []) {
    errors.push(...validateConstraint(c, req2));
  }
  return errors;
}
function validateFieldValue(name, field, val) {
  const errors = [];
  if (!typeMatches(field.type, val)) {
    errors.push({
      field: name,
      reason: `expected type ${field.type}, got ${describeType(val)}`
    });
    return errors;
  }
  if (field.enum && field.enum.length > 0 && !inEnum(val, field.enum)) {
    errors.push({
      field: name,
      reason: `must be one of ${JSON.stringify(field.enum)}`
    });
  }
  if (field.type === "int" || field.type === "float") {
    const n = numberValue(val);
    if (n !== null) {
      if (field.min !== void 0 && n < field.min) {
        errors.push({ field: name, reason: `must be >= ${field.min}` });
      }
      if (field.max !== void 0 && n > field.max) {
        errors.push({ field: name, reason: `must be <= ${field.max}` });
      }
    }
  }
  if (Array.isArray(val)) {
    if (field.max_items !== void 0 && val.length > field.max_items) {
      errors.push({
        field: name,
        reason: `at most ${field.max_items} items`
      });
    }
    if (field.min_items !== void 0 && val.length < field.min_items) {
      errors.push({
        field: name,
        reason: `at least ${field.min_items} items`
      });
    }
  }
  if (field.fields) {
    if (field.repeatable) {
      if (!Array.isArray(val)) {
        errors.push({
          field: name,
          reason: `expected array of objects, got ${describeType(val)}`
        });
      } else {
        val.forEach((item, i) => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) {
            errors.push({
              field: `${name}[${i}]`,
              reason: `expected object, got ${describeType(item)}`
            });
            return;
          }
          errors.push(...validateObject(`${name}[${i}]`, field.fields, item));
        });
      }
    } else {
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        errors.push({
          field: name,
          reason: `expected object, got ${describeType(val)}`
        });
      } else {
        errors.push(...validateObject(name, field.fields, val));
      }
    }
  }
  return errors;
}
function validateObject(pathPrefix, fields, obj) {
  const errors = [];
  for (const [innerName, innerField] of Object.entries(fields)) {
    const childPath = `${pathPrefix}.${innerName}`;
    const val = obj[innerName];
    const set = innerName in obj;
    if (set && !isEmpty(val)) {
      errors.push(...validateFieldValue(childPath, innerField, val));
    }
    errors.push(...validatePresence(childPath, innerField, val, set));
  }
  return errors;
}
function validatePresence(name, field, val, set) {
  const presence = field.presence ?? "optional";
  if (presence === "required" && (!set || isEmpty(val))) {
    return [{ field: name, reason: "required" }];
  }
  if (presence === "forbidden" && set && !isEmpty(val)) {
    return [{ field: name, reason: "must not be set for this model" }];
  }
  return [];
}
function validateConstraint(c, req2) {
  switch (c.kind) {
    case "any_of_required": {
      const fields = c.fields ?? [];
      const anySet = fields.some((f) => f in req2 && !isEmpty(req2[f]));
      if (anySet) return [];
      return [
        {
          field: fields.join("/"),
          reason: `at least one of ${fields.join(", ")} is required`
        }
      ];
    }
    case "mutually_exclusive": {
      const fields = c.fields ?? [];
      const setFields = fields.filter((f) => f in req2 && !isEmpty(req2[f]));
      if (setFields.length > 1) {
        return [
          {
            field: setFields.join("/"),
            reason: `at most one of ${fields.join(", ")} may be set (got: ${setFields.join(", ")})`
          }
        ];
      }
      return [];
    }
    case "group_mutex": {
      const groups = normalizeGroups(c.groups);
      const activeGroups = [];
      const activeFields = [];
      for (const g of groups) {
        const setHere = g.fields.filter((f) => f in req2 && !isEmpty(req2[f]));
        if (setHere.length > 0) {
          activeGroups.push(g);
          activeFields.push(...setHere);
        }
      }
      if (activeGroups.length > 1) {
        const labels = groups.map((g) => `[${g.fields.join("+")}]`).join(" or ");
        return [
          {
            field: activeFields.join("/"),
            reason: `at most one of ${labels} may be used (got: ${activeFields.join(", ")})`
          }
        ];
      }
      return [];
    }
    case "requires_all": {
      const whenName = c.when;
      if (!whenName) return [];
      const whenSet = whenName in req2 && !isEmpty(req2[whenName]);
      if (!whenSet) return [];
      const missing = (c.then ?? []).filter(
        (f) => !(f in req2) || isEmpty(req2[f])
      );
      if (missing.length === 0) return [];
      return [
        {
          field: missing.join("/"),
          reason: `required when ${whenName} is set`
        }
      ];
    }
    case "pixel_bounds": {
      const fieldName = c.fields?.[0];
      if (!fieldName) return [];
      const raw = req2[fieldName];
      if (typeof raw !== "string" || raw === "") return [];
      const dims = parsePixelDims(raw);
      if (!dims) {
        return [{ field: fieldName, reason: `expected WxH dimensions, got "${raw}"` }];
      }
      const [w, h] = dims;
      const px = w * h;
      const errs = [];
      if (c.min !== void 0 && px < c.min) {
        errs.push({
          field: fieldName,
          reason: `image too small: ${w}x${h} = ${px} pixels, minimum ${c.min}`
        });
      }
      if (c.max !== void 0 && px > c.max) {
        errs.push({
          field: fieldName,
          reason: `image too large: ${w}x${h} = ${px} pixels, maximum ${c.max}`
        });
      }
      return errs;
    }
  }
  return [];
}
function typeMatches(typ, val) {
  switch (typ) {
    case "string":
      return typeof val === "string";
    case "int":
    case "float":
      return numberValue(val) !== null;
    case "bool":
      return typeof val === "boolean";
    case "url":
      return typeof val === "string" && isURLLike(val);
    case "url[]":
      return Array.isArray(val) && val.every((v) => typeof v === "string" && isURLLike(v));
    case "string[]":
      return Array.isArray(val) && val.every((v) => typeof v === "string");
    case "file":
      return true;
    // multipart — can't validate
    default:
      return true;
  }
}
function describeType(val) {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}
function numberValue(val) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  return null;
}
function isURLLike(s) {
  return s.startsWith("http://") || s.startsWith("https://") || s.startsWith("data:");
}
function isEmpty(val) {
  if (val === void 0 || val === null) return true;
  if (typeof val === "string") return val === "";
  if (Array.isArray(val)) return val.length === 0;
  return false;
}
function inEnum(val, enumVals) {
  for (const e of enumVals) {
    if (equalLoose(val, e)) return true;
  }
  return false;
}
function equalLoose(a, b) {
  return a === b;
}
function parsePixelDims(s) {
  for (const sep of ["x", "X", "*", "\xD7"]) {
    const idx = s.indexOf(sep);
    if (idx <= 0) continue;
    const w = parseInt(s.slice(0, idx).trim(), 10);
    const h = parseInt(s.slice(idx + sep.length).trim(), 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return [w, h];
    }
  }
  return null;
}
//# sourceMappingURL=index.cjs.map