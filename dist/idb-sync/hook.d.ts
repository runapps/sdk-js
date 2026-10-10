export type CommittedOp = {
    store: string;
    kind: "put";
    key: IDBValidKey;
    value: unknown;
    prior?: unknown;
} | {
    store: string;
    kind: "del";
    key: IDBValidKey;
} | {
    store: string;
    kind: "clear";
};
export interface HookOptions {
    /** Which databases (by name) to observe. */
    include: (dbName: string) => boolean;
    /** Stores to leave out of sync. */
    excludeStore: (dbName: string, store: string) => boolean;
    /** A readwrite transaction on an observed database committed. */
    onCommit: (dbName: string, ops: CommittedOp[]) => void;
    /** The app opened an observed database. The open request's success is
     *  held until this resolves (or `openTimeoutMs` passes). */
    onOpen: (db: IDBDatabase, dbName: string) => Promise<void> | void;
    /** The app deleted an observed database. */
    onDeleteDatabase: (dbName: string) => void;
    openTimeoutMs: number;
    /** Only observe this factory's databases. Default: the global one at
     *  install time. */
    factory?: IDBFactory;
}
export interface InstalledHook {
    /** The factory's untouched open — for the SDK's own databases. */
    originalOpen: (name: string, version?: number) => IDBOpenDBRequest;
    uninstall(): void;
}
/**
 * Install the hook for one subscriber. The prototypes are patched on the
 * first install and restored when the last subscriber uninstalls.
 */
export declare function installIndexedDBHook(opts: HookOptions): InstalledHook | null;
//# sourceMappingURL=hook.d.ts.map