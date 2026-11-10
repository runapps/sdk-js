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
    /** @internal How old an unfolded journal must be before a device other
     *  than its writer folds it. Default 2 min. */
    journalFoldAfterMs?: number;
    /** @internal How long a journal is kept after it was seen folded.
     *  Default 1 h. */
    journalKeepMs?: number;
}
export interface SyncState {
    /** off: no signed-in user; idle: everything pushed; syncing: a push or
     *  pull is running; offline: changes waiting for the network; error:
     *  the last attempt failed, will retry. */
    state: "off" | "idle" | "syncing" | "offline" | "error";
    /** Local changes not yet on the server. */
    pending: number;
    /** Changes that can never be synced (a value sync cannot store, such
     *  as a function or a DOM node) and were set aside. */
    failed?: number;
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
    /** remote: another device's change, just applied here. tab: another
     *  tab of this browser wrote to the shared database (IndexedDB has
     *  no event for that). */
    source: "remote" | "tab";
}
/** The part of the Web Storage API the engine uses. */
export interface KVStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    key(index: number): string | null;
    readonly length: number;
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
    /** Synchronous storage shared by the tabs of the origin. Default:
     *  localStorage in a browser, memory elsewhere. */
    storage?: KVStorage;
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
        serverTime?: number;
    } | {
        status: "unchanged";
        serverTime?: number;
    }
    /** Not JSON (a write cut short): neither data nor absence. */
     | {
        status: "corrupt";
        etag: string;
    }>;
    /** `keepalive`: the page is going away; let a small write finish after it. */
    putJSON(path: string, value: unknown, cond: {
        ifMatch?: string;
        ifNoneMatch?: boolean;
    }, opts?: {
        keepalive?: boolean;
    }): Promise<{
        status: "ok";
        etag: string;
        serverTime?: number;
    } | {
        status: "conflict";
    }>;
    /** Delete a file; a missing one is not an error. */
    remove(path: string): Promise<void>;
    putBlob(path: string, blob: Blob): Promise<void>;
    getBlob(path: string): Promise<Blob>;
}
export declare class SyncEngine {
    private readonly deps;
    readonly options: Required<SyncOptions>;
    private readonly log;
    private readonly hook;
    private readonly clock;
    private readonly storage;
    private readonly tabId;
    private readonly schemas;
    /** Shard ETags this device has applied. */
    private readonly etags;
    /** The last copy of a shard this engine read or wrote, with its etag:
     *  the next write merges into it and sends If-Match, and only a 412
     *  (someone else wrote in between) costs a read. Oldest first. */
    private readonly shardCache;
    /** Journals read (they never change), by path. */
    private readonly journalCache;
    /** Every shard path the last listing showed, and the prefixes that
     *  listing covered: a path under a covered prefix that isn't listed
     *  does not exist, and is created with If-None-Match, unread. */
    private readonly listedPaths;
    private readonly listedPrefixes;
    /** Databases this device has pulled at least once (writes made before
     *  are weak, see LoggedOp.weak). */
    private readonly pulled;
    /** Failed applies per shard path (see MAX_APPLY_ATTEMPTS). */
    private readonly applyFailures;
    private readonly conns;
    /** This tab's WAL, by commit. */
    private readonly walBatches;
    private walNext;
    private state;
    private paused;
    private disposed;
    private leader;
    private pushTimer;
    private pushDeadline;
    /** The page is going away (pagehide): writes ask to outlive it. */
    private leaving;
    /** Databases the app opened in this page — the ones a scan for
     *  records sync has never seen may open. */
    private readonly openedHere;
    /** Called when this tab is granted the sync lock. */
    private leaderWaiters;
    /** Followers waiting for the leader to pull a database for them. */
    private readonly pullWaiters;
    private pullTimer;
    private backoffMs;
    private backoffUntil;
    private chain;
    private readonly cleanup;
    private channel;
    private metaLoaded;
    /** Ops of other users in the log (not counted as pending). */
    private foreign;
    /** Set while a sync cycle pushes or applies something. */
    private moved;
    /** Set when an apply logged records the cloud did not have. */
    private adoptedAny;
    private pendingCache;
    private readyResolve;
    private readonly readyPromise;
    constructor(deps: SyncDeps, options?: SyncOptions);
    status(): SyncState;
    /** Resolves once the first sync has run (or there is nobody to sync
     *  for). */
    ready(): Promise<void>;
    /** Push pending changes and pull remote ones now. */
    now(): Promise<void>;
    pause(): void;
    resume(): void;
    dispose(): void;
    /** Send to the other tabs of this origin. */
    private post;
    private safeGet;
    private safeSet;
    /** The tabs of an origin write with one clock: the server offset the
     *  syncing tab learned, and the latest write time any of them made or
     *  saw. Without it a tab that never syncs itself would stamp its writes
     *  with the device's own (possibly wrong) time, and lose to a write
     *  that was in fact made earlier. */
    private readSharedClock;
    private saveClock;
    private readSeq;
    private bumpSeq;
    private writeWal;
    /** Every tab's WAL entries, by storage key. */
    private readWal;
    private onCommit;
    private logChain;
    private enqueueLog;
    /** Ops written before this device ever pulled their database lose to
     *  the cloud's copy (an app writing its defaults on a new device). */
    private markWeak;
    private isPulled;
    /** The app emptied stores while nobody was signed in: forget what this
     *  device held of them, so the next pull fills them again. */
    private forgetLocal;
    private onOpen;
    /** Pull one database now (an open waits for it). */
    private pullOne;
    private askLeaderToPull;
    private onDeleteDatabase;
    private attachBrowserTriggers;
    private becameLeader;
    /** Resolves true once this tab holds the sync lock, false after `ms`. */
    private becomesLeader;
    private updatePullTimer;
    /** Push what is waiting now (the page is being hidden or left). */
    private flush;
    private schedulePush;
    private schedule;
    private enqueue;
    private setState;
    private refreshPending;
    private fail;
    private dbPrefix;
    private journalPrefix;
    private shardPath;
    /** db, store and shard of a shard path; null for anything else. */
    private parseShardPath;
    private parseJournalPath;
    private loadMeta;
    /** Shard ETags an SDK before 0.20 applied (whole shards, without
     *  recording records). A shard still at that version is recorded from
     *  its content, without writing anything here. An older SDK still open
     *  in another tab keeps writing these. */
    private legacyEtags;
    /** Schemas as the tabs last saw them (a follower may have opened a
     *  database this tab never did). */
    private reloadSchemas;
    private checker;
    /** The local copy belongs to one user. Another user signing in on the
     *  same browser starts from the server's copy, never from theirs; the
     *  first user's unsent changes stay in the log, for when they sign in
     *  here again. */
    private ensureOwner;
    /** Writes whose logging never finished (their tab closed between the
     *  commit and the log write): log them again from the database. */
    private recoverWal;
    private sync;
    private storeExcluded;
    private shardOf;
    private readShard;
    private push;
    private pushDb;
    private encodeOp;
    /** Merge ops into one shard and write it; retried on a 412. The first
     *  try starts from the cached copy, or from nothing when the last
     *  listing showed no such shard — no read either way. Returns the
     *  shard as it now is, and its ETag (none when there is no file). */
    private writeShard;
    /** A shard this device just wrote is the cloud's current version: it
     *  holds what this device pushed, merged with what others wrote (a
     *  field merge, a retried write after a 412, a clear). Apply it here,
     *  as a pull would. */
    private applyWritten;
    private cacheShard;
    private knownAbsent;
    /** Remember what a listing of `prefix` showed (see listedPaths). */
    private rememberListing;
    private storeBlob;
    /** Pull every database this device knows, or one. Per-database
     *  failures are collected, so one bad database does not stop the
     *  others. */
    private pullDbs;
    private pullDb;
    private journalOps;
    private foldJournal;
    /**
     * Records already in the app's database before sync saw them — written
     * before the SDK loaded, or before the app used sync at all — are in no
     * log, so nothing would ever push them and they would stay on this
     * device. Once per store, every local record the cloud has no entry for
     * goes into the log stamped older than any real write: the ordinary
     * push adds it, and an edit made elsewhere still wins. Records the
     * cloud has are left alone (the pull has applied the cloud's version).
     */
    private adoptScan;
    /** Pending ops, re-read only when some tab logged something since. */
    private pendingOps;
    private buildGuard;
    /**
     * Bring the app's database in line with shards as read (or as just
     * written), record by record:
     *  - a record newer than the version held here is written (or, for a
     *    deletion, deleted), unless a local write newer than it is on its
     *    way to the cloud;
     *  - a record held here that its shard no longer has (a clear, a
     *    deletion whose tombstone has expired) is deleted;
     *  - a local record the cloud has never had is logged for upload.
     * A record that cannot be stored (a key that does not fit the store, a
     * unique index) is skipped and retried, never stalling the rest.
     * Returns the scanned stores whose scan was complete.
     */
    private applyDb;
    private applyTx;
    private applyStore;
    private emitChange;
    /** A connection to an app database; null when it does not exist (the
     *  engine never creates one). */
    private conn;
    /** Run `fn` on one store; false when the database or store does not
     *  exist. */
    private withStore;
}
export { idbRequest };
//# sourceMappingURL=engine.d.ts.map