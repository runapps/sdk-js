import { type Transport } from "./transport.js";
import type { SDKEvents } from "./events.js";
export interface FileObject {
    path: string;
    size: number;
    content_type?: string;
    etag?: string;
    last_modified?: string;
    url: string;
}
export interface FileListResult {
    files: FileObject[];
    next_cursor?: string;
}
export interface PutOptions {
    /** Override the MIME type guessed from the path extension. */
    contentType?: string;
    /** Refuse to overwrite an existing object (gateway returns 409). */
    ifNoneMatch?: boolean;
    /**
     * Write only if the stored object still has this ETag — the one
     * `read()` / `stat()` / a previous `put()` returned. Someone else
     * having written in between makes the gateway answer 412 instead
     * of silently overwriting their version; re-read, merge, put again.
     */
    ifMatch?: string;
    signal?: AbortSignal;
}
/** The bytes at a path together with the version they are. */
export interface FileRead {
    blob: Blob;
    contentType: string;
    /** Pass back as `ifMatch` to write only if nobody else has since. */
    etag?: string;
}
export interface SignOptions {
    /** How long the link stays valid, in seconds. Default 3600, at most 7 days. */
    expiresIn?: number;
    /** When true the link downloads instead of displaying inline. */
    download?: boolean;
    signal?: AbortSignal;
}
export interface ListOptions {
    prefix?: string;
    cursor?: string;
    limit?: number;
    /**
     * Shell-style pattern, post-filtered after the underlying S3 list:
     *   *      any chars except `/`
     *   **     any chars including `/`
     *   ?      single non-slash char
     *   [abc]  character class
     *
     * Examples:
     *   client.files.list({ glob: "*.png" })
     *   client.files.list({ glob: "projects/*\/assets/*.png" })
     *   client.files.list({ prefix: "projects/", glob: "**\/*.wav" })
     *
     * S3 has no native glob — the gateway extracts the longest literal
     * head of the pattern as the underlying prefix scan, then filters
     * the rest in process.  Patterns must match the WHOLE path; no
     * implicit anchoring needed.
     */
    glob?: string;
    signal?: AbortSignal;
}
export interface PutFromURLOptions {
    contentType?: string;
    ifNoneMatch?: boolean;
    ifMatch?: string;
    signal?: AbortSignal;
}
export type BatchOp = {
    op: "put_url";
    path: string;
    src_url: string;
    content_type?: string;
    if_none_match?: boolean;
    if_match?: string;
} | {
    op: "del";
    path: string;
} | {
    op: "move";
    from: string;
    to: string;
} | {
    op: "copy";
    from: string;
    to: string;
} | {
    op: "exists";
    path: string;
} | {
    op: "stat";
    path: string;
};
export interface BatchResult {
    ok: boolean;
    error?: string;
    object?: FileObject;
    exists?: boolean;
}
export declare class FilesService {
    private readonly transport;
    /** When given, every call emits request:start / end / error so the
     *  badge can show it in flight; the sync engine's own file traffic
     *  uses a service without one. */
    private readonly events?;
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
    private readonly legacyBase;
    private readonly project;
    private readonly filesBase;
    private baseCache;
    private basePending;
    constructor(transport: Transport, project?: string, 
    /** When given, every call emits request:start / end / error so the
     *  badge can show it in flight; the sync engine's own file traffic
     *  uses a service without one. */
    events?: SDKEvents | undefined, 
    /** `false`: stay on the classic /v1 paths; a string: use this as the
     *  per-user base instead of asking the gateway. */
    filesBase?: string | false);
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
    private base;
    /** Run one file call, with badge events when the service has a bus. */
    private run;
    /**
     * Upload `body` to `path`.  Returns the resulting FileObject — its
     * `url` is the stable public address for that path.
     *
     * `body` accepts anything `fetch` accepts as a request body: Blob,
     * File, ArrayBuffer, ArrayBufferView, FormData (rare here),
     * ReadableStream, or a string.
     */
    put(path: string, body: BodyInit, opts?: PutOptions): Promise<FileObject>;
    /** Convenience: upload string content with sensible content-type. */
    putString(path: string, content: string, opts?: PutOptions): Promise<FileObject>;
    /**
     * Download the bytes at `path` as a Blob.  Use `URL.createObjectURL`
     * to get a temporary local URL, or persist the bytes elsewhere.
     * Bundles that just need to render an asset should use the FileObject's
     * `.url` directly instead — that's a stable public URL with no token.
     */
    get(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<Blob>;
    /**
     * Like `get`, but also returns the ETag of the bytes, so a later
     * `put(path, body, { ifMatch: etag })` writes only if the file is
     * still the version that was read.
     */
    read(path: string, init?: {
        signal?: AbortSignal;
        ifNoneMatch?: string;
    }): Promise<FileRead>;
    private readRaw;
    /**
     * Read a JSON file and its version in one call. A missing file is
     * `{ value: undefined, etag: undefined }`, so a first save can pass
     * `ifNoneMatch: true` and a later one `ifMatch: etag`.
     */
    readJSON<T = unknown>(path: string, init?: {
        signal?: AbortSignal;
        ifNoneMatch?: string;
    }): Promise<{
        value: T | undefined;
        etag?: string;
        notModified?: boolean;
    }>;
    /** Stat: HEAD-only object metadata. */
    stat(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<FileObject>;
    /** Returns true iff the path resolves to an existing object. */
    exists(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<boolean>;
    /** Delete the object at `path`.  Idempotent. */
    del(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<void>;
    /** List objects.  Pass an empty / omitted prefix for the root. */
    list(opts?: ListOptions): Promise<FileListResult>;
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
    deleteMany(opts: {
        prefix?: string;
        glob?: string;
    }, init?: {
        signal?: AbortSignal;
    }): Promise<{
        deleted: number;
    }>;
    /** Atomic rename (copy + delete server-side). */
    move(from: string, to: string, init?: {
        signal?: AbortSignal;
    }): Promise<FileObject>;
    /** Server-side copy. */
    copy(from: string, to: string, init?: {
        signal?: AbortSignal;
    }): Promise<FileObject>;
    /**
     * A time-limited link to a private file that needs no token: put it in
     * `<img src>`, `<video src>` or `<a href download>`. The link is for
     * this user's copy of the file in this app; it expires after
     * `expiresIn` seconds (default one hour, at most seven days) and is
     * never cached, so it always shows the current bytes. For a permanent
     * public address use the FileObject's `url` instead.
     */
    url(path: string, opts?: SignOptions): Promise<string>;
    /** Signed links for several paths at once (up to 200): `{ path: url }`. */
    urls(paths: string[], opts?: SignOptions): Promise<Record<string, string>>;
    /**
     * Ask the gateway to fetch `srcURL` and store the body at `path`.
     * Saves a round trip vs downloading then re-uploading.  `srcURL`
     * must be a public http(s) URL (private/loopback hosts rejected).
     */
    putFromURL(path: string, srcURL: string, opts?: PutFromURLOptions): Promise<FileObject>;
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
    batch(ops: BatchOp[], init?: {
        signal?: AbortSignal;
    }): Promise<BatchResult[]>;
    private batchRaw;
}
//# sourceMappingURL=files.d.ts.map