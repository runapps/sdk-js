import type { Transport } from "./transport.js";
import type { FileObject, FilesService, PutFromURLOptions, PutOptions } from "./files.js";
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
export declare class SharedService {
    private readonly transport;
    private readonly files;
    private readonly project;
    private readonly fixedSlug?;
    constructor(transport: Transport, files: FilesService, project: string | undefined, fixedSlug?: string | undefined);
    /** The public folder of another app, to read. */
    of(slug: string): SharedService;
    private slug;
    /** The address of a file; it needs no token. */
    url(path: string): string;
    private fetchFile;
    /** The folder's files in path order, a page at a time. */
    list(opts?: SharedListOptions): Promise<SharedListResult>;
    get(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<Blob>;
    text(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<string>;
    json<T = unknown>(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /**
     * Copy a file into the signed-in user's own files for this app. The
     * platform does the copying, so nothing goes through the page; it is
     * billed to the user like any other write. Their copy is theirs: a later
     * update of the original does not touch it.
     */
    copy(path: string, to: string, opts?: PutFromURLOptions): Promise<FileObject>;
    /** Whether the signed-in user created this app, so may publish to its
     *  folder. For showing the publishing controls to the right person. */
    canPublish(init?: {
        signal?: AbortSignal;
    }): Promise<boolean>;
    /**
     * Publish a file: for the app's creator, signed in to this app. These
     * are the ordinary file calls on `_public/<path>`, so `ifMatch` guards a
     * read-modify-write as usual. In anyone else's hands the same write only
     * lands in their own files, where nobody reads it.
     */
    put(path: string, body: Parameters<FilesService["put"]>[1], opts?: PutOptions): Promise<FileObject>;
    /** Remove a published file. */
    remove(path: string, init?: {
        signal?: AbortSignal;
    }): Promise<void>;
}
//# sourceMappingURL=shared.d.ts.map