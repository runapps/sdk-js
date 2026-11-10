// sync/engine.ts — keeps an app's IndexedDB and the user's cloud copy
// the same.
//
// Storage model (under the user's file space for the app):
//
//   db/<database>/<store>/<shard>.json
//     { v: 1, cleared: <ts>, r: { <keyId>: { k, v, t, d?, f? } } }
//   db/@j/<database>/<id>.json      (journals, see below)
//
// A store's records are spread over a fixed number of shards by key
// hash, so a change rewrites one small object, and a device that has
// nothing new to see pays one listing. Every record carries the time of
// its last write; the later write wins (plain objects field by field), a
// deletion is a record with `d: 1`, and a store `clear` raises the
// shard's `cleared` mark, which drops everything older. Shards are
// written with If-Match, so two devices never overwrite each other: the
// loser re-reads, merges and writes again.
//
// Journals make a push that touches several shard files all-or-nothing
// for readers. The writer first stores every op of the push as one
// journal file, then folds the ops into the shards. A reader lists the
// journals after reading the shards, and merges every journal it has
// not seen folded into what it read: a push cut short after one shard
// (page closed, network gone) is seen whole or not at all. A journal
// left unfolded (its writer went away) is folded by whichever device
// sees it after a while; journals are deleted an hour after they were
// seen folded.
//
// Locally the engine owns a change log (log.ts) fed by the hook
// (hook.ts); pushing turns pending ops into shard writes, pulling turns
// changed shards into writes on the app's database through the engine's
// own connection, which the hook does not observe. The log also records,
// per record, the cloud version this device holds ("applied"): a pulled
// record is written locally only when it is newer than that, a record
// the cloud no longer has is deleted here, and a local record the cloud
// has never had is uploaded ("adopted").

import { changedFields, decodeKey, decodeValue, encodeKey, encodeValue, extractKey, hash32, injectKey, keyId, type BlobRef } from "./codec.js";
import { type CommittedOp, type InstalledHook, installIndexedDBHook } from "./hook.js";
import { idbDone, idbRequest, SyncLog, type AppliedEntry, type LoggedOp } from "./log.js";
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
  list(prefix: string): Promise<{ path: string; etag: string }[]>;
  getJSON(
    path: string,
    ifNoneMatch?: string,
  ): Promise<
    | { status: "ok"; value: unknown; etag: string; serverTime?: number }
    | { status: "missing"; serverTime?: number }
    | { status: "unchanged"; serverTime?: number }
    /** Not JSON (a write cut short): neither data nor absence. */
    | { status: "corrupt"; etag: string }
  >;
  /** `keepalive`: the page is going away; let a small write finish after it. */
  putJSON(path: string, value: unknown, cond: { ifMatch?: string; ifNoneMatch?: boolean }, opts?: { keepalive?: boolean }): Promise<{ status: "ok"; etag: string; serverTime?: number } | { status: "conflict" }>;
  /** Delete a file; a missing one is not an error. */
  remove(path: string): Promise<void>;
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

/** Fold a clear mark and ops into a shard, in place. */
function mergeInto(shard: Shard, clearedAt: number, ops: ShardOp[]): void {
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
}

type JournalOp = [kid: string, rec: ShardRecord, changed?: string[]];

/** One push that touched several shard files of a database. */
interface Journal {
  v: 1;
  id: string;
  db: string;
  /** Write time (the writer's clock). */
  t: number;
  /** Per store: the clear mark, the shard files, the ops in order. */
  s: Record<string, { c?: number; n: number[]; o: JournalOp[] }>;
}

interface StoreSchema {
  keyPath: string | string[] | null;
  autoIncrement: boolean;
}

/** Ops not yet in the log, keyed by what they touched: written
 *  synchronously when a transaction commits, dropped once the log has
 *  them. Shared by the tabs (localStorage): an apply must not overwrite
 *  a local write that is on its way into the log, and a write whose
 *  logging never finished (the tab died) is found and logged again.
 *  [db, store | "*" (every store), kid | "*" (every record) | "?"
 *  (unknown records: the entry was too big to store), time, wall time
 *  of the commit, owner] */
type WalEntry = [db: string, store: string, kid: string, ts: number, wall: number, owner: string | null];

/** Local writes the apply must not overwrite: by record, by store
 *  (clears) and for the whole database. */
interface Guard {
  kid: Map<string, number>;
  store: Map<string, number>;
  db: number;
}

const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;
/** Shards one push writes at a time. Each is a read-merge-write against
 *  the files API, so the push is latency bound: done one by one, a few
 *  hundred records over every shard took a minute and a half. */
const PUSH_CONCURRENCY = 6;
/** Shard copies kept, with their etags, so a write needs no read first. */
const SHARD_CACHE_MAX = 256;
/** The write time given to a record that was in the app's database
 *  before sync saw it, and to a write made before this device had ever
 *  pulled the database: older than any real write, so the cloud's copy
 *  and an edit made anywhere else win over it. */
const ADOPTED_TS = 1;
/** How long a database open waits for this tab to be granted the sync
 *  lock when the page has just loaded (another tab holding it: no wait
 *  beyond this). */
const LEADER_WAIT_MS = 250;
const MAX_PUSH_DELAY_MS = 10_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A WAL entry this old belongs to a tab that died before logging it. */
const WAL_STALE_MS = 2 * 60_000;
/** Ops of another user, waiting for them to sign in here again. */
const OTHER_OWNER_TTL_MS = 30 * 24 * 3600 * 1000;
/** Record times further ahead than this are a broken clock: not
 *  followed. */
const MAX_FUTURE_MS = 24 * 3600 * 1000;
/** Applies of one shard that fail before it is taken as seen anyway (a
 *  record that can never be stored must not cost a download a minute). */
const MAX_APPLY_ATTEMPTS = 3;

const WAL_PREFIX = "__runapps_sync_wal:";
const SEQ_KEY = "__runapps_sync_seq";
const CLOCK_KEY = "__runapps_sync_clock";

/** Hybrid logical clock: wall time with the server's offset, never
 *  going backwards, and later than every write it has seen. */
class Clock {
  last = 0;
  offset = 0;
  onOffset: ((offset: number) => void) | null = null;
  wall(): number {
    return Date.now() + this.offset;
  }
  now(): number {
    const t = this.wall();
    this.last = t > this.last ? t : this.last + 0.001;
    return this.last;
  }
  /** A write time seen in the cloud: the next local write is later. */
  witness(t: number): void {
    if (t > this.last && t < this.wall() + MAX_FUTURE_MS) this.last = t;
  }
  observe(serverTime: number, localBefore: number, localAfter: number): void {
    const off = serverTime - (localBefore + localAfter) / 2;
    if (Math.abs(off - this.offset) > 2000) {
      this.offset = off;
      this.onOffset?.(off);
    }
  }
}

class MemoryStorage implements KVStorage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

function defaultStorage(): KVStorage {
  try {
    const ls = typeof window !== "undefined" ? (window as { localStorage?: Storage }).localStorage : undefined;
    if (ls) {
      ls.setItem("__runapps_probe", "1");
      ls.removeItem("__runapps_probe");
      return ls;
    }
  } catch {
    /* blocked storage: per-tab memory */
  }
  return new MemoryStorage();
}

class UserChangedError extends Error {
  constructor() {
    super("the signed-in user changed");
  }
}

function pathSeg(s: string): string {
  return encodeURIComponent(s);
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}

function emptyShard(): Shard {
  return { v: 1, cleared: 0, r: {} };
}

function toShard(value: unknown): Shard {
  const s = value as Partial<Shard> | null;
  const r = s && typeof s.r === "object" && s.r !== null && !Array.isArray(s.r) ? s.r : {};
  return { v: 1, cleared: typeof s?.cleared === "number" ? s.cleared : 0, r };
}

function validRec(rec: unknown): rec is ShardRecord {
  return rec !== null && typeof rec === "object" && typeof (rec as ShardRecord).t === "number" && "k" in (rec as object);
}

function toJournal(value: unknown): Journal | null {
  const j = value as Journal | null;
  if (!j || j.v !== 1 || typeof j.t !== "number" || typeof j.s !== "object" || j.s === null) return null;
  for (const part of Object.values(j.s)) {
    if (!part || !Array.isArray(part.n) || !Array.isArray(part.o)) return null;
  }
  return j;
}

function recHash(rec: ShardRecord): number {
  return hash32(JSON.stringify(rec));
}

/** Whether a cloud record is newer than the version this device holds. */
function newer(rec: ShardRecord, a: AppliedEntry | undefined): boolean {
  if (!a) return true;
  return rec.t > a.t || (rec.t === a.t && a.h !== recHash(rec));
}

/** An encode failure that will never succeed (the value), as opposed
 *  to the network failing while a Blob is uploaded. */
function permanentEncodeError(e: unknown): boolean {
  if (e instanceof TypeError || e instanceof RangeError) return e.message.startsWith("runapps sync:");
  const name = (e as { name?: string } | null)?.name;
  return name === "NotReadableError" || name === "NotFoundError" || name === "DataCloneError";
}

export class SyncEngine {
  readonly options: Required<SyncOptions>;
  private readonly log: SyncLog;
  private readonly hook: InstalledHook | null;
  private readonly clock = new Clock();
  private readonly storage: KVStorage;
  private readonly tabId = randomId();
  private readonly schemas = new Map<string, Map<string, StoreSchema>>();
  /** Shard ETags this device has applied. */
  private readonly etags = new Map<string, string>();
  /** The last copy of a shard this engine read or wrote, with its etag:
   *  the next write merges into it and sends If-Match, and only a 412
   *  (someone else wrote in between) costs a read. Oldest first. */
  private readonly shardCache = new Map<string, { etag: string; shard: Shard }>();
  /** Journals read (they never change), by path. */
  private readonly journalCache = new Map<string, Journal>();
  /** Every shard path the last listing showed, and the prefixes that
   *  listing covered: a path under a covered prefix that isn't listed
   *  does not exist, and is created with If-None-Match, unread. */
  private readonly listedPaths = new Set<string>();
  private readonly listedPrefixes = new Set<string>();
  /** Databases this device has pulled at least once (writes made before
   *  are weak, see LoggedOp.weak). */
  private readonly pulled = new Set<string>();
  /** Failed applies per shard path (see MAX_APPLY_ATTEMPTS). */
  private readonly applyFailures = new Map<string, number>();
  private readonly conns = new Map<string, Promise<IDBDatabase | null>>();
  /** This tab's WAL, by commit. */
  private readonly walBatches = new Map<number, WalEntry[]>();
  private walNext = 0;
  private state: SyncState = { state: "off", pending: 0 };
  private paused = false;
  private disposed = false;
  private leader = true;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushDeadline = 0;
  /** The page is going away (pagehide): writes ask to outlive it. */
  private leaving = false;
  /** Databases the app opened in this page — the ones a scan for
   *  records sync has never seen may open. */
  private readonly openedHere = new Set<string>();
  /** Called when this tab is granted the sync lock. */
  private leaderWaiters: (() => void)[] = [];
  /** Followers waiting for the leader to pull a database for them. */
  private readonly pullWaiters = new Map<string, () => void>();
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 0;
  private backoffUntil = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly cleanup: (() => void)[] = [];
  private channel: BroadcastChannel | null = null;
  private metaLoaded: Promise<void> | null = null;
  /** Ops of other users in the log (not counted as pending). */
  private foreign = 0;
  /** Set while a sync cycle pushes or applies something. */
  private moved = false;
  /** Set when an apply logged records the cloud did not have. */
  private adoptedAny = false;
  private pendingCache: { seq: string | null; ops: LoggedOp[] } | null = null;
  private readyResolve: () => void = () => {};
  private readonly readyPromise = new Promise<void>((r) => (this.readyResolve = r));

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
      journalFoldAfterMs: options.journalFoldAfterMs ?? 2 * 60_000,
      journalKeepMs: options.journalKeepMs ?? 3600_000,
    };
    this.storage = deps.storage ?? defaultStorage();
    const savedClock = Number(this.safeGet(CLOCK_KEY));
    if (savedClock > 0) this.clock.last = savedClock;
    this.clock.onOffset = (off) => void this.log.setMeta({ "clock:offset": off }).catch(() => {});

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
    this.cleanup.push(deps.onAuthChange(() => void this.schedule("auth")));
    void this.refreshPending();
    void this.schedule("start");
  }

  // ── Public surface ───────────────────────────────────────────────

  status(): SyncState {
    return { ...this.state };
  }

  /** Resolves once the first sync has run (or there is nobody to sync
   *  for). */
  ready(): Promise<void> {
    return this.readyPromise;
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
    for (const p of this.conns.values()) p.then((db) => db?.close()).catch(() => {});
    this.conns.clear();
    this.log.close();
    this.hook?.uninstall();
    for (const w of this.pullWaiters.values()) w();
    this.pullWaiters.clear();
  }

  /** Send to the other tabs of this origin. */
  private post(msg: unknown): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* channel closed, or keys that cannot be cloned */
    }
  }

  // ── Shared storage: WAL, change counter, clock ───────────────────

  private safeGet(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  private readSeq(): string | null {
    return this.safeGet(SEQ_KEY);
  }

  private bumpSeq(): void {
    try {
      this.storage.setItem(SEQ_KEY, String((Number(this.storage.getItem(SEQ_KEY)) || 0) + 1));
    } catch {
      /* storage unavailable */
    }
  }

  private writeWal(): void {
    const key = WAL_PREFIX + this.tabId;
    const all = [...this.walBatches.values()].flat();
    try {
      this.storage.setItem(CLOCK_KEY, String(this.clock.last));
      if (all.length === 0) {
        this.storage.removeItem(key);
        return;
      }
      try {
        this.storage.setItem(key, JSON.stringify(all));
      } catch {
        // Too big for the quota: one entry per database, "some records
        // changed" — still enough to keep an apply off them.
        const byDb = new Map<string, WalEntry>();
        for (const e of all) {
          const cur = byDb.get(e[0]);
          if (!cur || e[3] > cur[3]) byDb.set(e[0], [e[0], "*", "?", e[3], e[4], e[5]]);
        }
        this.storage.setItem(key, JSON.stringify([...byDb.values()]));
      }
    } catch {
      /* storage unavailable: the log is the only record */
    }
  }

  /** Every tab's WAL entries, by storage key. */
  private readWal(): Map<string, WalEntry[]> {
    const out = new Map<string, WalEntry[]>();
    try {
      const keys: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k && k.startsWith(WAL_PREFIX)) keys.push(k);
      }
      for (const k of keys) {
        try {
          const v = JSON.parse(this.storage.getItem(k) ?? "[]") as WalEntry[];
          if (Array.isArray(v)) out.set(k, v);
        } catch {
          /* unreadable entry */
        }
      }
    } catch {
      /* storage unavailable */
    }
    return out;
  }

  // ── Hook callbacks ───────────────────────────────────────────────

  private onCommit(db: string, ops: CommittedOp[]): void {
    const owner = this.deps.userId();
    const logged: LoggedOp[] = [];
    const localClears: string[] = [];
    // One time for the transaction; a clear starts a new one, so what
    // the transaction writes after it is newer than the clear.
    let ts = this.clock.now();
    for (const op of ops) {
      if (op.kind === "clear") {
        // Signed out, a clear is the app emptying its local copy (an app
        // clearing its data on sign-out): it must not empty the cloud.
        if (owner === null) localClears.push(op.store);
        else logged.push({ db, store: op.store, kind: "clear", kid: "", ts, owner });
        ts = this.clock.now();
      } else if (op.kind === "del") {
        logged.push({ db, store: op.store, kind: "del", kid: keyId(op.key), key: encodeKey(op.key), ts, owner });
      } else {
        logged.push({
          db,
          store: op.store,
          kind: "put",
          kid: keyId(op.key),
          key: encodeKey(op.key),
          value: op.value,
          changed: op.prior === undefined ? undefined : changedFields(op.prior, op.value),
          ts,
          owner,
        });
      }
    }
    const wall = Date.now();
    const batch = ++this.walNext;
    this.walBatches.set(
      batch,
      logged.map((op): WalEntry => [db, op.store, op.kind === "clear" ? "*" : op.kid, op.ts, wall, owner]),
    );
    this.writeWal();
    this.bumpSeq();
    this.enqueueLog(logged, batch, localClears.length ? () => this.forgetLocal(db, localClears) : undefined);
    // The other tabs share this database but get no event from it:
    // tell them what changed so their views can re-read.
    const byStore = new Map<string, { keys: IDBValidKey[]; cleared: boolean }>();
    for (const op of ops) {
      let e = byStore.get(op.store);
      if (!e) byStore.set(op.store, (e = { keys: [], cleared: false }));
      if (op.kind === "clear") {
        e.cleared = true;
        e.keys = [];
      } else if (!e.cleared) {
        e.keys.push(op.key);
      }
    }
    for (const [store, e] of byStore) {
      const change: DbChange = { db, store, keys: e.keys, cleared: e.cleared, source: "tab" };
      this.post({ type: "db:change", change });
    }
  }

  private logChain: Promise<void> = Promise.resolve();
  private enqueueLog(ops: LoggedOp[], walBatch?: number, before?: () => Promise<void>): void {
    this.logChain = this.logChain
      .then(async () => {
        if (before) await before();
        await this.markWeak(ops);
        await this.log.append(ops);
        this.pendingCache = null;
        if (walBatch !== undefined) {
          this.walBatches.delete(walBatch);
          this.writeWal();
          this.bumpSeq();
        }
        await this.refreshPending();
        if (!this.leader) this.post({ type: "sync:request" });
      })
      .catch((err) => this.fail(err));
    this.schedulePush();
  }

  /** Ops written before this device ever pulled their database lose to
   *  the cloud's copy (an app writing its defaults on a new device). */
  private async markWeak(ops: LoggedOp[]): Promise<void> {
    const seen = new Map<string, boolean>();
    for (const op of ops) {
      if (op.ts === ADOPTED_TS) continue;
      let p = seen.get(op.db);
      if (p === undefined) seen.set(op.db, (p = await this.isPulled(op.db)));
      if (!p) op.weak = true;
    }
  }

  private async isPulled(db: string): Promise<boolean> {
    if (this.pulled.has(db)) return true;
    try {
      if (await this.log.getMeta("pulled:" + db)) {
        this.pulled.add(db);
        return true;
      }
      // Pulled by an SDK that did not record it: it left shard ETags.
      const legacy = await this.log.metaWithPrefix(`etag:${this.dbPrefix(db)}`);
      return legacy.size > 0;
    } catch {
      return false;
    }
  }

  /** The app emptied stores while nobody was signed in: forget what this
   *  device held of them, so the next pull fills them again. */
  private async forgetLocal(db: string, stores: string[]): Promise<void> {
    for (const store of stores) {
      const prefix = `${this.dbPrefix(db)}${pathSeg(store)}/`;
      for (const p of [...this.etags.keys()]) if (p.startsWith(prefix)) this.etags.delete(p);
      await this.log.forgetApplied(db, store, prefix);
      // What an SDK before 0.20 recorded too, or the next pull would take
      // the emptied store as up to date.
      await this.log.deleteMetaWithPrefix("etag:" + prefix);
    }
    this.pulled.delete(db);
    await this.log.setMeta({ ["pulled:" + db]: undefined });
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
    this.openedHere.add(name);
    await this.log.setMeta({ ["schema:" + name]: Object.fromEntries(schema) }).catch(() => {});
    if (!this.deps.userId() || this.paused) return;
    // Right after the page loads the sync lock is still being asked for:
    // wait a moment for it, or the app's first read goes ahead without
    // the pull (and, after a change of user, with the last user's rows).
    // When another tab holds it, that tab pulls for this one.
    if (!this.leader && !(await this.becomesLeader(LEADER_WAIT_MS))) {
      await this.askLeaderToPull(name);
      return;
    }
    await this.pullOne(name).catch(() => {});
  }

  /** Pull one database now (an open waits for it). */
  private pullOne(name: string): Promise<void> {
    return this.enqueue(async () => {
      const userId = this.deps.userId();
      if (!userId || this.paused || this.disposed) return;
      const check = this.checker(userId);
      await this.loadMeta();
      await this.reloadSchemas();
      await this.recoverWal();
      // Another user's rows must be gone before the app's first read,
      // not only after the first full sync.
      await this.ensureOwner(userId);
      const errors: unknown[] = [];
      await this.pullDbs(name, check, errors);
      if (errors.length) throw errors[0];
    });
  }

  private askLeaderToPull(name: string): Promise<void> {
    if (!this.channel) return Promise.resolve();
    const id = randomId();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pullWaiters.delete(id);
        resolve();
      }, this.options.openTimeoutMs);
      this.pullWaiters.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      this.post({ type: "pull", db: name, id });
    });
  }

  private onDeleteDatabase(name: string): void {
    const schema = this.schemas.get(name);
    const stores = schema ? Array.from(schema.keys()) : [];
    this.schemas.delete(name);
    this.conns.get(name)?.then((db) => db?.close()).catch(() => {});
    this.conns.delete(name);
    const owner = this.deps.userId();
    const ts = this.clock.now();
    const forget = async () => {
      const prefix = this.dbPrefix(name);
      for (const p of [...this.etags.keys()]) if (p.startsWith(prefix)) this.etags.delete(p);
      for (const p of [...this.shardCache.keys()]) if (p.startsWith(prefix)) this.shardCache.delete(p);
      await this.log.deleteMetaWithPrefix("etag:" + prefix, `adopted:${name}/`);
      await this.log.setMeta({ ["schema:" + name]: undefined });
      await this.log.forgetApplied(name, undefined, prefix);
      // Signed out the delete stays local, and the next pull brings the
      // data back; signed in it deletes the cloud copy too (dbclear).
      if (owner === null) {
        this.pulled.delete(name);
        await this.log.setMeta({ ["pulled:" + name]: undefined });
      }
    };
    if (owner === null) {
      this.logChain = this.logChain.then(forget).catch((err) => this.fail(err));
      return;
    }
    const op: LoggedOp = { db: name, store: "", kind: "dbclear", kid: "", value: stores, ts, owner };
    const batch = ++this.walNext;
    this.walBatches.set(batch, [[name, "*", "*", ts, Date.now(), owner]]);
    this.writeWal();
    this.bumpSeq();
    this.enqueueLog([op], batch, forget);
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
    // Leaving: push now instead of after the gathering delay, so a user
    // who edits and switches away or closes the tab has their change on
    // the server, not only in this device's log until the app is opened
    // here again. Hidden pages are alive (tab switch, phone home button):
    // an ordinary push. pagehide is the page going away: writes ask to
    // outlive it (keepalive); one the browser drops stays in the log.
    on(window, "pagehide", () => this.flush(true));
    on(window, "pageshow", () => {
      this.leaving = false;
    });
    if (typeof document !== "undefined") {
      on(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.leaving = false;
          void this.schedule("visible");
        } else {
          this.flush(false);
        }
        this.updatePullTimer();
      });
    }
    this.updatePullTimer();
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel("__runapps_db_change__");
      this.channel.onmessage = (ev) => {
        const d = ev.data as
          | (DbChange & { type?: undefined })
          | { type: "sync:state"; state: SyncState }
          | { type: "sync:request" }
          | { type: "db:change"; change: DbChange }
          | { type: "pull"; db: string; id: string }
          | { type: "pulled"; id: string }
          | undefined;
        if (!d) return;
        if (d.type === "db:change") {
          this.deps.events.emit("db:change", d.change);
        } else if (d.type === "sync:state") {
          // The leader's state is the origin's state; a follower shows it.
          if (!this.leader) {
            this.state = { ...d.state };
            this.deps.events.emit("sync:state", { ...d.state });
            if (d.state.state !== "syncing") this.readyResolve();
          }
        } else if (d.type === "sync:request") {
          // A follower wrote to the log, or wants a sync now: go, and
          // tell it where things stand either way.
          if (this.leader) {
            this.post({ type: "sync:state", state: { ...this.state } });
            void this.schedule("peer");
          }
        } else if (d.type === "pull") {
          // A follower opened a database: pull it before its first read.
          if (this.leader) {
            const id = d.id;
            void this.pullOne(d.db)
              .catch(() => {})
              .then(() => this.post({ type: "pulled", id }));
          }
        } else if (d.type === "pulled") {
          const w = this.pullWaiters.get(d.id);
          if (w) {
            this.pullWaiters.delete(d.id);
            w();
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
          this.becameLeader();
          void this.schedule("leader");
          return new Promise<void>(() => {}); // hold until the tab dies
        })
        .catch(() => {
          this.becameLeader();
        });
    }
  }

  private becameLeader(): void {
    this.leader = true;
    for (const w of this.leaderWaiters.splice(0)) w();
  }

  /** Resolves true once this tab holds the sync lock, false after `ms`. */
  private becomesLeader(ms: number): Promise<boolean> {
    if (this.leader) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.leaderWaiters = this.leaderWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, ms);
      this.leaderWaiters.push(waiter);
    });
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

  /** Push what is waiting now (the page is being hidden or left). */
  private flush(leaving: boolean): void {
    if (this.disposed) return;
    if (leaving) this.leaving = true;
    if (!this.pushTimer && !this.state.pending) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.pushDeadline = 0;
    if (!this.leader) {
      this.post({ type: "sync:request" });
      return;
    }
    void this.schedule(leaving ? "pagehide" : "hidden");
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

  private setState(patch: Partial<SyncState>): void {
    const next = { ...this.state, ...patch };
    if (patch.state && patch.state !== "error" && patch.state !== "offline") delete next.error;
    if (!next.failed) delete next.failed;
    const changed =
      next.state !== this.state.state ||
      next.pending !== this.state.pending ||
      next.failed !== this.state.failed ||
      next.lastSyncedAt !== this.state.lastSyncedAt ||
      next.lastChangeAt !== this.state.lastChangeAt ||
      next.error !== this.state.error;
    this.state = next;
    if (patch.state && patch.state !== "syncing") this.readyResolve();
    if (changed) {
      this.deps.events.emit("sync:state", { ...next });
      if (this.leader) this.post({ type: "sync:state", state: { ...next } });
    }
  }

  private async refreshPending(): Promise<void> {
    try {
      const n = await this.log.pendingCount();
      const failed = await this.log.deadCount();
      this.setState({ pending: Math.max(0, n - this.foreign), failed });
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

  // ── Meta, owner, recovery ────────────────────────────────────────

  private dbPrefix(db: string): string {
    return `${this.options.prefix}/${pathSeg(db)}/`;
  }

  private journalPrefix(db: string): string {
    return `${this.options.prefix}/@j/${pathSeg(db)}/`;
  }

  private shardPath(db: string, store: string, shard: number): string {
    return `${this.dbPrefix(db)}${pathSeg(store)}/${shard}.json`;
  }

  /** db, store and shard of a shard path; null for anything else. */
  private parseShardPath(path: string): { db: string; store: string; n: number } | null {
    const p = this.options.prefix + "/";
    if (!path.startsWith(p)) return null;
    const m = /^([^/@][^/]*)\/([^/]+)\/(\d+)\.json$/.exec(path.slice(p.length));
    if (!m) return null;
    try {
      return { db: decodeURIComponent(m[1]!), store: decodeURIComponent(m[2]!), n: Number(m[3]) };
    } catch {
      return null;
    }
  }

  private parseJournalPath(path: string): { db: string } | null {
    const p = this.options.prefix + "/@j/";
    if (!path.startsWith(p)) return null;
    const m = /^([^/]+)\/[^/]+\.json$/.exec(path.slice(p.length));
    if (!m) return null;
    try {
      return { db: decodeURIComponent(m[1]!) };
    } catch {
      return null;
    }
  }

  private async loadMeta(): Promise<void> {
    if (!this.metaLoaded) {
      this.metaLoaded = (async () => {
        for (const [path, etag] of await this.log.marks()) this.etags.set(path, etag);
        for (const k of (await this.log.metaWithPrefix("pulled:")).keys()) this.pulled.add(k.slice(7));
        const off = await this.log.getMeta<number>("clock:offset");
        if (typeof off === "number") this.clock.offset = off;
        await this.reloadSchemas();
      })();
      this.metaLoaded.catch(() => {
        this.metaLoaded = null;
      });
    }
    return this.metaLoaded;
  }

  /** Shard ETags an SDK before 0.20 applied (whole shards, without
   *  recording records). A shard still at that version is recorded from
   *  its content, without writing anything here. An older SDK still open
   *  in another tab keeps writing these. */
  private async legacyEtags(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [k, v] of await this.log.metaWithPrefix("etag:")) out.set(k.slice(5), v as string);
    return out;
  }

  /** Schemas as the tabs last saw them (a follower may have opened a
   *  database this tab never did). */
  private async reloadSchemas(): Promise<void> {
    for (const [k, v] of await this.log.metaWithPrefix("schema:")) {
      const name = k.slice(7);
      if (this.openedHere.has(name) && this.schemas.has(name)) continue;
      this.schemas.set(name, new Map(Object.entries(v as Record<string, StoreSchema>)));
    }
  }

  private checker(userId: string): () => void {
    return () => {
      if (this.deps.userId() !== userId) throw new UserChangedError();
    };
  }

  /** The local copy belongs to one user. Another user signing in on the
   *  same browser starts from the server's copy, never from theirs; the
   *  first user's unsent changes stay in the log, for when they sign in
   *  here again. */
  private async ensureOwner(userId: string): Promise<void> {
    const owner = await this.log.getMeta<string>("owner");
    const stateOwner = await this.log.stateOwner();
    if (owner === userId && stateOwner === userId) return;
    if (owner !== undefined && owner !== userId) {
      // Writes made signed out were made on the first user's data.
      await this.log.reassignOwner((o) => o == null, owner);
      for (const [db, schema] of this.schemas) {
        const stores = [...schema.keys()].filter((s) => !this.storeExcluded(db, s));
        if (stores.length === 0) continue;
        // A failure here stops the sync: the next user must not see these.
        const h = await this.conn(db);
        if (!h) continue;
        const present = stores.filter((s) => h.objectStoreNames.contains(s));
        if (present.length === 0) continue;
        const tx = h.transaction(present, "readwrite");
        for (const s of present) tx.objectStore(s).clear();
        await idbDone(tx);
        for (const store of present) this.emitChange({ db, store, keys: [], cleared: true, source: "remote" });
      }
      const schemas: Record<string, unknown> = {};
      for (const [db, schema] of this.schemas) schemas["schema:" + db] = Object.fromEntries(schema);
      await this.log.resetForOwner(userId);
      await this.log.setMeta({ ...schemas, "clock:offset": this.clock.offset });
      this.pulled.clear();
      this.journalCache.clear();
      this.listedPaths.clear();
      this.listedPrefixes.clear();
    } else if (stateOwner !== userId) {
      // First run of this SDK on the device, or an older SDK in another
      // tab handled a change of user (and emptied the stores): what is
      // held is not known yet.
      await this.log.resetState(userId);
    }
    this.etags.clear();
    this.shardCache.clear();
    this.applyFailures.clear();
    this.pendingCache = null;
    await this.log.setMeta({ owner: userId });
  }

  /** Writes whose logging never finished (their tab closed between the
   *  commit and the log write): log them again from the database. */
  private async recoverWal(): Promise<void> {
    const now = Date.now();
    const ownKey = WAL_PREFIX + this.tabId;
    const stale: WalEntry[] = [];
    const staleKeys: string[] = [];
    for (const [k, entries] of this.readWal()) {
      if (k === ownKey) continue;
      if (entries.every((e) => now - e[4] > WAL_STALE_MS)) {
        stale.push(...entries);
        staleKeys.push(k);
      }
    }
    if (stale.length === 0) return;
    const pending = await this.log.pending();
    const logged = new Map<string, number>();
    for (const op of pending) {
      const k = op.db + "\u0000" + op.store + "\u0000" + op.kid;
      logged.set(k, Math.max(logged.get(k) ?? 0, op.ts));
    }
    const ops: LoggedOp[] = [];
    for (const [db, store, kid, ts, , owner] of stale) {
      if (kid === "?") {
        console.warn("[runapps sync] some changes made just before a tab closed could not be recovered", db);
        continue;
      }
      if (store === "*") {
        if ((logged.get(db + "\u0000\u0000") ?? 0) < ts) ops.push({ db, store: "", kind: "dbclear", kid: "", value: [], ts, owner });
        continue;
      }
      if (kid === "*") {
        if ((logged.get(db + "\u0000" + store + "\u0000") ?? 0) < ts) ops.push({ db, store, kind: "clear", kid: "", ts, owner });
        continue;
      }
      if ((logged.get(db + "\u0000" + store + "\u0000" + kid) ?? 0) >= ts) continue;
      let key: IDBValidKey;
      try {
        key = decodeKey(JSON.parse(kid));
      } catch {
        continue;
      }
      let value: unknown;
      let found = false;
      const ok = await this.withStore(db, store, "readonly", (st) => {
        const r = st.get(key);
        r.onsuccess = () => {
          value = r.result;
          found = r.result !== undefined;
        };
      }).catch(() => false);
      if (!ok) continue;
      ops.push(
        found
          ? { db, store, kind: "put", kid, key: encodeKey(key), value, ts, owner }
          : { db, store, kind: "del", kid, key: encodeKey(key), ts, owner },
      );
    }
    if (ops.length) {
      await this.markWeak(ops);
      await this.log.append(ops);
      this.pendingCache = null;
    }
    for (const k of staleKeys) {
      try {
        this.storage.removeItem(k);
      } catch {
        /* storage unavailable */
      }
    }
    this.bumpSeq();
  }

  // ── Sync ─────────────────────────────────────────────────────────

  private async sync(): Promise<void> {
    if (this.disposed || this.paused || !this.leader) return;
    const userId = this.deps.userId();
    if (!userId) {
      this.setState({ state: "off" });
      return;
    }
    const check = this.checker(userId);
    this.setState({ state: "syncing" });
    this.moved = false;
    this.adoptedAny = false;
    const errors: unknown[] = [];
    const keep = (e: unknown) => {
      if (e instanceof UserChangedError) throw e;
      errors.push(e);
    };
    try {
      await this.loadMeta();
      await this.reloadSchemas();
      await this.logChain;
      await this.recoverWal();
      await this.ensureOwner(userId);
      // Pull first: what this device holds is known before its writes
      // go up (local writes waiting to go up are not overwritten), and a
      // push that fails (no balance, a network error) does not keep the
      // other devices' changes from arriving. A push applies here what
      // it merged with, so no second pull is needed.
      await this.pullDbs(null, check, errors).catch(keep);
      await this.push(userId, check).catch(keep);
      await this.adoptScan(check).catch(keep);
      if (this.adoptedAny) await this.push(userId, check).catch(keep);
      await this.refreshPending();
      if (errors.length) throw errors[0];
      this.backoffMs = 0;
      this.backoffUntil = 0;
      const now = Date.now();
      this.setState({ state: "idle", lastSyncedAt: now, ...(this.moved ? { lastChangeAt: now } : {}) });
    } catch (err) {
      await this.refreshPending();
      if (err instanceof UserChangedError) {
        // Not a failure: sync again, for the new user.
        this.setState({ state: "idle" });
        queueMicrotask(() => void this.schedule("auth"));
        return;
      }
      this.fail(err);
    }
  }

  private storeExcluded(db: string, store: string): boolean {
    return this.options.exclude.includes(db + "/" + store) || this.options.exclude.includes(db);
  }

  private shardOf(kid: string): number {
    return hash32(kid) % this.options.shards;
  }

  private async readShard(path: string): Promise<{ shard: Shard; etag?: string }> {
    const before = Date.now();
    const r = await this.deps.remote.getJSON(path);
    if (r.status !== "corrupt" && r.serverTime) this.clock.observe(r.serverTime, before, Date.now());
    if (r.status === "ok") return { shard: toShard(r.value), etag: r.etag };
    // An unreadable file is replaced (If-Match on its ETag).
    if (r.status === "corrupt") return { shard: emptyShard(), etag: r.etag || undefined };
    return { shard: emptyShard() };
  }

  // ── Push ─────────────────────────────────────────────────────────

  private async push(userId: string, check: () => void): Promise<void> {
    const all = await this.log.pending();
    const wall = this.clock.wall();
    const stale = all.filter((op) => op.owner != null && op.owner !== userId && wall - op.ts > OTHER_OWNER_TTL_MS);
    if (stale.length) await this.log.remove(stale.map((op) => op.id!).filter((id) => id !== undefined));
    const mine = all.filter((op) => op.owner == null || op.owner === userId);
    this.foreign = all.length - mine.length - stale.length;
    if (mine.length === 0) return;
    const byDb = new Map<string, LoggedOp[]>();
    for (const op of mine) {
      let g = byDb.get(op.db);
      if (!g) byDb.set(op.db, (g = []));
      g.push(op);
    }
    const errors: unknown[] = [];
    for (const [db, ops] of byDb) {
      try {
        await this.pushDb(db, ops, check);
      } catch (e) {
        if (e instanceof UserChangedError) throw e;
        errors.push(e);
      }
    }
    if (errors.length) throw errors[0];
  }

  private async pushDb(db: string, ops: LoggedOp[], check: () => void): Promise<void> {
    const idsOf = (list: LoggedOp[]) => list.map((op) => op.id).filter((id): id is number => id !== undefined);
    const settling = new Set(idsOf(ops));
    // Ops leave the log as soon as the shard holding them is written, so
    // `pending` counts down while a long push runs, and a push cut short
    // keeps only what really is still unsent.
    const settle = async (ids: number[]) => {
      if (ids.length === 0) return;
      await this.log.remove(ids);
      this.pendingCache = null;
      this.moved = true;
      await this.refreshPending();
    };
    // A deleted database clears every store it had: the ones it was
    // known to have and the ones the cloud holds.
    const expanded: LoggedOp[] = [];
    for (const op of ops) {
      if (op.kind !== "dbclear") {
        expanded.push(op);
        continue;
      }
      const stores = new Set<string>(Array.isArray(op.value) ? (op.value as string[]) : []);
      for (const s of this.schemas.get(db)?.keys() ?? []) stores.add(s);
      for (const e of await this.deps.remote.list(this.dbPrefix(db))) {
        const p = this.parseShardPath(e.path);
        if (p && p.db === db) stores.add(p.store);
      }
      for (const store of stores) expanded.push({ ...op, store, kind: "clear" });
    }
    const groups = new Map<string, LoggedOp[]>();
    for (const op of expanded) {
      let g = groups.get(op.store);
      if (!g) groups.set(op.store, (g = []));
      g.push(op);
    }

    interface Write {
      store: string;
      n: number;
      cleared: number;
      ops: ShardOp[];
      ids: number[];
    }
    const writes: Write[] = [];
    const buried: { op: LoggedOp; error: string }[] = [];
    const afterStore = new Map<string, number[]>();
    const dropNow: number[] = [];
    for (const [store, g] of groups) {
      if (this.storeExcluded(db, store)) {
        dropNow.push(...idsOf(g));
        continue;
      }
      // A clear drops everything written before it; ops after the last
      // clear are the ones that still matter.
      let clearedAt = 0;
      let lastClear = -1;
      g.forEach((op, i) => {
        if (op.kind === "clear") {
          clearedAt = Math.max(clearedAt, op.weak ? ADOPTED_TS : op.ts);
          lastClear = i;
        }
      });
      const byShard = new Map<number, { ops: ShardOp[]; ids: number[] }>();
      for (const op of g.slice(lastClear + 1)) {
        let so: ShardOp;
        try {
          so = await this.encodeOp(op);
        } catch (e) {
          if (!permanentEncodeError(e)) throw e;
          buried.push({ op, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        const n = this.shardOf(op.kid);
        let w = byShard.get(n);
        if (!w) byShard.set(n, (w = { ops: [], ids: [] }));
        w.ops.push(so);
        if (op.id !== undefined) w.ids.push(op.id);
      }
      const shards = clearedAt > 0 ? Array.from({ length: this.options.shards }, (_, i) => i) : Array.from(byShard.keys());
      for (const n of shards) {
        const w = byShard.get(n);
        writes.push({ store, n, cleared: clearedAt, ops: w?.ops ?? [], ids: w?.ids ?? [] });
      }
      // The clear itself, and what it superseded, once every shard is.
      afterStore.set(store, idsOf(g.slice(0, lastClear + 1)));
    }
    if (buried.length) {
      for (const b of buried) console.warn(`[runapps sync] a change to ${b.op.db}/${b.op.store} cannot be synced and was set aside:`, b.error);
      await this.log.bury(buried);
      this.pendingCache = null;
    }
    await settle(dropNow);
    if (writes.length === 0) {
      for (const ids of afterStore.values()) await settle(ids);
      return;
    }

    // Several files: the journal first, so no reader sees the push in part.
    let journal: { path: string; j: Journal } | null = null;
    if (writes.length > 1) {
      const id = `${Math.floor(this.clock.wall())}-${randomId()}`;
      const j: Journal = { v: 1, id, db, t: this.clock.now(), s: {} };
      for (const w of writes) {
        let part = j.s[w.store];
        if (!part) j.s[w.store] = part = { n: [], o: [] };
        if (w.cleared) part.c = w.cleared;
        part.n.push(w.n);
        for (const so of w.ops) part.o.push(so.changed ? [so.kid, so.rec, so.changed] : [so.kid, so.rec]);
      }
      const path = `${this.journalPrefix(db)}${id}.json`;
      check();
      const r = await this.deps.remote.putJSON(path, j, { ifNoneMatch: true }, this.leaving ? { keepalive: true } : undefined);
      if (r.status !== "ok") throw new Error(`could not write ${path}`);
      this.journalCache.set(path, j);
      journal = { path, j };
    }

    const limit = limiter(PUSH_CONCURRENCY);
    const storeLeft = new Map<string, number>();
    for (const w of writes) storeLeft.set(w.store, (storeLeft.get(w.store) ?? 0) + 1);
    const results = await Promise.allSettled(
      writes.map((w) =>
        limit(async () => {
          const path = this.shardPath(db, w.store, w.n);
          const res = await this.writeShard(path, w.cleared, w.ops, check);
          const own = new Map(w.ops.map((so) => [so.kid, so.rec] as const));
          await this.applyWritten(db, w.store, w.n, res, settling, own, check);
          await settle(w.ids);
          const left = storeLeft.get(w.store)! - 1;
          storeLeft.set(w.store, left);
          if (left === 0) await settle(afterStore.get(w.store) ?? []);
        }),
      ),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    if (journal) await this.log.setMeta({ ["jv:" + journal.path]: Date.now() });
  }

  private async encodeOp(op: LoggedOp): Promise<ShardOp> {
    const t = op.weak ? ADOPTED_TS : op.ts;
    if (op.kind === "del") return { kid: op.kid, rec: { k: op.key, v: null, t, d: 1 } };
    const v = await encodeValue(op.value, (blob) => this.storeBlob(blob));
    return { kid: op.kid, rec: { k: op.key, v, t }, changed: op.changed };
  }

  /** Merge ops into one shard and write it; retried on a 412. The first
   *  try starts from the cached copy, or from nothing when the last
   *  listing showed no such shard — no read either way. Returns the
   *  shard as it now is, and its ETag (none when there is no file). */
  private async writeShard(path: string, clearedAt: number, ops: ShardOp[], check?: () => void): Promise<{ etag?: string; shard: Shard }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cached = attempt === 0 ? this.shardCache.get(path) : undefined;
      const base: { shard: Shard; etag?: string } = cached
        ? { shard: copyShard(cached.shard), etag: cached.etag }
        : attempt === 0 && this.knownAbsent(path)
          ? { shard: emptyShard() }
          : await this.readShard(path);
      const shard = base.shard;
      const before = JSON.stringify(shard);
      mergeInto(shard, clearedAt, ops);
      if (JSON.stringify(shard) === before) {
        // Nothing to change (already folded, or every op lost to a newer
        // write or a clear): no write.
        if (base.etag || (Object.keys(shard.r).length === 0 && !shard.cleared)) return { etag: base.etag, shard };
      }
      // Tombstones only matter until every device has seen them.
      const now = this.clock.wall();
      for (const kid of Object.keys(shard.r)) {
        const rec = shard.r[kid]!;
        if (rec.d && now - rec.t > TOMBSTONE_TTL_MS) delete shard.r[kid];
      }
      check?.();
      const t0 = Date.now();
      const r = await this.deps.remote.putJSON(path, shard, base.etag ? { ifMatch: base.etag } : { ifNoneMatch: true }, this.leaving ? { keepalive: true } : undefined);
      if (r.status === "ok") {
        if (r.serverTime) this.clock.observe(r.serverTime, t0, Date.now());
        this.cacheShard(path, r.etag, shard);
        this.listedPaths.add(path);
        return { etag: r.etag, shard };
      }
      this.shardCache.delete(path);
      this.listedPaths.add(path); // it exists after all
    }
    throw new Error(`could not write ${path}: too many concurrent writers`);
  }

  /** A shard this device just wrote is the cloud's current version: it
   *  holds what this device pushed, merged with what others wrote (a
   *  field merge, a retried write after a 412, a clear). Apply it here,
   *  as a pull would. */
  private async applyWritten(
    db: string,
    store: string,
    n: number,
    res: { etag?: string; shard: Shard },
    settling: Set<number> | undefined,
    own: Map<string, ShardRecord> | undefined,
    check: () => void,
  ): Promise<void> {
    if (!this.schemas.get(db)?.has(store) || this.storeExcluded(db, store)) return;
    const path = this.shardPath(db, store, n);
    await this.applyDb(
      db,
      {
        views: new Map([[store, new Map([[n, res.shard]])]]),
        marks: res.etag ? new Map([[path, res.etag]]) : new Map(),
        settling,
        own: own ? new Map([[store, own]]) : undefined,
      },
      check,
    );
  }

  private cacheShard(path: string, etag: string, shard: Shard): void {
    this.shardCache.delete(path);
    this.shardCache.set(path, { etag, shard });
    while (this.shardCache.size > SHARD_CACHE_MAX) {
      const oldest = this.shardCache.keys().next().value;
      if (oldest === undefined) break;
      this.shardCache.delete(oldest);
    }
  }

  private knownAbsent(path: string): boolean {
    if (this.listedPaths.has(path)) return false;
    for (const p of this.listedPrefixes) if (path.startsWith(p)) return true;
    return false;
  }

  /** Remember what a listing of `prefix` showed (see listedPaths). */
  private rememberListing(prefix: string, listing: { path: string }[]): void {
    for (const p of [...this.listedPaths]) if (p.startsWith(prefix)) this.listedPaths.delete(p);
    for (const e of listing) this.listedPaths.add(e.path);
    this.listedPrefixes.add(prefix);
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

  /** Pull every database this device knows, or one. Per-database
   *  failures are collected, so one bad database does not stop the
   *  others. */
  private async pullDbs(only: string | null, check: () => void, errors: unknown[]): Promise<void> {
    const dbs = only !== null ? [only] : [...this.schemas.keys()];
    if (dbs.length === 0) return;
    const P = this.options.prefix;
    let listing: { path: string; etag: string }[];
    if (only !== null) {
      const shards = await this.deps.remote.list(this.dbPrefix(only));
      this.rememberListing(this.dbPrefix(only), shards);
      listing = [...shards, ...(await this.deps.remote.list(this.journalPrefix(only)))];
    } else {
      listing = await this.deps.remote.list(P + "/");
      this.rememberListing(P + "/", listing);
    }
    const shardsByDb = new Map<string, Map<string, { store: string; n: number; etag: string }>>();
    const journalsByDb = new Map<string, Map<string, string>>();
    for (const e of listing) {
      const s = this.parseShardPath(e.path);
      if (s) {
        let m = shardsByDb.get(s.db);
        if (!m) shardsByDb.set(s.db, (m = new Map()));
        m.set(e.path, { store: s.store, n: s.n, etag: e.etag });
        continue;
      }
      const j = this.parseJournalPath(e.path);
      if (j) {
        let m = journalsByDb.get(j.db);
        if (!m) journalsByDb.set(j.db, (m = new Map()));
        m.set(e.path, e.etag);
      }
    }
    for (const db of dbs) {
      try {
        await this.pullDb(db, shardsByDb.get(db) ?? new Map(), journalsByDb.get(db) ?? new Map(), check);
        if (!this.pulled.has(db)) {
          this.pulled.add(db);
          await this.log.setMeta({ ["pulled:" + db]: 1 });
        }
      } catch (e) {
        if (e instanceof UserChangedError) throw e;
        errors.push(e);
      }
    }
  }

  private async pullDb(
    db: string,
    shardEntries: Map<string, { store: string; n: number; etag: string }>,
    journalEntries: Map<string, string>,
    check: () => void,
  ): Promise<void> {
    const schema = this.schemas.get(db);
    if (!schema) return;
    const want = (store: string) => schema.has(store) && !this.storeExcluded(db, store);
    /** Per store, the shards as read: null for one that vanished or
     *  cannot be read (what this device held of it is forgotten, and its
     *  records here are uploaded again). */
    const views = new Map<string, Map<number, Shard | null>>();
    /** Shard ETags to record as applied once applied ("": forget). */
    const marks = new Map<string, string>();
    const setView = (store: string, n: number, v: Shard | null) => {
      let m = views.get(store);
      if (!m) views.set(store, (m = new Map()));
      m.set(n, v);
    };
    let fetched = false;
    const limit = limiter(PUSH_CONCURRENCY);
    /** Read one shard. `etag`: the listing's, or "?" when the shard was
     *  not in the listing read before (it may exist by now). */
    const load = async (store: string, n: number, etag: string) => {
      const path = this.shardPath(db, store, n);
      const cached = this.shardCache.get(path);
      if (cached && cached.etag === etag) {
        setView(store, n, copyShard(cached.shard));
        marks.set(path, etag);
        return;
      }
      fetched = true;
      const t0 = Date.now();
      const r = await this.deps.remote.getJSON(path, etag === "?" ? cached?.etag : undefined);
      if (r.status !== "corrupt" && r.serverTime) this.clock.observe(r.serverTime, t0, Date.now());
      if (r.status === "ok") {
        const shard = toShard(r.value);
        this.cacheShard(path, r.etag, copyShard(shard));
        setView(store, n, shard);
        marks.set(path, r.etag);
      } else if (r.status === "unchanged" && cached) {
        setView(store, n, copyShard(cached.shard));
        marks.set(path, cached.etag);
      } else if (r.status === "corrupt") {
        console.warn("[runapps sync] unreadable shard, its records will be uploaded again:", path);
        if (r.etag) this.cacheShard(path, r.etag, emptyShard());
        setView(store, n, null);
        marks.set(path, "");
      } else {
        setView(store, n, this.etags.has(path) ? null : emptyShard());
        marks.set(path, "");
      }
    };

    // 1. Shards changed since this device applied them. One an SDK
    // before 0.20 applied, unchanged since, is already here: it is only
    // recorded ("seed"), nothing is written.
    const legacy = await this.legacyEtags();
    const seeds = new Set<string>();
    const reads: Promise<void>[] = [];
    for (const [path, e] of shardEntries) {
      if (!want(e.store) || e.n >= this.options.shards) continue;
      if (this.etags.get(path) === e.etag) continue;
      if (!this.etags.has(path) && legacy.get(path) === e.etag) seeds.add(e.store + "\u0000" + e.n);
      reads.push(limit(() => load(e.store, e.n, e.etag)));
    }
    await Promise.all(reads);
    // Shards this device applied that are gone.
    for (const path of this.etags.keys()) {
      if (shardEntries.has(path)) continue;
      const p = this.parseShardPath(path);
      if (!p || p.db !== db || !want(p.store) || views.get(p.store)?.has(p.n)) continue;
      setView(p.store, p.n, null);
      marks.set(path, "");
    }

    // 2. Journals, listed after the reads: one whose ops any read shard
    // shows is listed, and its other shards are read and merged.
    const jPrefix = this.journalPrefix(db);
    const jv = await this.log.metaWithPrefix("jv:" + jPrefix);
    const loaded = new Map<string, Journal>();
    let jList = journalEntries;
    for (let round = 0; round < 3; round++) {
      if (fetched) {
        fetched = false;
        jList = new Map((await this.deps.remote.list(jPrefix)).map((e) => [e.path, e.etag] as const));
      }
      const fresh = [...jList.keys()].filter((p) => !jv.has("jv:" + p) && !loaded.has(p));
      if (fresh.length === 0) break;
      for (const p of fresh) {
        let j = this.journalCache.get(p) ?? null;
        if (!j) {
          const r = await this.deps.remote.getJSON(p);
          if (r.status !== "ok") continue;
          j = toJournal(r.value);
          if (!j) continue;
          this.journalCache.set(p, j);
        }
        loaded.set(p, j);
      }
      const more: Promise<void>[] = [];
      for (const j of loaded.values()) {
        for (const [store, part] of Object.entries(j.s)) {
          if (!want(store)) continue;
          for (const n of part.n) {
            if (n >= this.options.shards || views.get(store)?.has(n)) continue;
            setView(store, n, emptyShard()); // placeholder, filled below
            more.push(limit(() => load(store, n, shardEntries.get(this.shardPath(db, store, n))?.etag ?? "?")));
          }
        }
      }
      await Promise.all(more);
      if (!fetched) break;
    }

    // 3. Merge the journals not yet folded into what was read.
    const jvNow: Record<string, unknown> = {};
    const toFold: [string, Journal][] = [];
    const sorted = [...loaded.entries()].sort((a, b) => a[1].t - b[1].t || (a[1].id < b[1].id ? -1 : 1));
    for (const [p, j] of sorted) {
      let changed = false;
      let complete = true;
      for (const [store, part] of Object.entries(j.s)) {
        if (!want(store)) {
          complete = false;
          continue;
        }
        for (const n of part.n) {
          const view = views.get(store)?.get(n);
          if (view === undefined) {
            complete = false;
            continue;
          }
          if (view === null) {
            // A vanished shard: its records come back when it is
            // written again; the journal stays until then.
            changed = true;
            continue;
          }
          const before = JSON.stringify(view);
          mergeInto(view, part.c ?? 0, this.journalOps(part.o, n));
          if (JSON.stringify(view) !== before) {
            changed = true;
            seeds.delete(store + "\u0000" + n); // holds more than was applied
          }
        }
      }
      if (!changed && complete) jvNow["jv:" + p] = Date.now();
      else if (changed && this.clock.wall() - j.t > this.options.journalFoldAfterMs) toFold.push([p, j]);
    }

    // 4. Apply, in one transaction over the database's stores.
    if (views.size > 0) {
      check();
      await this.applyDb(db, { views, marks, seeds }, check);
    }
    if (Object.keys(jvNow).length) await this.log.setMeta(jvNow);

    // 5. Journals whose writer did not finish: finish for it.
    for (const [p, j] of toFold) await this.foldJournal(db, p, j, check);

    // 6. Journals seen folded long enough ago are no longer needed.
    const keepMs = this.options.journalKeepMs;
    const drop: Record<string, unknown> = {};
    for (const [k, at] of jv) {
      const p = k.slice(3);
      if (!jList.has(p)) {
        drop[k] = undefined;
        this.journalCache.delete(p);
      } else if (Date.now() - (at as number) > keepMs) {
        check();
        await this.deps.remote.remove(p);
        drop[k] = undefined;
        this.journalCache.delete(p);
      }
    }
    if (Object.keys(drop).length) await this.log.setMeta(drop);
  }

  private journalOps(o: JournalOp[], n: number): ShardOp[] {
    const out: ShardOp[] = [];
    for (const op of o) {
      if (!Array.isArray(op) || typeof op[0] !== "string" || !validRec(op[1])) continue;
      if (this.shardOf(op[0]) !== n) continue;
      out.push({ kid: op[0], rec: op[1], changed: Array.isArray(op[2]) ? op[2] : undefined });
    }
    return out;
  }

  private async foldJournal(db: string, path: string, j: Journal, check: () => void): Promise<void> {
    const limit = limiter(PUSH_CONCURRENCY);
    const tasks: Promise<void>[] = [];
    for (const [store, part] of Object.entries(j.s)) {
      for (const n of part.n) {
        if (n >= this.options.shards) continue;
        tasks.push(
          limit(async () => {
            const res = await this.writeShard(this.shardPath(db, store, n), part.c ?? 0, this.journalOps(part.o, n), check);
            await this.applyWritten(db, store, n, res, undefined, undefined, check);
          }),
        );
      }
    }
    await Promise.all(tasks);
    await this.log.setMeta({ ["jv:" + path]: Date.now() });
  }

  // ── Records sync has never seen ──────────────────────────────────

  /**
   * Records already in the app's database before sync saw them — written
   * before the SDK loaded, or before the app used sync at all — are in no
   * log, so nothing would ever push them and they would stay on this
   * device. Once per store, every local record the cloud has no entry for
   * goes into the log stamped older than any real write: the ordinary
   * push adds it, and an edit made elsewhere still wins. Records the
   * cloud has are left alone (the pull has applied the cloud's version).
   */
  private async adoptScan(check: () => void): Promise<void> {
    const done = new Set((await this.log.metaWithPrefix("adopted:")).keys());
    for (const db of this.openedHere) {
      const schema = this.schemas.get(db);
      if (!schema) continue;
      const scan = new Set<string>();
      for (const store of schema.keys()) {
        if (!done.has(`adopted:${db}/${store}`) && !this.storeExcluded(db, store)) scan.add(store);
      }
      if (scan.size === 0) continue;
      const complete = await this.applyDb(db, { views: new Map(), marks: new Map(), scan }, check);
      const flags: Record<string, unknown> = {};
      for (const store of complete) flags[`adopted:${db}/${store}`] = Date.now();
      if (Object.keys(flags).length) await this.log.setMeta(flags);
    }
  }

  // ── Apply ────────────────────────────────────────────────────────

  /** Pending ops, re-read only when some tab logged something since. */
  private async pendingOps(): Promise<LoggedOp[]> {
    const seq = this.readSeq();
    if (this.pendingCache && this.pendingCache.seq === seq) return this.pendingCache.ops;
    const ops = await this.log.pending();
    this.pendingCache = { seq, ops };
    return ops;
  }

  private buildGuard(db: string, pending: LoggedOp[], userId: string | null): Guard {
    const g: Guard = { kid: new Map(), store: new Map(), db: 0 };
    const add = (store: string, kid: string, kind: string, t: number) => {
      if (kind === "dbclear" || store === "*") g.db = Math.max(g.db, t);
      else if (kind === "clear" || kid === "*" || kid === "?") g.store.set(store, Math.max(g.store.get(store) ?? 0, t));
      else g.kid.set(store + "\u0000" + kid, Math.max(g.kid.get(store + "\u0000" + kid) ?? 0, t));
    };
    for (const op of pending) {
      if (op.db !== db) continue;
      add(op.store, op.kid, op.kind, op.weak ? ADOPTED_TS : op.ts);
    }
    for (const entries of this.readWal().values()) {
      for (const [d, store, kid, ts, , owner] of entries) {
        if (d !== db || (owner !== null && owner !== userId)) continue;
        add(store, kid, "", ts);
      }
    }
    for (const entries of this.walBatches.values()) {
      for (const [d, store, kid, ts] of entries) if (d === db) add(store, kid, "", ts);
    }
    return g;
  }

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
  private async applyDb(
    db: string,
    input: {
      views: Map<string, Map<number, Shard | null>>;
      marks: Map<string, string>;
      scan?: Set<string>;
      settling?: Set<number>;
      own?: Map<string, Map<string, ShardRecord>>;
      seeds?: Set<string>;
    },
    check: () => void,
  ): Promise<Set<string>> {
    const schema = this.schemas.get(db);
    const scanned = new Set<string>();
    if (!schema) return scanned;
    const stores = new Set<string>();
    for (const s of input.views.keys()) if (schema.has(s) && !this.storeExcluded(db, s)) stores.add(s);
    for (const s of input.scan ?? []) if (schema.has(s) && !this.storeExcluded(db, s)) stores.add(s);
    if (stores.size === 0) return scanned;
    check();
    const h = await this.conn(db);
    if (!h) return scanned;
    const present = [...stores].filter((s) => h.objectStoreNames.contains(s));
    if (present.length === 0) return scanned;

    const applied = new Map<string, Map<string, AppliedEntry>>();
    for (const s of present) applied.set(s, await this.log.appliedFor(db, s));
    // Records set aside as unsyncable are not "never synced".
    const dead = await this.log.deadKeys();

    // Values are decoded before the transaction (Blobs need the network).
    const decoded = new Map<string, { ok: true; value: unknown } | { ok: false }>();
    for (const store of present) {
      const own = input.own?.get(store);
      for (const [n, view] of input.views.get(store) ?? []) {
        if (!view) continue;
        const seed = input.seeds?.has(store + "\u0000" + n) ?? false;
        for (const [kid, rec] of Object.entries(view.r)) {
          if (!validRec(rec) || this.shardOf(kid) !== n) continue;
          if (rec.t > ADOPTED_TS) this.clock.witness(rec.t);
          if (seed) continue;
          if (rec.d || own?.get(kid) === rec || !newer(rec, applied.get(store)!.get(kid))) continue;
          try {
            decoded.set(store + "\u0000" + kid, {
              ok: true,
              value: await decodeValue(rec.v, (ref) => this.deps.remote.getBlob(ref.ref)),
            });
          } catch (e) {
            console.warn(`[runapps sync] cannot read ${db}/${store} record, will retry:`, e instanceof Error ? e.message : e);
            decoded.set(store + "\u0000" + kid, { ok: false });
          }
        }
      }
    }

    const userId = this.deps.userId();
    let out: ApplyResult | "retry" = "retry";
    for (let attempt = 0; out === "retry"; attempt++) {
      const seq0 = this.readSeq();
      const pending = (await this.pendingOps()).filter(
        (op) => op.db === db && (op.owner == null || op.owner === userId) && !(op.id !== undefined && input.settling?.has(op.id)),
      );
      check();
      out = await this.applyTx(h, db, present, input, applied, decoded, pending, userId, dead, attempt < 5 ? seq0 : undefined);
    }

    // Bookkeeping: what is held here now, and which shard versions.
    const etagSet = new Map<string, string | undefined>();
    for (const [path, etag] of input.marks) {
      const p = this.parseShardPath(path);
      if (!p || !present.includes(p.store)) continue;
      if (etag === "") {
        etagSet.set(path, undefined);
        continue;
      }
      const failures = out.failures.get(path) ?? 0;
      const tries = (this.applyFailures.get(path) ?? 0) + 1;
      if (failures === 0 || tries >= MAX_APPLY_ATTEMPTS) {
        if (failures) console.warn(`[runapps sync] ${failures} record(s) of ${path} could not be stored here; giving up on them`);
        this.applyFailures.delete(path);
        etagSet.set(path, etag);
      } else {
        this.applyFailures.set(path, tries);
      }
    }
    await this.log.commitApply(db, out.applied, etagSet);
    for (const [path, etag] of etagSet) {
      if (etag === undefined) this.etags.delete(path);
      else this.etags.set(path, etag);
    }
    if (out.adopted.length) {
      await this.log.append(out.adopted);
      this.pendingCache = null;
      this.adoptedAny = true;
    }
    for (const [store, keys] of out.keys) {
      if (keys.length) this.emitChange({ db, store, keys, cleared: false, source: "remote" });
    }
    for (const s of out.scanned) scanned.add(s);
    return scanned;
  }

  private applyTx(
    h: IDBDatabase,
    db: string,
    present: string[],
    input: {
      views: Map<string, Map<number, Shard | null>>;
      scan?: Set<string>;
      own?: Map<string, Map<string, ShardRecord>>;
      seeds?: Set<string>;
    },
    applied: Map<string, Map<string, AppliedEntry>>,
    decoded: Map<string, { ok: true; value: unknown } | { ok: false }>,
    pending: LoggedOp[],
    userId: string | null,
    dead: Set<string>,
    seq0: string | null | undefined,
  ): Promise<ApplyResult | "retry"> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = h.transaction(present, "readwrite");
      } catch (e) {
        reject(e);
        return;
      }
      const out: ApplyResult = { applied: new Map(), keys: new Map(), failures: new Map(), adopted: [], scanned: new Set() };
      let retry = false;
      tx.oncomplete = () => resolve(retry ? "retry" : out);
      tx.onabort = () => (retry ? resolve("retry") : reject(tx.error ?? new Error("apply aborted")));
      const localKeys = new Map<string, Map<string, IDBValidKey>>();
      let left = present.length;
      for (const store of present) {
        const r = tx.objectStore(store).getAllKeys();
        r.onsuccess = () => {
          const m = new Map<string, IDBValidKey>();
          for (const k of r.result) m.set(keyId(k), k);
          localKeys.set(store, m);
          if (--left === 0) phase2();
        };
      }
      const phase2 = () => {
        // A tab logged or committed a write since the pending ops were
        // read: start over with them, before anything is written.
        if (seq0 !== undefined && this.readSeq() !== seq0) {
          retry = true;
          tx.abort();
          return;
        }
        const guard = this.buildGuard(db, pending, userId);
        for (const store of present) {
          this.applyStore(tx.objectStore(store), db, store, input, applied.get(store)!, decoded, localKeys.get(store)!, guard, userId, dead, out);
        }
      };
    });
  }

  private applyStore(
    st: IDBObjectStore,
    db: string,
    store: string,
    input: { views: Map<string, Map<number, Shard | null>>; scan?: Set<string>; own?: Map<string, Map<string, ShardRecord>>; seeds?: Set<string> },
    appliedS: Map<string, AppliedEntry>,
    decoded: Map<string, { ok: true; value: unknown } | { ok: false }>,
    localKeys: Map<string, IDBValidKey>,
    guard: Guard,
    userId: string | null,
    dead: Set<string>,
    out: ApplyResult,
  ): void {
    const keyPath = st.keyPath as string | string[] | null;
    const upd = new Map<string, AppliedEntry | undefined>();
    out.applied.set(store, upd);
    const keys: IDBValidKey[] = [];
    out.keys.set(store, keys);
    const viewMap = input.views.get(store) ?? new Map<number, Shard | null>();
    const own = input.own?.get(store);
    const kidTs = (kid: string) => guard.kid.get(store + "\u0000" + kid) ?? 0;
    const clearTs = Math.max(guard.store.get(store) ?? 0, guard.db);
    const fail = (n: number) => {
      const p = this.shardPath(db, store, n);
      out.failures.set(p, (out.failures.get(p) ?? 0) + 1);
    };
    const guarded = (cb: () => IDBRequest, onok: (result: unknown) => void, onerr: () => void) => {
      try {
        const r = cb();
        r.onsuccess = () => onok(r.result);
        r.onerror = (e) => {
          e.preventDefault();
          e.stopPropagation();
          onerr();
        };
      } catch {
        onerr();
      }
    };
    const removeLocal = (kid: string, n: number) => {
      const key = localKeys.get(kid);
      if (key === undefined) {
        if (appliedS.has(kid)) upd.set(kid, undefined);
        return;
      }
      guarded(
        () => st.delete(key),
        () => {
          keys.push(key);
          upd.set(kid, undefined);
        },
        () => fail(n),
      );
    };
    const handled = new Set<string>();
    const adopt = (kid: string, key: IDBValidKey, ts: number) => {
      if (dead.has(db + "\u0000" + store + "\u0000" + kid)) return;
      guarded(
        () => st.get(key),
        (value) => {
          if (value !== undefined) out.adopted.push({ db, store, kind: "put", kid, key: encodeKey(key), value, ts, owner: userId });
        },
        () => {},
      );
    };
    const wall = this.clock.wall();

    const isSeed = (n: number) => input.seeds?.has(store + "\u0000" + n) ?? false;
    for (const [n, view] of viewMap) {
      if (view && isSeed(n)) {
        for (const [kid, rec] of Object.entries(view.r)) {
          if (!validRec(rec) || this.shardOf(kid) !== n) continue;
          handled.add(kid);
          if (!rec.d && newer(rec, appliedS.get(kid))) upd.set(kid, { t: rec.t, s: n, h: recHash(rec) });
        }
        continue;
      }
      if (view === null) {
        // Vanished or unreadable: forget it; its records here count as
        // never synced (uploaded again below).
        for (const [kid, a] of appliedS) if (a.s === n) upd.set(kid, undefined);
        continue;
      }
      for (const [kid, rec] of Object.entries(view.r)) {
        if (!validRec(rec) || this.shardOf(kid) !== n) continue;
        handled.add(kid);
        const a = appliedS.get(kid);
        if (!newer(rec, a)) continue;
        // A local write newer than this record is on its way up.
        if (kidTs(kid) > rec.t || clearTs >= rec.t) continue;
        const entry: AppliedEntry = { t: rec.t, s: n, h: recHash(rec) };
        if (rec.d) {
          removeLocal(kid, n);
          continue;
        }
        if (own?.get(kid) === rec && localKeys.has(kid)) {
          upd.set(kid, entry); // this device's own write, already here
          continue;
        }
        const d = decoded.get(store + "\u0000" + kid);
        if (!d || !d.ok) {
          fail(n);
          continue;
        }
        let key: IDBValidKey;
        try {
          key = decodeKey(rec.k);
        } catch {
          upd.set(kid, entry); // never storable: do not retry
          continue;
        }
        const value = d.value;
        if (keyPath !== null) {
          const inline = extractKey(value, keyPath);
          if (inline === undefined) {
            if (!(typeof keyPath === "string" && keyPath !== "" && injectKey(value, keyPath, key))) {
              console.warn(`[runapps sync] ${db}/${store}: a record without its key was skipped`);
              upd.set(kid, entry);
              continue;
            }
          } else if (keyId(inline) !== kid) {
            console.warn(`[runapps sync] ${db}/${store}: a record whose key does not match was skipped`);
            upd.set(kid, entry);
            continue;
          }
        }
        guarded(
          () => (keyPath !== null ? st.put(value) : st.put(value, key)),
          () => {
            keys.push(key);
            upd.set(kid, entry);
          },
          () => fail(n),
        );
      }
      // Held here, but no longer in the cloud: deleted there — by a
      // clear, or by a deletion whose tombstone has expired. Anything
      // else is a shard rebuilt without it (an unreadable one replaced):
      // upload it again rather than lose it.
      for (const [kid, a] of appliedS) {
        if (a.s !== n || handled.has(kid)) continue;
        if (kidTs(kid) > 0) continue; // written here since: pushed
        if (a.t <= view.cleared || wall - a.t > TOMBSTONE_TTL_MS) {
          removeLocal(kid, n);
          continue;
        }
        upd.set(kid, undefined);
        const key = localKeys.get(kid);
        if (key !== undefined) adopt(kid, key, a.t);
      }
    }

    // Local records the cloud has never had.
    const scan = input.scan?.has(store) ?? false;
    let scanComplete = true;
    for (const [kid, key] of localKeys) {
      if (handled.has(kid)) continue;
      const n = this.shardOf(kid);
      const view = viewMap.get(n);
      const a = appliedS.get(kid);
      if (a && !(view === null && a.s === n)) continue;
      if (kidTs(kid) > 0 || clearTs > 0) continue;
      // Left as the older SDK left it.
      if (view && isSeed(n)) continue;
      if (view === undefined) {
        if (!scan) continue;
        const path = this.shardPath(db, store, n);
        if (!this.etags.has(path) && !this.knownAbsent(path)) {
          scanComplete = false; // the cloud's copy of that shard is not known yet
          continue;
        }
      }
      adopt(kid, key, view ? Math.max(ADOPTED_TS, view.cleared + 0.001) : ADOPTED_TS);
    }
    if (scan && scanComplete) out.scanned.add(store);
  }

  private emitChange(change: DbChange): void {
    this.moved = true;
    this.deps.events.emit("db:change", change);
    this.post(change);
  }

  // ── The engine's own connections ─────────────────────────────────

  /** A connection to an app database; null when it does not exist (the
   *  engine never creates one). */
  private conn(db: string): Promise<IDBDatabase | null> {
    let p = this.conns.get(db);
    if (!p) {
      const pr: Promise<IDBDatabase | null> = new Promise((resolve, reject) => {
        const open = this.hook ? this.hook.originalOpen : (n: string) => indexedDB.open(n);
        const r = open(db);
        let created = false;
        r.onupgradeneeded = () => {
          created = true;
          r.transaction?.abort();
        };
        r.onsuccess = () => {
          const h = r.result;
          this.hook?.markInternal(h);
          // Step aside when the app upgrades its schema.
          h.onversionchange = () => {
            h.close();
            if (this.conns.get(db) === pr) this.conns.delete(db);
          };
          resolve(h);
        };
        r.onerror = (e) => {
          if (created) {
            e.preventDefault();
            resolve(null);
          } else {
            reject(r.error ?? new Error(`cannot open ${db}`));
          }
        };
        r.onblocked = () => reject(new Error(`open of ${db} blocked`));
      });
      p = pr;
      this.conns.set(db, pr);
      pr.then(
        (h) => {
          if (!h && this.conns.get(db) === pr) this.conns.delete(db);
        },
        () => {
          if (this.conns.get(db) === pr) this.conns.delete(db);
        },
      );
    }
    return p;
  }

  /** Run `fn` on one store; false when the database or store does not
   *  exist. */
  private async withStore(db: string, store: string, mode: IDBTransactionMode, fn: (st: IDBObjectStore) => void): Promise<boolean> {
    const h = await this.conn(db);
    if (!h || !h.objectStoreNames.contains(store)) return false;
    const tx = h.transaction(store, mode);
    fn(tx.objectStore(store));
    await idbDone(tx);
    return true;
  }
}

interface ApplyResult {
  applied: Map<string, Map<string, AppliedEntry | undefined>>;
  keys: Map<string, IDBValidKey[]>;
  failures: Map<string, number>;
  adopted: LoggedOp[];
  scanned: Set<string>;
}

export { idbRequest };

/** A shard is plain JSON: a deep copy is a JSON round trip. */
function copyShard(shard: Shard): Shard {
  return JSON.parse(JSON.stringify(shard)) as Shard;
}

/** Run at most `n` of the given tasks at once. */
function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n) return;
    const start = queue.shift();
    if (start) start();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
