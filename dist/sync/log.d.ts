export declare const SYNC_DB_NAME = "__runapps_sync__";
export declare const SYNC_STATE_DB_NAME = "__runapps_sync_state__";
/** put / del / clear act on one store; dbclear on every store of the
 *  database (the app deleted it). */
export type OpKind = "put" | "del" | "clear" | "dbclear";
export interface LoggedOp {
    id?: number;
    db: string;
    store: string;
    kind: OpKind;
    /** Canonical key id (codec.keyId); "" for clear. */
    kid: string;
    /** Encoded key (codec.encodeKey); undefined for clear. */
    key?: unknown;
    /** The value as written, for put; the store names, for dbclear. */
    value?: unknown;
    /** For a put of a plain object whose previous value was seen: the
     *  fields this write changed (added, modified or removed). Undefined
     *  means "treat every field as changed". */
    changed?: string[];
    /** Hybrid logical clock timestamp (ms, monotonic per device). */
    ts: number;
    /** The user the write was made for; null when nobody was signed in.
     *  Absent on ops logged before SDK 0.20: they belong to the owner. */
    owner?: string | null;
    /** Written before this device had pulled the database even once: the
     *  cloud's own copy of a record wins over it (an app's defaults must
     *  not overwrite the user's data). */
    weak?: boolean;
}
/** The cloud version of one record this device holds. */
export interface AppliedEntry {
    /** Write time of the record. */
    t: number;
    /** Shard it lives in. */
    s: number;
    /** Hash of the record as applied: a field merge can change a record
     *  without raising its time. */
    h?: number;
}
declare function req<T>(r: IDBRequest<T>): Promise<T>;
declare function done(tx: IDBTransaction): Promise<void>;
export declare class SyncLog {
    private readonly open;
    private mainPromise;
    private statePromise;
    constructor(open: (name: string, version?: number) => IDBOpenDBRequest);
    private openDb;
    private db;
    private state;
    append(ops: LoggedOp[]): Promise<void>;
    pending(): Promise<LoggedOp[]>;
    pendingCount(): Promise<number>;
    remove(ids: number[]): Promise<void>;
    /** Give every op whose owner is `from` (undefined: logged before owners
     *  were recorded, or null: nobody signed in) to `to`. */
    reassignOwner(from: (o: string | null | undefined) => boolean, to: string): Promise<void>;
    /** Move ops that can never be pushed out of the way. */
    bury(ops: {
        op: LoggedOp;
        error: string;
    }[]): Promise<void>;
    /** db\0store\0kid of every op set aside. */
    deadKeys(): Promise<Set<string>>;
    deadCount(): Promise<number>;
    appliedFor(dbName: string, store: string): Promise<Map<string, AppliedEntry>>;
    /** Forget what this device holds of one store or a whole database,
     *  and the shard ETags under `markPrefix`. */
    forgetApplied(dbName: string, store: string | undefined, markPrefix: string): Promise<void>;
    /** Bookkeeping for one apply, in one transaction: what this device
     *  now holds of each store, and the shard ETags applied (undefined:
     *  forget). */
    commitApply(dbName: string, applied: Map<string, Map<string, AppliedEntry | undefined>>, marks: Map<string, string | undefined>): Promise<void>;
    /** Every shard ETag applied record by record. */
    marks(): Promise<Map<string, string>>;
    /** The user `applied` describes. */
    stateOwner(): Promise<string | undefined>;
    /** Forget everything held (applied and marks) and record a new owner. */
    resetState(owner: string): Promise<void>;
    setStateOwner(owner: string): Promise<void>;
    getMeta<T = unknown>(key: string): Promise<T | undefined>;
    setMeta(entries: Record<string, unknown>): Promise<void>;
    /** Every meta entry whose key starts with `prefix`, as a map. */
    metaWithPrefix(prefix: string): Promise<Map<string, unknown>>;
    /** Delete every meta entry whose key starts with one of `prefixes`. */
    deleteMetaWithPrefix(...prefixes: string[]): Promise<void>;
    /** A new owner: every meta entry, and everything held. The ops (which
     *  carry their owner) and the dead letters stay. */
    resetForOwner(owner: string): Promise<void>;
    close(): void;
}
export { req as idbRequest, done as idbDone };
//# sourceMappingURL=log.d.ts.map