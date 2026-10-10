export declare const SYNC_DB_NAME = "__runapps_sync__";
export type OpKind = "put" | "del" | "clear";
export interface LoggedOp {
    id?: number;
    db: string;
    store: string;
    kind: OpKind;
    /** Canonical key id (codec.keyId); "" for clear. */
    kid: string;
    /** Encoded key (codec.encodeKey); undefined for clear. */
    key?: unknown;
    /** The value as written, for put. */
    value?: unknown;
    /** For a put of a plain object whose previous value was seen: the
     *  fields this write changed (added, modified or removed). Undefined
     *  means "treat every field as changed". */
    changed?: string[];
    /** Hybrid logical clock timestamp (ms, monotonic per device). */
    ts: number;
}
declare function req<T>(r: IDBRequest<T>): Promise<T>;
declare function done(tx: IDBTransaction): Promise<void>;
export declare class SyncLog {
    private readonly open;
    private dbPromise;
    constructor(open: (name: string, version?: number) => IDBOpenDBRequest);
    private db;
    append(ops: LoggedOp[]): Promise<void>;
    pending(): Promise<LoggedOp[]>;
    pendingCount(): Promise<number>;
    remove(ids: number[]): Promise<void>;
    clearOps(): Promise<void>;
    getMeta<T = unknown>(key: string): Promise<T | undefined>;
    setMeta(entries: Record<string, unknown>): Promise<void>;
    /** Every meta entry whose key starts with `prefix`, as a map. */
    metaWithPrefix(prefix: string): Promise<Map<string, unknown>>;
    clearAll(): Promise<void>;
    close(): void;
}
export { req as idbRequest, done as idbDone };
//# sourceMappingURL=log.d.ts.map