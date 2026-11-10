// sync/hook.ts — observe an app's IndexedDB writes without the app
// knowing.
//
// There is no browser event for "an object store changed", so the SDK
// wraps the few prototype methods every write goes through — on the
// factory, the database, object stores and cursors. Dexie, idb,
// idb-keyval, zustand's IndexedDB storage and hand-written code all end
// up in these methods, so they are all observed.
//
// What the hook does:
//   open()          returns a request that forwards the real one's
//                   events, and delays `success` until `onOpen` (the
//                   engine's first pull) has run, so a new device sees
//                   its data on the first read.
//   transaction()   attaches a change collector to readwrite
//                   transactions on observed databases.
//   put/add/delete/clear, cursor.update/delete
//                   record the committed change into the collector; the
//                   batch is handed to `onCommit` only when the
//                   transaction completes, so an aborted write is never
//                   synced. A put also reads the record's previous value
//                   first (same transaction), so the engine can tell which
//                   fields the write changed and merge field by field.
//
// Writes the engine itself makes while applying remote changes go
// through its own connection, which is never tagged, so they are not
// recorded again.
//
// Several subscribers (engines) can be installed at once; each sees the
// databases its `include` admits, on the factory it was bound to (tests
// run one "device" per factory; a page has one factory).

import { extractKey, injectKey } from "./codec.js";

export type CommittedOp =
  | { store: string; kind: "put"; key: IDBValidKey; value: unknown; prior?: unknown }
  | { store: string; kind: "del"; key: IDBValidKey }
  | { store: string; kind: "clear" };

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
  /** The app deleted an observed database (called once the delete has
   *  succeeded; a blocked or failed delete changes nothing). */
  onDeleteDatabase: (dbName: string) => void;
  openTimeoutMs: number;
  /** Only observe this factory's databases. Default: the global one at
   *  install time. */
  factory?: IDBFactory;
}

export interface InstalledHook {
  /** The factory's untouched open — for the SDK's own databases. */
  originalOpen: (name: string, version?: number) => IDBOpenDBRequest;
  /** A connection the SDK opened for itself: never observed, even when
   *  its database is one the app uses. */
  markInternal(db: IDBDatabase): void;
  uninstall(): void;
}

interface Subscriber {
  opts: HookOptions;
  factory: IDBFactory | null;
}

interface TxState {
  db: string;
  subs: Subscriber[];
  ops: CommittedOp[];
}

interface DbInfo {
  name: string;
  subs: Subscriber[];
}

const txState = new WeakMap<IDBTransaction, TxState>();
/** IDBDatabase handles the app obtained through the hooked open. */
const observedDbs = new WeakMap<IDBDatabase, DbInfo>();
/** The running upgrade transaction of a connection (deleteObjectStore
 *  is only allowed inside one). */
const upgradeTx = new WeakMap<IDBDatabase, IDBTransaction>();
/** The SDK's own connections: never observed. */
const internalDbs = new WeakSet<IDBDatabase>();
/** Connections already looked at by `lazyObserve`. */
const lazyChecked = new WeakSet<IDBDatabase>();
const subscribers = new Set<Subscriber>();
let originals: {
  open: IDBFactory["open"];
  deleteDatabase: IDBFactory["deleteDatabase"];
  transaction: IDBDatabase["transaction"];
  put: IDBObjectStore["put"];
  add: IDBObjectStore["add"];
  get: IDBObjectStore["get"];
  delete: IDBObjectStore["delete"];
  clear: IDBObjectStore["clear"];
  deleteObjectStore: IDBDatabase["deleteObjectStore"];
  getAllKeys: IDBObjectStore["getAllKeys"];
  cursorUpdate: IDBCursor["update"];
  cursorDelete: IDBCursor["delete"];
} | null = null;

function clone<T>(v: T): T {
  try {
    return typeof structuredClone === "function" ? structuredClone(v) : v;
  } catch {
    return v;
  }
}

function isPlainObject(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Minimal event with `target` pointing at the hooked request. */
function makeEvent(type: string, init?: { oldVersion?: number; newVersion?: number | null }, target?: object): Event {
  let ev: Event;
  if (init && typeof IDBVersionChangeEvent === "function") {
    ev = new IDBVersionChangeEvent(type, { oldVersion: init.oldVersion, newVersion: init.newVersion ?? null });
  } else {
    ev = new Event(type, { bubbles: false, cancelable: type === "error" });
    if (init) Object.assign(ev, init);
  }
  if (target) {
    for (const p of ["target", "currentTarget", "srcElement"]) {
      try {
        Object.defineProperty(ev, p, { value: target, configurable: true });
      } catch {
        /* locked-down event implementation; listeners read request.result anyway */
      }
    }
  }
  return ev;
}

type Handler = ((ev: Event) => unknown) | null;

/**
 * Stand-in for the IDBOpenDBRequest the app would have received. It has
 * the same surface (result, error, readyState, transaction, source,
 * the four on* handlers, add/removeEventListener) and an
 * IDBOpenDBRequest prototype chain so `instanceof` holds.
 */
class HookedOpenRequest {
  readyState: "pending" | "done" = "pending";
  result: IDBDatabase | undefined = undefined;
  error: DOMException | null = null;
  transaction: IDBTransaction | null = null;
  readonly source: null = null;
  private listeners = new Map<string, Set<(ev: Event) => unknown>>();
  private handlers: Record<string, Handler> = { success: null, error: null, blocked: null, upgradeneeded: null };

  constructor(real: IDBOpenDBRequest, name: string, subs: Subscriber[]) {
    real.addEventListener("upgradeneeded", (ev) => {
      const e = ev as IDBVersionChangeEvent;
      this.result = real.result;
      this.transaction = real.transaction;
      observedDbs.set(real.result, { name, subs });
      // Writes an upgrade makes (a migration rewriting records, a store
      // deleted) are app writes like any other.
      if (real.transaction) {
        track(real.transaction, name, subs);
        upgradeTx.set(real.result, real.transaction);
      }
      this.dispatch(makeEvent("upgradeneeded", { oldVersion: e.oldVersion, newVersion: e.newVersion }, this));
    });
    real.addEventListener("blocked", (ev) => {
      const e = ev as IDBVersionChangeEvent;
      this.dispatch(makeEvent("blocked", { oldVersion: e.oldVersion, newVersion: e.newVersion }, this));
    });
    real.addEventListener("error", () => {
      this.error = real.error;
      this.readyState = "done";
      this.transaction = null;
      this.dispatch(makeEvent("error", undefined, this));
    });
    real.addEventListener("success", () => {
      const db = real.result;
      observedDbs.set(db, { name, subs });
      this.transaction = null;
      let settled = false;
      const deliver = () => {
        if (settled) return;
        settled = true;
        this.result = db;
        this.readyState = "done";
        this.dispatch(makeEvent("success", undefined, this));
      };
      // Hold success for the engines' first pull, bounded by a timeout
      // so an offline device still opens.
      const waits: Promise<void>[] = [];
      let timeout = 0;
      for (const s of subs) {
        try {
          const p = s.opts.onOpen(db, name);
          if (p && typeof (p as Promise<void>).then === "function") {
            waits.push((p as Promise<void>).catch(() => {}));
            timeout = Math.max(timeout, s.opts.openTimeoutMs);
          }
        } catch {
          /* a failing onOpen must not keep the app from its database */
        }
      }
      if (waits.length === 0) {
        deliver();
        return;
      }
      const timer = setTimeout(deliver, timeout);
      Promise.all(waits).then(() => {
        clearTimeout(timer);
        deliver();
      });
    });
  }

  addEventListener(type: string, listener: ((ev: Event) => unknown) | { handleEvent(ev: Event): unknown } | null): void {
    if (!listener) return;
    const fn = typeof listener === "function" ? listener : (ev: Event) => listener.handleEvent(ev);
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    (listener as { __rtFn?: (ev: Event) => unknown }).__rtFn = fn;
  }

  removeEventListener(type: string, listener: ((ev: Event) => unknown) | { handleEvent(ev: Event): unknown } | null): void {
    if (!listener) return;
    const fn = typeof listener === "function" ? listener : (listener as { __rtFn?: (ev: Event) => unknown }).__rtFn;
    if (fn) this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(ev: Event): boolean {
    this.dispatch(ev);
    return !ev.defaultPrevented;
  }

  private dispatch(ev: Event): void {
    const h = this.handlers[ev.type];
    if (h) {
      try {
        h.call(this, ev);
      } catch (err) {
        reportListenerError(err);
      }
    }
    for (const fn of this.listeners.get(ev.type) ?? []) {
      try {
        fn.call(this, ev);
      } catch (err) {
        reportListenerError(err);
      }
    }
  }

  get onsuccess(): Handler { return this.handlers.success ?? null; }
  set onsuccess(h: Handler) { this.handlers.success = h; }
  get onerror(): Handler { return this.handlers.error ?? null; }
  set onerror(h: Handler) { this.handlers.error = h; }
  get onblocked(): Handler { return this.handlers.blocked ?? null; }
  set onblocked(h: Handler) { this.handlers.blocked = h; }
  get onupgradeneeded(): Handler { return this.handlers.upgradeneeded ?? null; }
  set onupgradeneeded(h: Handler) { this.handlers.upgradeneeded = h; }
}

function reportListenerError(err: unknown): void {
  // Same as the browser: a throwing listener is reported, not swallowed
  // silently, and does not stop the other listeners.
  setTimeout(() => {
    throw err;
  }, 0);
}

if (typeof IDBOpenDBRequest === "function") {
  Object.setPrototypeOf(HookedOpenRequest.prototype, IDBOpenDBRequest.prototype);
}

/** Object store of a cursor, whether it was opened on a store or an index. */
function cursorStore(cursor: IDBCursor): IDBObjectStore {
  const src = cursor.source as IDBObjectStore | IDBIndex;
  return typeof IDBIndex === "function" && src instanceof IDBIndex ? src.objectStore : (src as IDBObjectStore);
}

function subscribersFor(factory: IDBFactory, name: string): Subscriber[] {
  if (name.startsWith("__runapps")) return [];
  const out: Subscriber[] = [];
  for (const s of subscribers) {
    if ((s.factory === null || s.factory === factory) && s.opts.include(name)) out.push(s);
  }
  return out;
}

/** Collect a readwrite (or upgrade) transaction's writes and hand them
 *  to the subscribers when it commits. */
function track(tx: IDBTransaction, dbName: string, subs: Subscriber[]): void {
  if (txState.has(tx)) return;
  const st: TxState = { db: dbName, subs, ops: [] };
  txState.set(tx, st);
  tx.addEventListener("complete", () => {
    if (st.ops.length === 0) return;
    const ops = st.ops;
    st.ops = [];
    for (const s of st.subs) {
      const mine = ops.filter((op) => !s.opts.excludeStore(st.db, op.store));
      if (mine.length === 0) continue;
      try {
        s.opts.onCommit(st.db, mine);
      } catch (err) {
        reportListenerError(err);
      }
    }
  });
}

/** A connection the app opened before the hook was installed (or by a
 *  path that bypassed it): observe it from its first transaction on, as
 *  if it had come through the hooked open. */
function lazyObserve(db: IDBDatabase): DbInfo | undefined {
  if (lazyChecked.has(db) || internalDbs.has(db)) return undefined;
  lazyChecked.add(db);
  if (typeof indexedDB === "undefined") return undefined;
  const subs = subscribersFor(indexedDB, db.name);
  if (subs.length === 0) return undefined;
  const info = { name: db.name, subs };
  observedDbs.set(db, info);
  for (const s of subs) {
    try {
      void Promise.resolve(s.opts.onOpen(db, db.name)).catch(() => {});
    } catch {
      /* never block the app */
    }
  }
  return info;
}

/** The snapshot of a value IndexedDB gave a generated key: the key goes
 *  into the snapshot at the store's keyPath, as it went into the stored
 *  record, or the other devices would store it under a key of their own. */
function withGeneratedKey(store: IDBObjectStore, snapshot: unknown, key: IDBValidKey): unknown {
  if (!store.autoIncrement || typeof store.keyPath !== "string" || store.keyPath === "") return snapshot;
  if (extractKey(snapshot, store.keyPath) !== undefined) return snapshot;
  injectKey(snapshot, store.keyPath, key);
  return snapshot;
}

function patchPrototypes(): void {
  const F = IDBFactory.prototype;
  const D = IDBDatabase.prototype;
  const S = IDBObjectStore.prototype;
  const C = IDBCursor.prototype;
  const o = (originals = {
    open: F.open,
    deleteDatabase: F.deleteDatabase,
    transaction: D.transaction,
    put: S.put,
    add: S.add,
    get: S.get,
    delete: S.delete,
    clear: S.clear,
    deleteObjectStore: D.deleteObjectStore,
    getAllKeys: S.getAllKeys,
    cursorUpdate: C.update,
    cursorDelete: C.delete,
  });

  const tracked = (store: IDBObjectStore): TxState | null => txState.get(store.transaction) ?? null;

  F.open = function (this: IDBFactory, name: string, version?: number): IDBOpenDBRequest {
    const real = version === undefined ? o.open.call(this, name) : o.open.call(this, name, version);
    const subs = subscribersFor(this, name);
    if (subs.length === 0) return real;
    return new HookedOpenRequest(real, name, subs) as unknown as IDBOpenDBRequest;
  };

  F.deleteDatabase = function (this: IDBFactory, name: string): IDBOpenDBRequest {
    const subs = subscribersFor(this, name);
    const r = o.deleteDatabase.call(this, name);
    if (subs.length > 0) {
      // Only a delete that happened counts: a blocked one may never.
      r.addEventListener("success", () => {
        for (const s of subs) {
          try {
            s.opts.onDeleteDatabase(name);
          } catch {
            /* never block the app's delete */
          }
        }
      });
    }
    return r;
  };

  D.deleteObjectStore = function (this: IDBDatabase, name: string): void {
    const info = observedDbs.get(this);
    o.deleteObjectStore.call(this, name);
    if (!info) return;
    // Only possible inside an upgrade: the upgrade transaction is the
    // one with this database's state.
    const tx = upgradeTx.get(this);
    const st = tx ? txState.get(tx) : undefined;
    if (st) st.ops.push({ store: name, kind: "clear" });
  };

  D.transaction = function (
    this: IDBDatabase,
    storeNames: string | string[],
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ): IDBTransaction {
    const tx =
      options !== undefined
        ? o.transaction.call(this, storeNames, mode, options)
        : mode !== undefined
          ? o.transaction.call(this, storeNames, mode)
          : o.transaction.call(this, storeNames);
    const info = observedDbs.get(this) ?? lazyObserve(this);
    if (info && tx.mode === "readwrite") track(tx, info.name, info.subs);
    return tx;
  };

  S.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    const st = tracked(this);
    let prior: { value: unknown } | null = null;
    if (st && isPlainObject(value)) {
      // The record's previous value, read before the write in the same
      // transaction, tells the engine which fields this write changed.
      const k = key !== undefined ? key : extractKey(value, this.keyPath as string | string[] | null);
      if (k !== undefined) {
        try {
          const g = o.get.call(this, k);
          const slot = (prior = { value: undefined });
          g.addEventListener("success", () => {
            slot.value = g.result;
          });
        } catch {
          prior = null;
        }
      }
    }
    const r = key === undefined ? o.put.call(this, value) : o.put.call(this, value, key);
    if (st) {
      const store = this.name;
      const snapshot = clone(value);
      const priorSlot = prior;
      const self = this;
      r.addEventListener("success", () => {
        st.ops.push({ store, kind: "put", key: r.result, value: withGeneratedKey(self, snapshot, r.result), prior: priorSlot?.value });
      });
    }
    return r;
  };

  S.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    const r = key === undefined ? o.add.call(this, value) : o.add.call(this, value, key);
    const st = tracked(this);
    if (st) {
      const store = this.name;
      const snapshot = clone(value);
      const self = this;
      r.addEventListener("success", () => {
        st.ops.push({ store, kind: "put", key: r.result, value: withGeneratedKey(self, snapshot, r.result) });
      });
    }
    return r;
  };

  S.delete = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
    const st = tracked(this);
    if (!st) return o.delete.call(this, query);
    const store = this.name;
    // Which keys a range covers is only knowable before the delete;
    // getAllKeys runs first in the same transaction. Either way the op is
    // recorded when the delete succeeds, so it keeps its place among the
    // transaction's other writes (a put then a delete of one key must
    // end deleted).
    let keys: IDBValidKey[] = [];
    if (typeof IDBKeyRange === "function" && query instanceof IDBKeyRange) {
      const kr = o.getAllKeys.call(this, query);
      kr.addEventListener("success", () => {
        keys = kr.result;
      });
    } else {
      keys = [query as IDBValidKey];
    }
    const r = o.delete.call(this, query);
    r.addEventListener("success", () => {
      for (const k of keys) st.ops.push({ store, kind: "del", key: k });
    });
    return r;
  };

  S.clear = function (this: IDBObjectStore): IDBRequest<undefined> {
    const st = tracked(this);
    const r = o.clear.call(this);
    if (st) {
      const store = this.name;
      r.addEventListener("success", () => {
        st.ops.push({ store, kind: "clear" });
      });
    }
    return r;
  };

  C.update = function (this: IDBCursor, value: unknown): IDBRequest<IDBValidKey> {
    const store = cursorStore(this);
    const st = tracked(store);
    // The stored record, not `cursor.value`: an app usually edits
    // cursor.value in place and passes it back, so it already shows the
    // change and the fields that changed could not be told.
    let prior: { value: unknown } | null = null;
    if (st && isPlainObject(value)) {
      try {
        const g = o.get.call(store, this.primaryKey);
        const slot = (prior = { value: undefined });
        g.addEventListener("success", () => {
          slot.value = g.result;
        });
      } catch {
        prior = null;
      }
    }
    const r = o.cursorUpdate.call(this, value);
    if (st) {
      const name = store.name;
      const snapshot = clone(value);
      const key = this.primaryKey;
      const priorSlot = prior;
      r.addEventListener("success", () => {
        st.ops.push({ store: name, kind: "put", key, value: snapshot, prior: priorSlot?.value });
      });
    }
    return r;
  };

  C.delete = function (this: IDBCursor): IDBRequest<undefined> {
    const store = cursorStore(this);
    const st = tracked(store);
    const key = this.primaryKey;
    const r = o.cursorDelete.call(this);
    if (st) {
      r.addEventListener("success", () => {
        st.ops.push({ store: store.name, kind: "del", key });
      });
    }
    return r;
  };
}

function restorePrototypes(): void {
  if (!originals) return;
  const o = originals;
  IDBFactory.prototype.open = o.open;
  IDBFactory.prototype.deleteDatabase = o.deleteDatabase;
  IDBDatabase.prototype.transaction = o.transaction;
  IDBObjectStore.prototype.put = o.put;
  IDBObjectStore.prototype.add = o.add;
  IDBObjectStore.prototype.delete = o.delete;
  IDBObjectStore.prototype.clear = o.clear;
  IDBDatabase.prototype.deleteObjectStore = o.deleteObjectStore;
  IDBCursor.prototype.update = o.cursorUpdate;
  IDBCursor.prototype.delete = o.cursorDelete;
  originals = null;
}

/**
 * Install the hook for one subscriber. The prototypes are patched on the
 * first install and restored when the last subscriber uninstalls.
 */
export function installIndexedDBHook(opts: HookOptions): InstalledHook | null {
  if (
    typeof indexedDB === "undefined" ||
    typeof IDBFactory !== "function" ||
    typeof IDBDatabase !== "function" ||
    typeof IDBObjectStore !== "function" ||
    typeof IDBCursor !== "function"
  ) {
    return null;
  }
  if (!originals) patchPrototypes();
  const o = originals!;
  const sub: Subscriber = { opts, factory: opts.factory ?? indexedDB };
  subscribers.add(sub);
  const factory = sub.factory as IDBFactory;
  return {
    originalOpen: (name, version) =>
      version === undefined ? o.open.call(factory, name) : o.open.call(factory, name, version),
    markInternal(db) {
      internalDbs.add(db);
    },
    uninstall() {
      subscribers.delete(sub);
      if (subscribers.size === 0) restorePrototypes();
    },
  };
}
