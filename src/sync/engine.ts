// sync/engine.ts — keeps an app's IndexedDB and the user's cloud copy
// the same.
//
// Storage model (one object per shard, under the user's file space):
//
//   db/<database>/<store>/<shard>.json
//     { v: 1, cleared: <ts>, r: { <keyId>: { k, v, t, d? } } }
//
// A store's records are spread over a fixed number of shards by key
// hash, so a change rewrites one small object, and a device that has
// nothing new to see pays one conditional read per shard (304). Every
// record carries the timestamp of its last write; the newer write wins,
// a deletion is a record with `d: 1`, and a store `clear` raises the
// shard's `cleared` mark, which drops everything older. Shards are
// written with If-Match, so two devices never overwrite each other: the
// loser re-reads, merges and writes again.
//
// Locally the engine owns a change log (log.ts) fed by the hook
// (hook.ts); pushing turns pending ops into shard writes, pulling turns
// changed shards into writes on the app's database through the engine's
// own connection, which the hook does not observe.

import { changedFields, decodeKey, decodeValue, encodeKey, encodeValue, hash32, keyId, type BlobRef } from "./codec.js";
import { type CommittedOp, type InstalledHook, installIndexedDBHook } from "./hook.js";
import { idbDone, idbRequest, SyncLog, type LoggedOp } from "./log.js";
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
  list(prefix: string): Promise<{ path: string; etag: string }[]>;
  getJSON(path: string, ifNoneMatch?: string): Promise<{ status: "ok"; value: unknown; etag: string; serverTime?: number } | { status: "missing" } | { status: "unchanged" }>;
  putJSON(path: string, value: unknown, cond: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<{ status: "ok"; etag: string; serverTime?: number } | { status: "conflict" }>;
  putBlob(path: string, blob: Blob): Promise<void>;
  getBlob(path: string): Promise<Blob>;
}

interface ShardRecord {
  k: unknown;
  v: unknown;
  t: number;
  d?: 1;
  /** Per-field write times, kept for plain-object values so two devices
   *  editing different fields of one record both keep their edits. */
  f?: Record<string, number>;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !("$rt" in (v as object));
}

function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Fold an incoming write into the record already in the shard.
 *
 * Both plain objects: field by field. `changed` names the fields the
 * incoming write touched (the hook compared the record with its previous
 * value in the same transaction); every other field keeps the stored
 * value, which may have been written by another device meanwhile. A
 * changed field takes the incoming value unless the stored field was
 * written later by someone else; a field the incoming write dropped is
 * removed on the same condition. Without `changed` (an `add`, or a prior
 * value the hook could not read), a field is taken as changed when its
 * value differs. Anything else: the later write wins whole.
 */
function mergeRecord(cur: ShardRecord | undefined, inc: ShardRecord, changed?: string[]): ShardRecord {
  if (!cur) return inc;
  if (inc.d || cur.d || !isPlainRecord(cur.v) || !isPlainRecord(inc.v)) {
    return inc.t >= cur.t ? inc : cur;
  }
  const curF = cur.f ?? {};
  const touched = changed ? new Set(changed) : null;
  const out: Record<string, unknown> = {};
  const f: Record<string, number> = {};
  const fields = new Set([...Object.keys(cur.v), ...Object.keys(inc.v)]);
  for (const name of fields) {
    const inCur = name in cur.v;
    const inInc = name in inc.v;
    const curT = curF[name] ?? cur.t;
    const untouched = touched ? !touched.has(name) : inCur && inInc && sameJSON(cur.v[name], inc.v[name]);
    if (untouched) {
      if (inCur) {
        out[name] = cur.v[name];
        if (curF[name] !== undefined) f[name] = curF[name];
      }
      continue;
    }
    const incomingWins = inc.t >= curT;
    if (incomingWins) {
      if (inInc) {
        out[name] = inc.v[name];
        f[name] = inc.t;
      }
      // dropped by the incoming write: leave it out
    } else if (inCur) {
      out[name] = cur.v[name];
      f[name] = curT;
    }
  }
  return { k: inc.k, v: out, t: Math.max(cur.t, inc.t), f };
}

interface ShardOp {
  kid: string;
  rec: ShardRecord;
  changed?: string[];
}

interface Shard {
  v: 1;
  cleared: number;
  r: Record<string, ShardRecord>;
}

interface StoreSchema {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
}

const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_PUSH_DELAY_MS = 10_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/** Hybrid logical clock: wall time, never going backwards, with the
 *  server's clock offset applied once learned. */
class Clock {
  private last = 0;
  private offset = 0;
  now(): number {
    const t = Date.now() + this.offset;
    this.last = t > this.last ? t : this.last + 1;
    return this.last;
  }
  observe(serverTime: number, localBefore: number, localAfter: number): void {
    const mid = (localBefore + localAfter) / 2;
    const off = serverTime - mid;
    if (Math.abs(off - this.offset) > 2000) this.offset = off;
  }
}

function pathSeg(s: string): string {
  return encodeURIComponent(s).replace(/%2F/gi, "%2F");
}

export class SyncEngine {
  readonly options: Required<SyncOptions>;
  private readonly log: SyncLog;
  private readonly hook: InstalledHook | null;
  private readonly clock = new Clock();
  private readonly schemas = new Map<string, Map<string, StoreSchema>>();
  private readonly etags = new Map<string, string>();
  private readonly conns = new Map<string, Promise<IDBDatabase>>();
  private state: SyncState = { state: "off", pending: 0 };
  private paused = false;
  private disposed = false;
  private leader = true;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushDeadline = 0;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 0;
  private backoffUntil = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly cleanup: (() => void)[] = [];
  private channel: BroadcastChannel | null = null;
  private metaLoaded: Promise<void> | null = null;

  constructor(
    private readonly deps: SyncDeps,
    options: SyncOptions = {},
  ) {
    this.options = {
      databases: options.databases ?? [],
      exclude: options.exclude ?? [],
      shards: Math.max(1, Math.min(64, options.shards ?? 8)),
      pushDelayMs: options.pushDelayMs ?? 2500,
      pullIntervalMs: options.pullIntervalMs ?? 60_000,
      openTimeoutMs: options.openTimeoutMs ?? 5000,
      prefix: (options.prefix ?? "db").replace(/^\/+|\/+$/g, ""),
    };
    const excludedDbs = new Set(this.options.exclude.filter((e) => !e.includes("/")));
    const excludedStores = new Set(this.options.exclude.filter((e) => e.includes("/")));
    const only = new Set(this.options.databases);

    this.hook = installIndexedDBHook({
      include: (name) => (only.size === 0 || only.has(name)) && !excludedDbs.has(name),
      excludeStore: (db, store) => excludedStores.has(db + "/" + store),
      onCommit: (db, ops) => this.onCommit(db, ops),
      onOpen: (db, name) => this.onOpen(db, name),
      onDeleteDatabase: (name) => this.onDeleteDatabase(name),
      openTimeoutMs: this.options.openTimeoutMs,
      factory: deps.factory,
    });
    this.log = new SyncLog((name, version) =>
      this.hook ? this.hook.originalOpen(name, version) : indexedDB.open(name, version),
    );

    if (typeof window !== "undefined") this.attachBrowserTriggers();
    this.cleanup.push(deps.onAuthChange(() => this.schedule("auth")));
    void this.refreshPending();
    void this.schedule("start");
  }

  // ── Public surface ───────────────────────────────────────────────

  status(): SyncState {
    return { ...this.state };
  }

  /** Push pending changes and pull remote ones now. */
  now(): Promise<void> {
    if (!this.leader) {
      // Another tab syncs for this origin: ask it to go now. Its state
      // comes back over the channel.
      this.post({ type: "sync:request" });
      return Promise.resolve();
    }
    return this.enqueue(() => this.sync());
  }

  /** Send to the other tabs of this origin. */
  private post(msg: unknown): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* channel closed */
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.schedule("resume");
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.cleanup) c();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.channel?.close();
    for (const p of this.conns.values()) p.then((db) => db.close()).catch(() => {});
    this.conns.clear();
    this.log.close();
    this.hook?.uninstall();
  }

  // ── Hook callbacks ───────────────────────────────────────────────

  private onCommit(db: string, ops: CommittedOp[]): void {
    const logged: LoggedOp[] = [];
    for (const op of ops) {
      const ts = this.clock.now();
      if (op.kind === "clear") logged.push({ db, store: op.store, kind: "clear", kid: "", ts });
      else if (op.kind === "del") logged.push({ db, store: op.store, kind: "del", kid: keyId(op.key), key: encodeKey(op.key), ts });
      else {
        logged.push({
          db,
          store: op.store,
          kind: "put",
          kid: keyId(op.key),
          key: encodeKey(op.key),
          value: op.value,
          changed: op.prior === undefined ? undefined : changedFields(op.prior, op.value),
          ts,
        });
      }
    }
    this.enqueueLog(logged);
  }

  private logChain: Promise<void> = Promise.resolve();
  private enqueueLog(ops: LoggedOp[]): void {
    this.logChain = this.logChain
      .then(() => this.log.append(ops))
      .then(() => this.refreshPending())
      .then(() => {
        if (!this.leader) this.post({ type: "sync:request" });
      })
      .catch((err) => this.fail(err));
    this.schedulePush();
  }

  private async onOpen(db: IDBDatabase, name: string): Promise<void> {
    const schema = new Map<string, StoreSchema>();
    const names = Array.from(db.objectStoreNames);
    if (names.length > 0) {
      const tx = db.transaction(names, "readonly");
      for (const n of names) {
        const st = tx.objectStore(n);
        schema.set(n, { keyPath: st.keyPath as string | string[] | null, autoIncrement: st.autoIncrement });
        if (st.autoIncrement && typeof console !== "undefined") {
          console.warn(
            `[runapps sync] "${name}/${n}" uses autoIncrement keys: records created on two devices while offline can get the same key, and only one survives. Prefer client-generated ids (e.g. crypto.randomUUID()).`,
          );
        }
      }
    }
    this.schemas.set(name, schema);
    void this.log.setMeta({ ["schema:" + name]: Object.fromEntries(schema) }).catch(() => {});
    if (!this.deps.userId() || this.paused || !this.leader) return;
    await this.enqueue(() => this.pullDatabase(name)).catch(() => {});
  }

  private onDeleteDatabase(name: string): void {
    const schema = this.schemas.get(name);
    const stores = schema ? Array.from(schema.keys()) : [];
    this.schemas.delete(name);
    this.conns.get(name)?.then((db) => db.close()).catch(() => {});
    this.conns.delete(name);
    const ts = this.clock.now();
    this.enqueueLog(stores.map((store) => ({ db: name, store, kind: "clear" as const, kid: "", ts })));
  }

  // ── Scheduling ───────────────────────────────────────────────────

  private attachBrowserTriggers(): void {
    const on = (target: EventTarget, type: string, fn: () => void) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    on(window, "online", () => {
      this.backoffUntil = 0;
      void this.schedule("online");
    });
    on(window, "focus", () => void this.schedule("focus"));
    if (typeof document !== "undefined") {
      on(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") void this.schedule("visible");
        this.updatePullTimer();
      });
    }
    this.updatePullTimer();
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel("__runapps_db_change__");
      this.channel.onmessage = (ev) => {
        const d = ev.data as (DbChange & { type?: undefined }) | { type: "sync:state"; state: SyncState } | { type: "sync:request" } | undefined;
        if (!d) return;
        if (d.type === "sync:state") {
          // The leader's state is the origin's state; a follower shows it.
          if (!this.leader) {
            this.state = { ...d.state };
            this.deps.events.emit("sync:state", { ...d.state });
          }
        } else if (d.type === "sync:request") {
          // A follower wrote to the log, or wants a sync now: go, and
          // tell it where things stand either way.
          if (this.leader) {
            this.post({ type: "sync:state", state: { ...this.state } });
            void this.schedule("peer");
          }
        } else if (d.source === "remote") {
          this.deps.events.emit("db:change", d);
        }
      };
    }
    // One tab syncs at a time; the others feed the shared log and wait
    // for the lock, taking over when the leader closes.
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks && typeof locks.request === "function") {
      this.leader = false;
      // Until the lock is ours, another tab is syncing: ask it where
      // things stand so this tab does not sit on the initial "off".
      this.post({ type: "sync:request" });
      void locks
        .request("__runapps_sync__", () => {
          this.leader = true;
          void this.schedule("leader");
          return new Promise<void>(() => {}); // hold until the tab dies
        })
        .catch(() => {
          this.leader = true;
        });
    }
  }

  private updatePullTimer(): void {
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (visible && !this.pullTimer && this.options.pullIntervalMs > 0) {
      this.pullTimer = setInterval(() => void this.schedule("interval"), this.options.pullIntervalMs);
      (this.pullTimer as { unref?: () => void }).unref?.();
    } else if (!visible && this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
  }

  private schedulePush(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.pushDeadline) this.pushDeadline = now + MAX_PUSH_DELAY_MS;
    const delay = Math.max(0, Math.min(this.options.pushDelayMs, this.pushDeadline - now));
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushDeadline = 0;
      void this.schedule("push");
    }, delay);
    (this.pushTimer as { unref?: () => void }).unref?.();
  }

  private schedule(_reason: string): Promise<void> {
    if (this.disposed || this.paused || !this.leader) return Promise.resolve();
    if (!this.deps.userId()) {
      this.setState({ state: "off" });
      return Promise.resolve();
    }
    if (Date.now() < this.backoffUntil) return Promise.resolve();
    return this.enqueue(() => this.sync());
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ── State ────────────────────────────────────────────────────────

  /** Set while a sync cycle pushes or applies something. */
  private moved = false;

  private setState(patch: Partial<SyncState>): void {
    const next = { ...this.state, ...patch };
    if (patch.state && patch.state !== "error") delete next.error;
    const changed =
      next.state !== this.state.state ||
      next.pending !== this.state.pending ||
      next.lastSyncedAt !== this.state.lastSyncedAt ||
      next.lastChangeAt !== this.state.lastChangeAt ||
      next.error !== this.state.error;
    this.state = next;
    if (changed) {
      this.deps.events.emit("sync:state", { ...next });
      if (this.leader) this.post({ type: "sync:state", state: { ...next } });
    }
  }

  private async refreshPending(): Promise<void> {
    try {
      const n = await this.log.pendingCount();
      this.setState({ pending: n });
    } catch {
      /* log unavailable (private mode): stay with the last count */
    }
  }

  private fail(err: unknown): void {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const msg = err instanceof Error ? err.message : String(err);
    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
    this.backoffUntil = Date.now() + this.backoffMs;
    this.setState({ state: offline ? "offline" : "error", error: msg });
    if (!offline && typeof console !== "undefined") console.warn("[runapps sync]", msg);
  }

  // ── Sync ─────────────────────────────────────────────────────────

  private async loadMeta(): Promise<void> {
    if (!this.metaLoaded) {
      this.metaLoaded = (async () => {
        for (const [k, v] of await this.log.metaWithPrefix("etag:")) this.etags.set(k.slice(5), v as string);
        for (const [k, v] of await this.log.metaWithPrefix("schema:")) {
          const name = k.slice(7);
          if (!this.schemas.has(name)) {
            this.schemas.set(name, new Map(Object.entries(v as Record<string, StoreSchema>)));
          }
        }
      })();
      this.metaLoaded.catch(() => {
        this.metaLoaded = null;
      });
    }
    return this.metaLoaded;
  }

  /** The local copy belongs to one user. Another user signing in on the
   *  same browser starts from the server's copy, never from theirs. */
  private async ensureOwner(userId: string): Promise<void> {
    const owner = await this.log.getMeta<string>("owner");
    if (owner === userId) return;
    if (owner !== undefined) {
      for (const [db, schema] of this.schemas) {
        for (const store of schema.keys()) {
          if (this.storeExcluded(db, store)) continue;
          await this.withStore(db, store, "readwrite", (st) => {
            st.clear();
          }).catch(() => {});
          this.emitChange({ db, store, keys: [], cleared: true, source: "remote" });
        }
      }
      await this.log.clearAll();
      this.etags.clear();
      this.metaLoaded = null;
      await this.loadMeta();
    }
    await this.log.setMeta({ owner: userId });
  }

  private async sync(): Promise<void> {
    if (this.disposed || this.paused || !this.leader) return;
    const userId = this.deps.userId();
    if (!userId) {
      this.setState({ state: "off" });
      return;
    }
    this.setState({ state: "syncing" });
    this.moved = false;
    try {
      await this.loadMeta();
      await this.ensureOwner(userId);
      await this.logChain;
      await this.push();
      await this.pull();
      this.backoffMs = 0;
      this.backoffUntil = 0;
      await this.refreshPending();
      const now = Date.now();
      this.setState({ state: "idle", lastSyncedAt: now, ...(this.moved ? { lastChangeAt: now } : {}) });
    } catch (err) {
      await this.refreshPending();
      this.fail(err);
    }
  }

  private storeExcluded(db: string, store: string): boolean {
    return this.options.exclude.includes(db + "/" + store) || this.options.exclude.includes(db);
  }

  private shardPath(db: string, store: string, shard: number): string {
    return `${this.options.prefix}/${pathSeg(db)}/${pathSeg(store)}/${shard}.json`;
  }

  private shardOf(kid: string): number {
    return hash32(kid) % this.options.shards;
  }

  private async readShard(path: string): Promise<{ shard: Shard; etag?: string }> {
    const before = Date.now();
    const r = await this.deps.remote.getJSON(path);
    if (r.status === "ok") {
      if (r.serverTime) this.clock.observe(r.serverTime, before, Date.now());
      const s = r.value as Partial<Shard> | null;
      const shard: Shard = { v: 1, cleared: s?.cleared ?? 0, r: s?.r ?? {} };
      this.etags.set(path, r.etag);
      return { shard, etag: r.etag };
    }
    this.etags.delete(path);
    return { shard: { v: 1, cleared: 0, r: {} } };
  }

  // ── Push ─────────────────────────────────────────────────────────

  private async push(): Promise<void> {
    const ops = await this.log.pending();
    if (ops.length === 0) return;
    // Group by store, keeping commit order inside a store.
    const groups = new Map<string, LoggedOp[]>();
    for (const op of ops) {
      const k = op.db + "\u0000" + op.store;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(op);
    }
    const done: number[] = [];
    const etagUpdates: Record<string, unknown> = {};
    for (const [, g] of groups) {
      const db = g[0]!.db;
      const store = g[0]!.store;
      if (this.storeExcluded(db, store)) {
        for (const op of g) if (op.id !== undefined) done.push(op.id);
        continue;
      }
      // A clear drops everything written before it; ops after the last
      // clear are the ones that still matter.
      let clearedAt = 0;
      let lastClear = -1;
      g.forEach((op, i) => {
        if (op.kind === "clear") {
          clearedAt = Math.max(clearedAt, op.ts);
          lastClear = i;
        }
      });
      const live = g.slice(lastClear + 1);
      const byShard = new Map<number, LoggedOp[]>();
      for (const op of live) {
        const s = this.shardOf(op.kid);
        let list = byShard.get(s);
        if (!list) byShard.set(s, (list = []));
        list.push(op);
      }
      const shards = clearedAt > 0 ? Array.from({ length: this.options.shards }, (_, i) => i) : Array.from(byShard.keys());
      for (const n of shards) {
        const path = this.shardPath(db, store, n);
        const shardOps = byShard.get(n) ?? [];
        const encoded = await Promise.all(shardOps.map((op) => this.encodeOp(op)));
        const etag = await this.writeShard(path, clearedAt, encoded);
        etagUpdates["etag:" + path] = etag;
      }
      for (const op of g) if (op.id !== undefined) done.push(op.id);
    }
    await this.log.setMeta(etagUpdates);
    await this.log.remove(done);
    if (done.length > 0) this.moved = true;
    await this.refreshPending();
  }

  private async encodeOp(op: LoggedOp): Promise<ShardOp> {
    if (op.kind === "del") return { kid: op.kid, rec: { k: op.key, v: null, t: op.ts, d: 1 } };
    const v = await encodeValue(op.value, (blob) => this.storeBlob(blob));
    return { kid: op.kid, rec: { k: op.key, v, t: op.ts }, changed: op.changed };
  }

  /** Merge ops into one shard and write it; retried on a 412. */
  private async writeShard(path: string, clearedAt: number, ops: ShardOp[]): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { shard, etag } = await this.readShard(path);
      const now = this.clock.now();
      if (clearedAt > shard.cleared) {
        shard.cleared = clearedAt;
        for (const kid of Object.keys(shard.r)) {
          if (shard.r[kid]!.t <= clearedAt) delete shard.r[kid];
        }
      }
      for (const { kid, rec, changed } of ops) {
        if (rec.t <= shard.cleared) continue;
        shard.r[kid] = mergeRecord(shard.r[kid], rec, changed);
      }
      // Tombstones only matter until every device has seen them.
      for (const kid of Object.keys(shard.r)) {
        const rec = shard.r[kid]!;
        if (rec.d && now - rec.t > TOMBSTONE_TTL_MS) delete shard.r[kid];
      }
      const before = Date.now();
      const r = await this.deps.remote.putJSON(path, shard, etag ? { ifMatch: etag } : { ifNoneMatch: true });
      if (r.status === "ok") {
        if (r.serverTime) this.clock.observe(r.serverTime, before, Date.now());
        this.etags.set(path, r.etag);
        return r.etag;
      }
      this.etags.delete(path);
    }
    throw new Error(`could not write ${path}: too many concurrent writers`);
  }

  private async storeBlob(blob: Blob): Promise<BlobRef> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const ref = `${this.options.prefix}/_blobs/${hex}`;
    await this.deps.remote.putBlob(ref, blob);
    return { ref, type: blob.type, size: blob.size };
  }

  // ── Pull ─────────────────────────────────────────────────────────

  private async pull(): Promise<void> {
    const listing = await this.deps.remote.list(this.options.prefix + "/");
    await this.applyListing(listing);
  }

  private async pullDatabase(name: string): Promise<void> {
    if (!this.deps.userId()) return;
    await this.loadMeta();
    const listing = await this.deps.remote.list(`${this.options.prefix}/${pathSeg(name)}/`);
    await this.applyListing(listing);
  }

  private async applyListing(listing: { path: string; etag: string }[]): Promise<void> {
    const re = new RegExp("^" + this.options.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/([^/]+)/([^/]+)/(\\d+)\\.json$");
    const pending = await this.log.pending();
    const etagUpdates: Record<string, unknown> = {};
    for (const entry of listing) {
      const m = re.exec(entry.path);
      if (!m) continue;
      const db = decodeURIComponent(m[1]!);
      const store = decodeURIComponent(m[2]!);
      if (this.etags.get(entry.path) === entry.etag) continue;
      if (this.storeExcluded(db, store)) continue;
      const schema = this.schemas.get(db);
      if (!schema || !schema.has(store)) continue; // the app has not created it (yet)
      const r = await this.deps.remote.getJSON(entry.path, this.etags.get(entry.path));
      if (r.status === "unchanged") {
        continue;
      }
      if (r.status === "missing") {
        this.etags.delete(entry.path);
        etagUpdates["etag:" + entry.path] = undefined;
        continue;
      }
      const s = r.value as Partial<Shard> | null;
      const shard: Shard = { v: 1, cleared: s?.cleared ?? 0, r: s?.r ?? {} };
      await this.applyShard(db, store, shard, pending);
      this.etags.set(entry.path, r.etag);
      etagUpdates["etag:" + entry.path] = r.etag;
    }
    if (Object.keys(etagUpdates).length) await this.log.setMeta(etagUpdates);
  }

  private async applyShard(db: string, store: string, shard: Shard, pending: LoggedOp[]): Promise<void> {
    // A local write newer than the remote record wins until it is pushed.
    const localNewer = new Map<string, number>();
    let localClear = 0;
    for (const op of pending) {
      if (op.db !== db || op.store !== store) continue;
      if (op.kind === "clear") localClear = Math.max(localClear, op.ts);
      else localNewer.set(op.kid, Math.max(localNewer.get(op.kid) ?? 0, op.ts));
    }
    const clearKey = `cleared:${db}/${store}`;
    const appliedClear = (await this.log.getMeta<number>(clearKey)) ?? 0;
    const schema = this.schemas.get(db)?.get(store);
    const keys: IDBValidKey[] = [];
    let clearedLocally = false;
    await this.withStore(db, store, "readwrite", (st) => {
      if (shard.cleared > appliedClear && shard.cleared > localClear) {
        // Another device cleared this store after our last pull: drop the
        // local rows, keep what is still unpushed (replayed below).
        st.clear();
        clearedLocally = true;
      }
      for (const kid of Object.keys(shard.r)) {
        const rec = shard.r[kid]!;
        if ((localNewer.get(kid) ?? 0) >= rec.t) continue;
        if (rec.t <= localClear) continue;
        const key = decodeKey(rec.k);
        keys.push(key);
        if (rec.d) {
          st.delete(key);
        } else {
          // Values are decoded before the transaction (Blobs need the
          // network); see the pre-pass below.
          const value = (rec as ShardRecord & { _decoded?: unknown })._decoded;
          if (schema && schema.keyPath !== null) st.put(value);
          else st.put(value, key);
        }
      }
      if (clearedLocally) {
        for (const op of pending) {
          if (op.db !== db || op.store !== store || op.kind !== "put" || op.ts <= shard.cleared) continue;
          if (schema && schema.keyPath !== null) st.put(op.value);
          else st.put(op.value, decodeKey(op.key));
        }
      }
    }, async () => {
      for (const kid of Object.keys(shard.r)) {
        const rec = shard.r[kid]!;
        if (rec.d || (localNewer.get(kid) ?? 0) >= rec.t || rec.t <= localClear) continue;
        (rec as ShardRecord & { _decoded?: unknown })._decoded = await decodeValue(rec.v, (ref) =>
          this.deps.remote.getBlob(ref.ref),
        );
      }
    });
    if (shard.cleared > appliedClear) await this.log.setMeta({ [clearKey]: shard.cleared });
    if (keys.length > 0 || clearedLocally) {
      this.emitChange({ db, store, keys, cleared: clearedLocally, source: "remote" });
    }
  }

  private emitChange(change: DbChange): void {
    this.moved = true;
    this.deps.events.emit("db:change", change);
    try {
      this.post(change);
    } catch {
      /* keys that cannot be cloned across tabs: the local event already fired */
    }
  }

  // ── The engine's own connections ─────────────────────────────────

  private conn(db: string): Promise<IDBDatabase> {
    let p = this.conns.get(db);
    if (!p) {
      p = new Promise<IDBDatabase>((resolve, reject) => {
        const open = this.hook ? this.hook.originalOpen : (n: string) => indexedDB.open(n);
        const r = open(db);
        r.onsuccess = () => {
          const h = r.result;
          // Step aside when the app upgrades its schema.
          h.onversionchange = () => {
            h.close();
            this.conns.delete(db);
          };
          resolve(h);
        };
        r.onerror = () => reject(r.error ?? new Error(`cannot open ${db}`));
        r.onblocked = () => reject(new Error(`open of ${db} blocked`));
      });
      this.conns.set(db, p);
      p.catch(() => this.conns.delete(db));
    }
    return p;
  }

  private async withStore(
    db: string,
    store: string,
    mode: IDBTransactionMode,
    fn: (st: IDBObjectStore) => void,
    prepare?: () => Promise<void>,
  ): Promise<void> {
    if (prepare) await prepare();
    const h = await this.conn(db);
    if (!h.objectStoreNames.contains(store)) return;
    const tx = h.transaction(store, mode);
    fn(tx.objectStore(store));
    await idbDone(tx);
  }
}

export { idbRequest };
