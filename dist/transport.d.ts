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
export declare class Transport {
    readonly baseURL: string;
    private readonly apiKey;
    private readonly apiKeyResolver;
    private readonly onUnauthorized;
    private readonly fetchImpl;
    constructor(opts: TransportOptions);
    /** Absolute URLs pass through; paths are joined to the base. The files
     *  service uses this to send file calls to the files host. */
    private resolve;
    /** A short, non-secret fingerprint of the current token, so a service
     *  can notice that the signed-in user changed and drop per-user state
     *  (the files base is derived from the user). */
    tokenFingerprint(): Promise<string>;
    /** Resolve the bearer token for the next request. */
    private resolveToken;
    /** The current bearer token, for connections fetch can't make (WebSocket). */
    bearerToken(): Promise<string>;
    /**
     * Wrap a fetch call with single-attempt 401 retry.  `build` produces a
     * fresh RequestInit each call (so headers can re-resolve a fresh token,
     * and bodies can be re-streamed for retry).  On 401, invokes
     * `onUnauthorized()` (giving the caller a chance to invalidate cached
     * auth state) then retries once with a fresh init.  No retry if
     * `onUnauthorized` is absent or already retried.
     */
    private fetchWithAuthRetry;
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
    private buildInit;
    /** POST JSON body; parse JSON response. */
    postJSON<T>(path: string, body: unknown, init?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /** GET path; parse JSON response. */
    getJSON<T>(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /** GET a public path: no Authorization header, so it never fetches a
     *  token — in browser sign-in mode that would send a signed-out user to
     *  the sign-in page just to read the model catalogue. */
    getPublicJSON<T>(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /** GET path; return raw bytes + content-type (for video/audio downloads)
     *  and the ETag of those bytes, when the server sends one. */
    getRaw(path: string, init?: {
        signal?: AbortSignal;
        ifNoneMatch?: string;
    }): Promise<{
        data: Uint8Array;
        contentType: string;
        etag?: string;
        notModified?: boolean;
        serverTime?: number;
    }>;
    /** POST a multipart/form-data body. Used by audio.transcribe and image.edit. */
    postMultipart<T>(path: string, form: FormData, init?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /**
     * POST JSON body; return the raw streaming Response. Used by chat
     * streaming. Caller is responsible for consuming the SSE body.
     */
    postJSONStream(path: string, body: unknown, init?: {
        signal?: AbortSignal;
    }): Promise<Response>;
    /** PUT raw bytes with caller-supplied content type and headers. */
    putBytes<T>(path: string, body: BodyInit, opts?: {
        contentType?: string;
        headers?: Record<string, string>;
        signal?: AbortSignal;
        parse?: "json" | "none";
    }): Promise<T>;
    /** DELETE path; parse JSON response (or no body). */
    deletePath<T>(path: string, init?: {
        signal?: AbortSignal;
        parse?: "json" | "none";
    }): Promise<T>;
    /** HEAD path; surface status + selected response headers.  Used by
     *  exists / stat where the body would just be an opaque blob. */
    head(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<{
        status: number;
        headers: Headers;
    }>;
    private jsonHeaders;
    private authHeaders;
    private parseError;
}
/** The server's clock from a Date header, as ms since epoch. */
/**
 * The bare ETag value. A CDN that compresses the response marks the
 * ETag weak (`W/"…"`); the value is still the object's, and it is what
 * `If-Match` must carry on the next write.
 */
export declare function cleanETag(raw: string | null | undefined): string;
export declare function parseServerDate(h: string | null): number | undefined;
/** The byte length of a PUT body when it is known up front; undefined for
 *  streams and forms, which the browser frames itself. */
export declare function bodyByteLength(body: BodyInit): number | undefined;
//# sourceMappingURL=transport.d.ts.map