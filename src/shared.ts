import type { Transport } from "./transport.js";
import { appSlugOf } from "./apps.js";
import type { FileObject, FilesService, PutFromURLOptions, PutOptions } from "./files.js";

// An app's public folder: what its creator keeps under `_public/` in their
// own files for the app, readable by anyone with no token at
// /v1/apps/<slug>/public/<path>. Templates, presets, skills, data the
// creator updates without touching the bundle; what the files mean is the
// app's business.
//
// Reads go out with no Authorization header, so they never ask anyone to
// sign in and a page can use them before anyone has. They are left to the
// browser's HTTP cache, which revalidates each one with the file's ETag:
// an update shows on the next read, an unchanged file costs a 304.

const PUBLIC_DIR = "_public/";

/** A file in an app's public folder. */
export interface SharedFile {
  /** Path inside the folder (no `_public/`). */
  path: string;
  size: number;
  content_type?: string;
  etag?: string;
  last_modified?: string;
  /** Needs no token: use it in `<img src>`, fetch(), a model call. */
  url: string;
}

export interface SharedListResult {
  files: SharedFile[];
  next_cursor?: string;
}

export interface SharedListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

function encodePath(path: string): string {
  return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

export class SharedService {
  constructor(
    private readonly transport: Transport,
    private readonly files: FilesService,
    private readonly project: string | undefined,
    private readonly fixedSlug?: string,
  ) {}

  /** The public folder of another app, to read. */
  of(slug: string): SharedService {
    return new SharedService(this.transport, this.files, this.project, slug);
  }

  private slug(): string {
    const fromHost = typeof location !== "undefined" ? appSlugOf(location.hostname) : "";
    const slug = this.fixedSlug || fromHost || this.project;
    if (!slug) throw new Error("client.shared: name the app with the `project` option or .of(slug)");
    return slug;
  }

  /** The address of a file; it needs no token. */
  url(path: string): string {
    return `${this.transport.baseURL}/v1/apps/${encodeURIComponent(this.slug())}/public/${encodePath(path)}`;
  }

  private async fetchFile(path: string, init?: { signal?: AbortSignal }): Promise<Response> {
    return this.transport.fetchPublic(this.url(path), init);
  }

  /** The folder's files in path order, a page at a time. */
  async list(opts?: SharedListOptions): Promise<SharedListResult> {
    const q = new URLSearchParams();
    if (opts?.prefix) q.set("prefix", opts.prefix);
    if (opts?.cursor) q.set("cursor", opts.cursor);
    if (opts?.limit) q.set("limit", String(opts.limit));
    const qs = q.toString() ? `?${q}` : "";
    const resp = await this.transport.fetchPublic(
      `${this.transport.baseURL}/v1/apps/${encodeURIComponent(this.slug())}/public${qs}`,
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    return (await resp.json()) as SharedListResult;
  }

  async get(path: string, init?: { signal?: AbortSignal }): Promise<Blob> {
    return (await this.fetchFile(path, init)).blob();
  }

  async text(path: string, init?: { signal?: AbortSignal }): Promise<string> {
    return (await this.fetchFile(path, init)).text();
  }

  async json<T = unknown>(path: string, init?: { signal?: AbortSignal }): Promise<T> {
    return (await this.fetchFile(path, init)).json() as Promise<T>;
  }

  /**
   * Copy a file into the signed-in user's own files for this app. The
   * platform does the copying, so nothing goes through the page; it is
   * billed to the user like any other write. Their copy is theirs: a later
   * update of the original does not touch it.
   */
  copy(path: string, to: string, opts?: PutFromURLOptions): Promise<FileObject> {
    return this.files.putFromURL(to, this.url(path), opts);
  }

  /** Whether the signed-in user created this app, so may publish to its
   *  folder. For showing the publishing controls to the right person. */
  async canPublish(init?: { signal?: AbortSignal }): Promise<boolean> {
    const me = await this.transport.getJSON<{ is_creator?: boolean }>(
      `/v1/me?app=${encodeURIComponent(this.slug())}`,
      init,
    );
    return me.is_creator === true;
  }

  /**
   * Publish a file: for the app's creator, signed in to this app. These
   * are the ordinary file calls on `_public/<path>`, so `ifMatch` guards a
   * read-modify-write as usual. In anyone else's hands the same write only
   * lands in their own files, where nobody reads it.
   */
  put(path: string, body: Parameters<FilesService["put"]>[1], opts?: PutOptions): Promise<FileObject> {
    return this.files.put(PUBLIC_DIR + path.replace(/^\/+/, ""), body, opts);
  }

  /** Remove a published file. */
  remove(path: string, init?: { signal?: AbortSignal }): Promise<void> {
    return this.files.del(PUBLIC_DIR + path.replace(/^\/+/, ""), init);
  }
}
