// idb-sync/log.ts — the SDK's own IndexedDB database.
//
// Holds what the sync engine needs to survive a reload:
//   ops  — local changes not yet pushed, in commit order. Values are kept
//          as the app wrote them (structured clone, Blobs included);
//          they are encoded only when pushed, so logging works offline.
//   meta — small key/value state: the owner (user id the local data
//          belongs to), shard ETags seen last, store clear marks.
//
// Opened through the untouched `indexedDB.open`, never the hooked one,
// and its name starts with `__runapps` so the hook leaves it alone.

export const SYNC_DB_NAME = "__runapps_sync__";
const SYNC_DB_VERSION = 1;

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

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export class SyncLog {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly open: (name: string, version?: number) => IDBOpenDBRequest) {}

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const r = this.open(SYNC_DB_NAME, SYNC_DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains("ops")) {
            const ops = db.createObjectStore("ops", { keyPath: "id", autoIncrement: true });
            ops.createIndex("store", ["db", "store"], { unique: false });
          }
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        };
        r.onsuccess = () => {
          const db = r.result;
          // Another tab upgrading (a future SDK) must not be blocked by us.
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };
        r.onerror = () => reject(r.error ?? new Error("cannot open sync log"));
        r.onblocked = () => reject(new Error("sync log open blocked"));
      });
      this.dbPromise.catch(() => {
        this.dbPromise = null;
      });
    }
    return this.dbPromise;
  }

  async append(ops: LoggedOp[]): Promise<void> {
    if (ops.length === 0) return;
    const db = await this.db();
    const tx = db.transaction("ops", "readwrite");
    const st = tx.objectStore("ops");
    for (const op of ops) st.add(op);
    await done(tx);
  }

  async pending(): Promise<LoggedOp[]> {
    const db = await this.db();
    const tx = db.transaction("ops", "readonly");
    const all = (await req(tx.objectStore("ops").getAll())) as LoggedOp[];
    return all;
  }

  async pendingCount(): Promise<number> {
    const db = await this.db();
    const tx = db.transaction("ops", "readonly");
    return req(tx.objectStore("ops").count());
  }

  async remove(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.db();
    const tx = db.transaction("ops", "readwrite");
    const st = tx.objectStore("ops");
    for (const id of ids) st.delete(id);
    await done(tx);
  }

  async clearOps(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("ops", "readwrite");
    tx.objectStore("ops").clear();
    await done(tx);
  }

  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.db();
    const tx = db.transaction("meta", "readonly");
    return (await req(tx.objectStore("meta").get(key))) as T | undefined;
  }

  async setMeta(entries: Record<string, unknown>): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("meta", "readwrite");
    const st = tx.objectStore("meta");
    for (const k of Object.keys(entries)) {
      if (entries[k] === undefined) st.delete(k);
      else st.put(entries[k], k);
    }
    await done(tx);
  }

  /** Every meta entry whose key starts with `prefix`, as a map. */
  async metaWithPrefix(prefix: string): Promise<Map<string, unknown>> {
    const db = await this.db();
    const tx = db.transaction("meta", "readonly");
    const st = tx.objectStore("meta");
    const range = IDBKeyRange.bound(prefix, prefix + "￿");
    const keys = (await req(st.getAllKeys(range))) as string[];
    const vals = await req(st.getAll(range));
    const out = new Map<string, unknown>();
    keys.forEach((k, i) => out.set(k, vals[i]));
    return out;
  }

  async clearAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["ops", "meta"], "readwrite");
    tx.objectStore("ops").clear();
    tx.objectStore("meta").clear();
    await done(tx);
  }

  close(): void {
    this.dbPromise?.then((db) => db.close()).catch(() => {});
    this.dbPromise = null;
  }
}

export { req as idbRequest, done as idbDone };
