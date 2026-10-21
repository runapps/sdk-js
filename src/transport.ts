import { APIError } from "./errors.js";

/**
 * Internal — shared HTTP transport used by every service. Not part of the
 * public API; do not import from outside `src/`.
 *
 * Uses the global `fetch` (Node 18+ / browsers / Deno / Bun all ship it).
 * Errors from the gateway (status >= 400) are parsed and surfaced as
 * `APIError`. Network errors propagate as the underlying fetch reject.
 */
export interface TransportOptions {
  baseURL: string;
  /** Static bearer token. Required unless `apiKeyResolver` is supplied. */
  apiKey?: string;
  /** Dynamic resolver — called immediately before each request. Use this
   *  when the token is short-lived and refreshed externally (e.g. running
   *  inside an app bundle that exposes
   *  its own `getToken()`). The result is awaited per request, so
   *  the caller can return a Promise that hits a token endpoint. Wins
   *  over `apiKey` when both are supplied. */
  apiKeyResolver?: () => string | Promise<string>;
  /**
   * Hook invoked on 401 responses, *before* the request is automatically
   * retried once.  Use this to invalidate any cached token so the next
   * `apiKeyResolver` call fetches a fresh one.  Throwing here cancels
   * the retry — the original 401 propagates.
   *
   * Typical wiring (browser-auth):
   *   onUnauthorized: () => auth.invalidate()
   * which clears the in-memory + persisted token without flipping the
   * sticky "signed out" flag.  The retry's resolveToken() then triggers
   * the standard signIn() redirect-grant flow.
   */
  onUnauthorized?: () => void | Promise<void>;
  /** Optional fetch override (e.g. node-fetch with custom agent). */
  fetchImpl?: typeof fetch;
}

export class Transport {
  readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly apiKeyResolver: (() => string | Promise<string>) | undefined;
  private readonly onUnauthorized: (() => void | Promise<void>) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TransportOptions) {
    if (!opts.apiKey && !opts.apiKeyResolver) {
      throw new Error(
        "RunApps: pass either `apiKey` or `apiKeyResolver` when constructing the client",
      );
    }
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.apiKeyResolver = opts.apiKeyResolver;
    this.onUnauthorized = opts.onUnauthorized;
    // Bind to globalThis when using the platform's native fetch.
    // Without binding, `this.fetchImpl(...)` invokes with `this`
    // pointing at the Transport instance, and the browser's
    // `Window.fetch` rejects that with "Illegal invocation".
    // Caller-supplied `fetchImpl` is used as-is — they're responsible
    // for any binding their wrapper needs.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Absolute URLs pass through; paths are joined to the base. The files
   *  service uses this to send file calls to the files host. */
  private resolve(path: string): string {
    return /^https?:\/\//i.test(path) ? path : this.baseURL + path;
  }

  /** A short, non-secret fingerprint of the current token, so a service
   *  can notice that the signed-in user changed and drop per-user state
   *  (the files base is derived from the user). */
  async tokenFingerprint(): Promise<string> {
    const t = await this.resolveToken();
    if (!t) return "";
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ":" + t.length;
  }

  /** Resolve the bearer token for the next request. */
  private async resolveToken(): Promise<string> {
    if (this.apiKeyResolver) return await this.apiKeyResolver();
    return this.apiKey ?? "";
  }

  /** The current bearer token, for connections fetch can't make (WebSocket). */
  bearerToken(): Promise<string> {
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
  private async fetchWithAuthRetry(
    path: string,
    build: () => Promise<RequestInit>,
  ): Promise<Response> {
    const url = this.resolve(path);
    let resp = await this.fetchImpl(url, await this.buildInit(build));
    if (resp.status !== 401 || !this.onUnauthorized) return resp;
    try {
      await this.onUnauthorized();
    } catch {
      // Hook bailed out — surface the original 401.
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
  private async buildInit(build: () => Promise<RequestInit>): Promise<RequestInit> {
    const init = await build();
    return init.cache ? init : { ...init, cache: "no-store" };
  }

  /** POST JSON body; parse JSON response. */
  async postJSON<T>(
    path: string,
    body: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "POST",
      headers: await this.jsonHeaders(),
      body: JSON.stringify(body),
      signal: init?.signal,
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return (await resp.json()) as T;
  }

  /** GET path; parse JSON response. */
  async getJSON<T>(
    path: string,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "GET",
      headers: await this.authHeaders(),
      signal: init?.signal,
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return (await resp.json()) as T;
  }

  /** GET a public path: no Authorization header, so it never fetches a
   *  token — in browser sign-in mode that would send a signed-out user to
   *  the sign-in page just to read the model catalogue. */
  async getPublicJSON<T>(
    path: string,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    const resp = await this.fetchImpl(this.resolve(path), {
      method: "GET",
      cache: "no-store",
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return (await resp.json()) as T;
  }

  /** GET path; return raw bytes + content-type (for video/audio downloads)
   *  and the ETag of those bytes, when the server sends one. */
  async getRaw(
    path: string,
    init?: { signal?: AbortSignal; ifNoneMatch?: string },
  ): Promise<{ data: Uint8Array; contentType: string; etag?: string; notModified?: boolean; serverTime?: number }> {
    const resp = await this.fetchWithAuthRetry(path, async () => {
      const headers: Record<string, string> = await this.authHeaders();
      if (init?.ifNoneMatch) headers["If-None-Match"] = `"${cleanETag(init.ifNoneMatch)}"`;
      return { method: "GET", headers, signal: init?.signal };
    });
    const serverTime = parseServerDate(resp.headers.get("date"));
    if (resp.status === 304) {
      const etag = cleanETag(resp.headers.get("etag")) || init?.ifNoneMatch;
      return { data: new Uint8Array(0), contentType: "", etag, notModified: true, serverTime };
    }
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const contentType = resp.headers.get("content-type") ?? "";
    const etag = cleanETag(resp.headers.get("etag")) || undefined;
    return { data: buf, contentType, etag, serverTime };
  }

  /** POST a multipart/form-data body. Used by audio.transcribe and image.edit. */
  async postMultipart<T>(
    path: string,
    form: FormData,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "POST",
      headers: await this.authHeaders(), // do NOT set Content-Type — fetch sets it with boundary
      body: form,
      signal: init?.signal,
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return (await resp.json()) as T;
  }

  /**
   * POST JSON body; return the raw streaming Response. Used by chat
   * streaming. Caller is responsible for consuming the SSE body.
   */
  async postJSONStream(
    path: string,
    body: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<Response> {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "POST",
      headers: {
        ...(await this.jsonHeaders()),
        "Accept-Encoding": "identity", // SSE lines arrive immediately, no gzip
      },
      body: JSON.stringify(body),
      signal: init?.signal,
    }));
    if (!resp.ok) {
      throw await this.parseError(resp);
    }
    return resp;
  }

  /** PUT raw bytes with caller-supplied content type and headers. */
  async putBytes<T>(
    path: string,
    body: BodyInit,
    opts?: {
      contentType?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      parse?: "json" | "none";
    },
  ): Promise<T> {
    const resp = await this.fetchWithAuthRetry(path, async () => {
      const headers: Record<string, string> = {
        ...(await this.authHeaders()),
        "Content-Type": opts?.contentType ?? "application/octet-stream",
      };
      // How many bytes we are sending.  A proxy that streams request
      // bodies can pass on a body cut short by a page that went away
      // mid-upload as if it were whole; the gateway refuses a body
      // whose length does not match this (400), so a truncated file is
      // never stored.
      const size = bodyByteLength(body);
      if (size !== undefined) headers["X-Content-Length"] = String(size);
      if (opts?.headers) Object.assign(headers, opts.headers);
      return {
        method: "PUT",
        headers,
        body,
        signal: opts?.signal,
      };
    });
    if (!resp.ok) throw await this.parseError(resp);
    if (opts?.parse === "none") return undefined as unknown as T;
    return (await resp.json()) as T;
  }

  /** DELETE path; parse JSON response (or no body). */
  async deletePath<T>(
    path: string,
    init?: { signal?: AbortSignal; parse?: "json" | "none" },
  ): Promise<T> {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "DELETE",
      headers: await this.authHeaders(),
      signal: init?.signal,
    }));
    if (!resp.ok) throw await this.parseError(resp);
    if (init?.parse === "none") return undefined as unknown as T;
    return (await resp.json()) as T;
  }

  /** HEAD path; surface status + selected response headers.  Used by
   *  exists / stat where the body would just be an opaque blob. */
  async head(
    path: string,
    init?: { signal?: AbortSignal },
  ): Promise<{ status: number; headers: Headers }> {
    const resp = await this.fetchWithAuthRetry(path, async () => ({
      method: "HEAD",
      headers: await this.authHeaders(),
      signal: init?.signal,
    }));
    return { status: resp.status, headers: resp.headers };
  }

  private async jsonHeaders(): Promise<Record<string, string>> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await this.resolveToken()}`,
    };
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.resolveToken()}` };
  }

  private async parseError(resp: Response): Promise<APIError> {
    const text = await resp.text();
    let type = "error";
    let message = text || resp.statusText;
    try {
      const parsed = JSON.parse(text) as { type?: string; message?: string };
      if (parsed.type) type = parsed.type;
      if (parsed.message) message = parsed.message;
    } catch {
      // Body wasn't JSON — fall back to raw text.
    }
    return new APIError(resp.status, type, message);
  }
}

/** The server's clock from a Date header, as ms since epoch. */
/**
 * The bare ETag value. A CDN that compresses the response marks the
 * ETag weak (`W/"…"`); the value is still the object's, and it is what
 * `If-Match` must carry on the next write.
 */
export function cleanETag(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/^W\//i, "").replace(/"/g, "");
}

export function parseServerDate(h: string | null): number | undefined {
  if (!h) return undefined;
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : t;
}

/** The byte length of a PUT body when it is known up front; undefined for
 *  streams and forms, which the browser frames itself. */
export function bodyByteLength(body: BodyInit): number | undefined {
  if (typeof body === "string") {
    return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(body).byteLength : undefined;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}
