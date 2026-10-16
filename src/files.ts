// Per-project file system at /v1/files/*.  Files are stored under
// (user, project) on the gateway and addressed by POSIX-style paths.
// Each FileObject's `url` is a stable public address — embed it
// directly in `<img src>`, share it, persist it.
//
// The bundle's RunApps client uses `client.files` to access these
// endpoints; the underlying token must be a project-bound resource
// token (rrt_*) issued by the grant flow.

import { cleanETag, type Transport } from "./transport.js";
import type { SDKEvents } from "./events.js";
import { wrapEvents } from "./event-wrap.js";

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

export type BatchOp =
  | { op: "put_url"; path: string; src_url: string; content_type?: string; if_none_match?: boolean; if_match?: string }
  | { op: "del"; path: string }
  | { op: "move"; from: string; to: string }
  | { op: "copy"; from: string; to: string }
  | { op: "exists"; path: string }
  | { op: "stat"; path: string };

export interface BatchResult {
  ok: boolean;
  error?: string;
  object?: FileObject;
  exists?: boolean;
}

function pathToURL(base: string, p: string): string {
  const trimmed = p.replace(/^\/+/, "");
  return base + "/" + trimmed.split("/").map(encodeURIComponent).join("/");
}

export class FilesService {
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
  private readonly legacyBase: string;
  private readonly project: string | undefined;
  private readonly filesBase: string | false | undefined;
  private baseCache: { fp: string; base: string } | null = null;
  private basePending: Promise<string> | null = null;

  constructor(
    private readonly transport: Transport,
    project?: string,
    /** When given, every call emits request:start / end / error so the
     *  badge can show it in flight; the sync engine's own file traffic
     *  uses a service without one. */
    private readonly events?: SDKEvents,
    /** `false`: stay on the classic /v1 paths; a string: use this as the
     *  per-user base instead of asking the gateway. */
    filesBase?: string | false,
  ) {
    this.project = project;
    this.filesBase = filesBase;
    this.legacyBase = project
      ? "/v1/p/" + encodeURIComponent(project) + "/files"
      : "/v1/files";
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
  private async base(): Promise<string> {
    if (this.filesBase === false) return this.legacyBase;
    const tail = this.project ? "/p/" + encodeURIComponent(this.project) + "/files" : "/files";
    if (typeof this.filesBase === "string") return this.filesBase.replace(/\/+$/, "") + tail;
    const fp = await this.transport.tokenFingerprint();
    if (this.baseCache && this.baseCache.fp === fp) return this.baseCache.base;
    if (!this.basePending) {
      this.basePending = (async () => {
        let base = this.legacyBase;
        try {
          const r = await this.transport.getJSON<{ base?: string }>("/v1/files-base");
          if (r && typeof r.base === "string" && /^https?:\/\//i.test(r.base)) base = r.base.replace(/\/+$/, "") + tail;
        } catch {
          // Older gateway or a transient failure: the classic path still works.
        }
        this.baseCache = { fp, base };
        return base;
      })().finally(() => { this.basePending = null; });
    }
    return this.basePending;
  }

  /** Run one file call, with badge events when the service has a bus. */
  private run<T>(op: string, fn: () => Promise<T>): Promise<T> {
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
  async put(
    path: string,
    body: BodyInit,
    opts?: PutOptions,
  ): Promise<FileObject> {
    const headers: Record<string, string> = {};
    if (opts?.ifNoneMatch) headers["If-None-Match"] = "*";
    if (opts?.ifMatch) headers["If-Match"] = `"${cleanETag(opts.ifMatch)}"`;
    return this.run("files.put", async () => this.transport.putBytes<FileObject>(pathToURL(await this.base(), path), body, {
      contentType: opts?.contentType,
      headers: Object.keys(headers).length ? headers : undefined,
      signal: opts?.signal,
    }));
  }

  /** Convenience: upload string content with sensible content-type. */
  async putString(
    path: string,
    content: string,
    opts?: PutOptions,
  ): Promise<FileObject> {
    return this.put(path, content, {
      ...opts,
      contentType: opts?.contentType ?? "text/plain; charset=utf-8",
    });
  }

  /**
   * Download the bytes at `path` as a Blob.  Use `URL.createObjectURL`
   * to get a temporary local URL, or persist the bytes elsewhere.
   * Bundles that just need to render an asset should use the FileObject's
   * `.url` directly instead — that's a stable public URL with no token.
   */
  async get(path: string, init?: { signal?: AbortSignal }): Promise<Blob> {
    return (await this.read(path, init)).blob;
  }

  /**
   * Like `get`, but also returns the ETag of the bytes, so a later
   * `put(path, body, { ifMatch: etag })` writes only if the file is
   * still the version that was read.
   */
  async read(path: string, init?: { signal?: AbortSignal; ifNoneMatch?: string }): Promise<FileRead> {
    return this.run("files.read", () => this.readRaw(path, init));
  }

  private async readRaw(path: string, init?: { signal?: AbortSignal; ifNoneMatch?: string }): Promise<FileRead> {
    const { data, contentType, etag, notModified } = await this.transport.getRaw(pathToURL(await this.base(), path), init);
    return {
      blob: new Blob([new Uint8Array(data)], { type: contentType || "application/octet-stream" }),
      contentType,
      etag,
      ...(notModified ? { notModified: true } : {}),
    };
  }

  /**
   * Read a JSON file and its version in one call. A missing file is
   * `{ value: undefined, etag: undefined }`, so a first save can pass
   * `ifNoneMatch: true` and a later one `ifMatch: etag`.
   */
  async readJSON<T = unknown>(
    path: string,
    init?: { signal?: AbortSignal; ifNoneMatch?: string },
  ): Promise<{ value: T | undefined; etag?: string; notModified?: boolean }> {
    let r: FileRead & { notModified?: boolean };
    try {
      r = await this.read(path, init);
    } catch (e) {
      if ((e as { statusCode?: number; status?: number })?.statusCode === 404 ||
          (e as { statusCode?: number; status?: number })?.status === 404) {
        return { value: undefined, etag: undefined };
      }
      throw e;
    }
    if (r.notModified) return { value: undefined, etag: r.etag, notModified: true };
    return { value: JSON.parse(await r.blob.text()) as T, etag: r.etag };
  }

  /** Stat: HEAD-only object metadata. */
  async stat(path: string, init?: { signal?: AbortSignal }): Promise<FileObject> {
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
      content_type: headers.get("content-type") ?? undefined,
      etag: (headers.get("etag") ?? "").replace(/"/g, "") || undefined,
      url: headers.get("x-file-url") ?? "",
    };
  }

  /** Returns true iff the path resolves to an existing object. */
  async exists(path: string, init?: { signal?: AbortSignal }): Promise<boolean> {
    const { status } = await this.run("files.exists", async () => this.transport.head(pathToURL(await this.base(), path), init));
    return status >= 200 && status < 400;
  }

  /** Delete the object at `path`.  Idempotent. */
  async del(path: string, init?: { signal?: AbortSignal }): Promise<void> {
    await this.run("files.del", async () => this.transport.deletePath<{ ok: boolean }>(pathToURL(await this.base(), path), init));
  }

  /** List objects.  Pass an empty / omitted prefix for the root. */
  async list(opts?: ListOptions): Promise<FileListResult> {
    const params = new URLSearchParams();
    if (opts?.prefix) params.set("prefix", opts.prefix);
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.glob) params.set("glob", opts.glob);
    const qs = params.toString();
    return this.run("files.list", async () => this.transport.getJSON<FileListResult>(
      (await this.base()) + (qs ? "?" + qs : ""),
      opts?.signal ? { signal: opts.signal } : undefined,
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
  async deleteMany(
    opts: { prefix?: string; glob?: string },
    init?: { signal?: AbortSignal },
  ): Promise<{ deleted: number }> {
    return this.run("files.deleteMany", async () => this.transport.postJSON<{ deleted: number }>(
      (await this.base()) + "/delete",
      { prefix: opts.prefix ?? "", glob: opts.glob ?? "" },
      init,
    ));
  }

  /** Atomic rename (copy + delete server-side). */
  async move(from: string, to: string, init?: { signal?: AbortSignal }): Promise<FileObject> {
    return this.run("files.move", async () => this.transport.postJSON<FileObject>((await this.base()) + "/move", { from, to }, init));
  }

  /** Server-side copy. */
  async copy(from: string, to: string, init?: { signal?: AbortSignal }): Promise<FileObject> {
    return this.run("files.copy", async () => this.transport.postJSON<FileObject>((await this.base()) + "/copy", { from, to }, init));
  }

  /**
   * Ask the gateway to fetch `srcURL` and store the body at `path`.
   * Saves a round trip vs downloading then re-uploading.  `srcURL`
   * must be a public http(s) URL (private/loopback hosts rejected).
   */
  async putFromURL(
    path: string,
    srcURL: string,
    opts?: PutFromURLOptions,
  ): Promise<FileObject> {
    return this.run("files.putFromURL", async () => this.transport.postJSON<FileObject>(
      (await this.base()) + "/put-url",
      {
        path,
        src_url: srcURL,
        content_type: opts?.contentType,
        if_none_match: opts?.ifNoneMatch,
        if_match: opts?.ifMatch,
      },
      opts?.signal ? { signal: opts.signal } : undefined,
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
  async batch(
    ops: BatchOp[],
    init?: { signal?: AbortSignal },
  ): Promise<BatchResult[]> {
    if (ops.length === 0) return [];
    return this.run("files.batch", () => this.batchRaw(ops, init));
  }

  private async batchRaw(ops: BatchOp[], init?: { signal?: AbortSignal }): Promise<BatchResult[]> {
    const chunkSize = 30;
    if (ops.length <= chunkSize) {
      const resp = await this.transport.postJSON<{ results: BatchResult[] }>(
        (await this.base()) + "/batch",
        { ops },
        init,
      );
      return resp.results;
    }
    const all: BatchResult[] = [];
    for (let i = 0; i < ops.length; i += chunkSize) {
      const chunk = ops.slice(i, i + chunkSize);
      const resp = await this.transport.postJSON<{ results: BatchResult[] }>(
        (await this.base()) + "/batch",
        { ops: chunk },
        init,
      );
      all.push(...resp.results);
    }
    return all;
  }
}
