import { idbRequest } from "./log.js";
import type { SDKEvents } from "../events.js";
export interface SyncOptions {
    /** Observe only these databases (by name). Default: every database the
     *  app opens, except the SDK's own. */
    databases?: string[];
    /** Leave out a whole database (`"cache"`) or one store (`"app/videos"`). */
    exclude?: string[];
    /** Shards per store. Default 8. Changing it later splits data: pick once. */
    shards?: number;
    /** How long to gather local writes before pushing. Default 2500 ms. */
    pushDelayMs?: number;
    /** Background pull interval while the page is visible. Default 60 s. */
    pullIntervalMs?: number;
    /** How long a database open waits for the first pull. Default 5 s. */
    openTimeoutMs?: number;
    /** Path prefix in the user's file space. Default "db". */
    prefix?: string;
}
export interface SyncState {
    /** off: no signed-in user; idle: everything pushed; syncing: a push or
     *  pull is running; offline: changes waiting for the network; error:
     *  the last attempt failed, will retry. */
    state: "off" | "idle" | "syncing" | "offline" | "error";
    /** Local changes not yet on the server. */
    pending: number;
    lastSyncedAt?: number;
    /** When a sync last moved data — pushed local writes or applied
     *  another device's. A quiet pull that found nothing leaves it. */
    lastChangeAt?: number;
    error?: string;
}
export interface DbChange {
    db: string;
    store: string;
    /** Primary keys that changed; empty when the whole store was cleared. */
    keys: IDBValidKey[];
    cleared: boolean;
    source: "remote";
}
/** What the engine needs from the rest of the SDK. */
export interface SyncDeps {
    remote: SyncRemote;
    events: SDKEvents;
    /** Signed-in user id, or null. */
    userId: () => string | null;
    /** Subscribe to sign-in changes. */
    onAuthChange: (cb: () => void) => () => void;
    /** The IndexedDB factory to observe. Default: the global one. */
    factory?: IDBFactory;
}
/** The storage side. Implemented over FilesService; tests use memory. */
export interface SyncRemote {
    list(prefix: string): Promise<{
        path: string;
        etag: string;
    }[]>;
    getJSON(path: string, ifNoneMatch?: string): Promise<{
        status: "ok";
        value: unknown;
        etag: string;
        serverTime?: number;
    } | {
        status: "missing";
    } | {
        status: "unchanged";
    }>;
    putJSON(path: string, value: unknown, cond: {
        ifMatch?: string;
        ifNoneMatch?: boolean;
    }): Promise<{
        status: "ok";
        etag: string;
        serverTime?: number;
    } | {
        status: "conflict";
    }>;
    putBlob(path: string, blob: Blob): Promise<void>;
    getBlob(path: string): Promise<Blob>;
}
export declare class SyncEngine {
    private readonly deps;
    readonly options: Required<SyncOptions>;
    private readonly log;
    private readonly hook;
    private readonly clock;
    private readonly schemas;
    private readonly etags;
    private readonly conns;
    private state;
    private paused;
    private disposed;
    private leader;
    private pushTimer;
    private pushDeadline;
    private pullTimer;
    private backoffMs;
    private backoffUntil;
    private chain;
    private readonly cleanup;
    private channel;
    private metaLoaded;
    constructor(deps: SyncDeps, options?: SyncOptions);
    status(): SyncState;
    /** Push pending changes and pull remote ones now. */
    now(): Promise<void>;
    pause(): void;
    resume(): void;
    dispose(): void;
    private onCommit;
    private logChain;
    private enqueueLog;
    private onOpen;
    private onDeleteDatabase;
    private attachBrowserTriggers;
    private updatePullTimer;
    private schedulePush;
    private schedule;
    private enqueue;
    /** Set while a sync cycle pushes or applies something. */
    private moved;
    private setState;
    private refreshPending;
    private fail;
    private loadMeta;
    /** The local copy belongs to one user. Another user signing in on the
     *  same browser starts from the server's copy, never from theirs. */
    private ensureOwner;
    private sync;
    private storeExcluded;
    private shardPath;
    private shardOf;
    private readShard;
    private push;
    private encodeOp;
    /** Merge ops into one shard and write it; retried on a 412. */
    private writeShard;
    private storeBlob;
    private pull;
    private pullDatabase;
    private applyListing;
    private applyShard;
    private emitChange;
    private conn;
    private withStore;
}
export { idbRequest };
//# sourceMappingURL=engine.d.ts.map