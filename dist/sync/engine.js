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
import { changedFields, decodeKey, decodeValue, encodeKey, encodeValue, hash32, keyId } from "./codec.js";
import { installIndexedDBHook } from "./hook.js";
import { idbDone, idbRequest, SyncLog } from "./log.js";
function isPlainRecord(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v) && !("$rt" in v);
}
function sameJSON(a, b) {
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
function mergeRecord(cur, inc, changed) {
    if (!cur)
        return inc;
    if (inc.d || cur.d || !isPlainRecord(cur.v) || !isPlainRecord(inc.v)) {
        return inc.t >= cur.t ? inc : cur;
    }
    const curF = cur.f ?? {};
    const touched = changed ? new Set(changed) : null;
    const out = {};
    const f = {};
    const fields = new Set([...Object.keys(cur.v), ...Object.keys(inc.v)]);
    for (const name of fields) {
        const inCur = name in cur.v;
        const inInc = name in inc.v;
        const curT = curF[name] ?? cur.t;
        const untouched = touched ? !touched.has(name) : inCur && inInc && sameJSON(cur.v[name], inc.v[name]);
        if (untouched) {
            if (inCur) {
                out[name] = cur.v[name];
                if (curF[name] !== undefined)
                    f[name] = curF[name];
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
        }
        else if (inCur) {
            out[name] = cur.v[name];
            f[name] = curT;
        }
    }
    return { k: inc.k, v: out, t: Math.max(cur.t, inc.t), f };
}
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
/** Shards one push writes at a time. Each is a read-merge-write against
 *  the files API, so the push is latency bound: done one by one, a few
 *  hundred records over every shard took a minute and a half. */
const PUSH_CONCURRENCY = 6;
/** Shard copies kept, with their etags, so a write needs no read first. */
const SHARD_CACHE_MAX = 256;
const MAX_PUSH_DELAY_MS = 10_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Hybrid logical clock: wall time, never going backwards, with the
 *  server's clock offset applied once learned. */
class Clock {
    last = 0;
    offset = 0;
    now() {
        const t = Date.now() + this.offset;
        this.last = t > this.last ? t : this.last + 1;
        return this.last;
    }
    observe(serverTime, localBefore, localAfter) {
        const mid = (localBefore + localAfter) / 2;
        const off = serverTime - mid;
        if (Math.abs(off - this.offset) > 2000)
            this.offset = off;
    }
}
function pathSeg(s) {
    return encodeURIComponent(s).replace(/%2F/gi, "%2F");
}
export class SyncEngine {
    deps;
    options;
    log;
    hook;
    clock = new Clock();
    schemas = new Map();
    etags = new Map();
    /** The last copy of a shard this engine read or wrote, with its etag:
     *  the next write merges into it and sends If-Match, and only a 412
     *  (someone else wrote in between) costs a read. Oldest first. */
    shardCache = new Map();
    /** Every shard path the last listing showed, and the prefixes that
     *  listing covered: a path under a covered prefix that isn't listed
     *  does not exist, and is created with If-None-Match, unread. */
    listedPaths = new Set();
    listedPrefixes = new Set();
    conns = new Map();
    state = { state: "off", pending: 0 };
    paused = false;
    disposed = false;
    leader = true;
    pushTimer = null;
    pushDeadline = 0;
    pullTimer = null;
    backoffMs = 0;
    backoffUntil = 0;
    chain = Promise.resolve();
    cleanup = [];
    channel = null;
    metaLoaded = null;
    constructor(deps, options = {}) {
        this.deps = deps;
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
        this.log = new SyncLog((name, version) => this.hook ? this.hook.originalOpen(name, version) : indexedDB.open(name, version));
        if (typeof window !== "undefined")
            this.attachBrowserTriggers();
        this.cleanup.push(deps.onAuthChange(() => this.schedule("auth")));
        void this.refreshPending();
        void this.schedule("start");
    }
    // ── Public surface ───────────────────────────────────────────────
    status() {
        return { ...this.state };
    }
    /** Push pending changes and pull remote ones now. */
    now() {
        if (!this.leader) {
            // Another tab syncs for this origin: ask it to go now. Its state
            // comes back over the channel.
            this.post({ type: "sync:request" });
            return Promise.resolve();
        }
        return this.enqueue(() => this.sync());
    }
    /** Send to the other tabs of this origin. */
    post(msg) {
        try {
            this.channel?.postMessage(msg);
        }
        catch {
            /* channel closed */
        }
    }
    pause() {
        this.paused = true;
    }
    resume() {
        this.paused = false;
        void this.schedule("resume");
    }
    dispose() {
        this.disposed = true;
        for (const c of this.cleanup)
            c();
        if (this.pushTimer)
            clearTimeout(this.pushTimer);
        if (this.pullTimer)
            clearInterval(this.pullTimer);
        this.channel?.close();
        for (const p of this.conns.values())
            p.then((db) => db.close()).catch(() => { });
        this.conns.clear();
        this.log.close();
        this.hook?.uninstall();
    }
    // ── Hook callbacks ───────────────────────────────────────────────
    onCommit(db, ops) {
        const logged = [];
        for (const op of ops) {
            const ts = this.clock.now();
            if (op.kind === "clear")
                logged.push({ db, store: op.store, kind: "clear", kid: "", ts });
            else if (op.kind === "del")
                logged.push({ db, store: op.store, kind: "del", kid: keyId(op.key), key: encodeKey(op.key), ts });
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
        // The other tabs share this database but get no event from it:
        // tell them what changed so their views can re-read.
        const byStore = new Map();
        for (const op of ops) {
            let e = byStore.get(op.store);
            if (!e)
                byStore.set(op.store, (e = { keys: [], cleared: false }));
            if (op.kind === "clear") {
                e.cleared = true;
                e.keys = [];
            }
            else if (!e.cleared) {
                e.keys.push(op.key);
            }
        }
        for (const [store, e] of byStore) {
            const change = { db, store, keys: e.keys, cleared: e.cleared, source: "tab" };
            this.post({ type: "db:change", change });
        }
    }
    logChain = Promise.resolve();
    enqueueLog(ops) {
        this.logChain = this.logChain
            .then(() => this.log.append(ops))
            .then(() => this.refreshPending())
            .then(() => {
            if (!this.leader)
                this.post({ type: "sync:request" });
        })
            .catch((err) => this.fail(err));
        this.schedulePush();
    }
    async onOpen(db, name) {
        const schema = new Map();
        const names = Array.from(db.objectStoreNames);
        if (names.length > 0) {
            const tx = db.transaction(names, "readonly");
            for (const n of names) {
                const st = tx.objectStore(n);
                schema.set(n, { keyPath: st.keyPath, autoIncrement: st.autoIncrement });
                if (st.autoIncrement && typeof console !== "undefined") {
                    console.warn(`[runapps sync] "${name}/${n}" uses autoIncrement keys: records created on two devices while offline can get the same key, and only one survives. Prefer client-generated ids (e.g. crypto.randomUUID()).`);
                }
            }
        }
        this.schemas.set(name, schema);
        void this.log.setMeta({ ["schema:" + name]: Object.fromEntries(schema) }).catch(() => { });
        if (!this.deps.userId() || this.paused || !this.leader)
            return;
        await this.enqueue(() => this.pullDatabase(name)).catch(() => { });
    }
    onDeleteDatabase(name) {
        const schema = this.schemas.get(name);
        const stores = schema ? Array.from(schema.keys()) : [];
        this.schemas.delete(name);
        this.conns.get(name)?.then((db) => db.close()).catch(() => { });
        this.conns.delete(name);
        const ts = this.clock.now();
        this.enqueueLog(stores.map((store) => ({ db: name, store, kind: "clear", kid: "", ts })));
    }
    // ── Scheduling ───────────────────────────────────────────────────
    attachBrowserTriggers() {
        const on = (target, type, fn) => {
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
                if (document.visibilityState === "visible")
                    void this.schedule("visible");
                this.updatePullTimer();
            });
        }
        this.updatePullTimer();
        if (typeof BroadcastChannel === "function") {
            this.channel = new BroadcastChannel("__runapps_db_change__");
            this.channel.onmessage = (ev) => {
                const d = ev.data;
                if (!d)
                    return;
                if (d.type === "db:change") {
                    this.deps.events.emit("db:change", d.change);
                }
                else if (d.type === "sync:state") {
                    // The leader's state is the origin's state; a follower shows it.
                    if (!this.leader) {
                        this.state = { ...d.state };
                        this.deps.events.emit("sync:state", { ...d.state });
                    }
                }
                else if (d.type === "sync:request") {
                    // A follower wrote to the log, or wants a sync now: go, and
                    // tell it where things stand either way.
                    if (this.leader) {
                        this.post({ type: "sync:state", state: { ...this.state } });
                        void this.schedule("peer");
                    }
                }
                else if (d.source === "remote") {
                    this.deps.events.emit("db:change", d);
                }
            };
        }
        // One tab syncs at a time; the others feed the shared log and wait
        // for the lock, taking over when the leader closes.
        const locks = navigator.locks;
        if (locks && typeof locks.request === "function") {
            this.leader = false;
            // Until the lock is ours, another tab is syncing: ask it where
            // things stand so this tab does not sit on the initial "off".
            this.post({ type: "sync:request" });
            void locks
                .request("__runapps_sync__", () => {
                this.leader = true;
                void this.schedule("leader");
                return new Promise(() => { }); // hold until the tab dies
            })
                .catch(() => {
                this.leader = true;
            });
        }
    }
    updatePullTimer() {
        const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
        if (visible && !this.pullTimer && this.options.pullIntervalMs > 0) {
            this.pullTimer = setInterval(() => void this.schedule("interval"), this.options.pullIntervalMs);
            this.pullTimer.unref?.();
        }
        else if (!visible && this.pullTimer) {
            clearInterval(this.pullTimer);
            this.pullTimer = null;
        }
    }
    schedulePush() {
        if (this.disposed)
            return;
        const now = Date.now();
        if (!this.pushDeadline)
            this.pushDeadline = now + MAX_PUSH_DELAY_MS;
        const delay = Math.max(0, Math.min(this.options.pushDelayMs, this.pushDeadline - now));
        if (this.pushTimer)
            clearTimeout(this.pushTimer);
        this.pushTimer = setTimeout(() => {
            this.pushTimer = null;
            this.pushDeadline = 0;
            void this.schedule("push");
        }, delay);
        this.pushTimer.unref?.();
    }
    schedule(_reason) {
        if (this.disposed || this.paused || !this.leader)
            return Promise.resolve();
        if (!this.deps.userId()) {
            this.setState({ state: "off" });
            return Promise.resolve();
        }
        if (Date.now() < this.backoffUntil)
            return Promise.resolve();
        return this.enqueue(() => this.sync());
    }
    enqueue(fn) {
        const run = this.chain.then(fn, fn);
        this.chain = run.catch(() => { });
        return run;
    }
    // ── State ────────────────────────────────────────────────────────
    /** Set while a sync cycle pushes or applies something. */
    moved = false;
    setState(patch) {
        const next = { ...this.state, ...patch };
        if (patch.state && patch.state !== "error")
            delete next.error;
        const changed = next.state !== this.state.state ||
            next.pending !== this.state.pending ||
            next.lastSyncedAt !== this.state.lastSyncedAt ||
            next.lastChangeAt !== this.state.lastChangeAt ||
            next.error !== this.state.error;
        this.state = next;
        if (changed) {
            this.deps.events.emit("sync:state", { ...next });
            if (this.leader)
                this.post({ type: "sync:state", state: { ...next } });
        }
    }
    async refreshPending() {
        try {
            const n = await this.log.pendingCount();
            this.setState({ pending: n });
        }
        catch {
            /* log unavailable (private mode): stay with the last count */
        }
    }
    fail(err) {
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        const msg = err instanceof Error ? err.message : String(err);
        this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
        this.backoffUntil = Date.now() + this.backoffMs;
        this.setState({ state: offline ? "offline" : "error", error: msg });
        if (!offline && typeof console !== "undefined")
            console.warn("[runapps sync]", msg);
    }
    // ── Sync ─────────────────────────────────────────────────────────
    async loadMeta() {
        if (!this.metaLoaded) {
            this.metaLoaded = (async () => {
                for (const [k, v] of await this.log.metaWithPrefix("etag:"))
                    this.etags.set(k.slice(5), v);
                for (const [k, v] of await this.log.metaWithPrefix("schema:")) {
                    const name = k.slice(7);
                    if (!this.schemas.has(name)) {
                        this.schemas.set(name, new Map(Object.entries(v)));
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
    async ensureOwner(userId) {
        const owner = await this.log.getMeta("owner");
        if (owner === userId)
            return;
        if (owner !== undefined) {
            for (const [db, schema] of this.schemas) {
                for (const store of schema.keys()) {
                    if (this.storeExcluded(db, store))
                        continue;
                    await this.withStore(db, store, "readwrite", (st) => {
                        st.clear();
                    }).catch(() => { });
                    this.emitChange({ db, store, keys: [], cleared: true, source: "remote" });
                }
            }
            await this.log.clearAll();
            this.etags.clear();
            this.shardCache.clear();
            this.listedPaths.clear();
            this.listedPrefixes.clear();
            this.metaLoaded = null;
            await this.loadMeta();
        }
        await this.log.setMeta({ owner: userId });
    }
    async sync() {
        if (this.disposed || this.paused || !this.leader)
            return;
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
        }
        catch (err) {
            await this.refreshPending();
            this.fail(err);
        }
    }
    storeExcluded(db, store) {
        return this.options.exclude.includes(db + "/" + store) || this.options.exclude.includes(db);
    }
    shardPath(db, store, shard) {
        return `${this.options.prefix}/${pathSeg(db)}/${pathSeg(store)}/${shard}.json`;
    }
    shardOf(kid) {
        return hash32(kid) % this.options.shards;
    }
    async readShard(path) {
        const before = Date.now();
        const r = await this.deps.remote.getJSON(path);
        if (r.status === "ok") {
            if (r.serverTime)
                this.clock.observe(r.serverTime, before, Date.now());
            const s = r.value;
            const shard = { v: 1, cleared: s?.cleared ?? 0, r: s?.r ?? {} };
            this.etags.set(path, r.etag);
            return { shard, etag: r.etag };
        }
        this.etags.delete(path);
        return { shard: { v: 1, cleared: 0, r: {} } };
    }
    // ── Push ─────────────────────────────────────────────────────────
    async push() {
        const ops = await this.log.pending();
        if (ops.length === 0)
            return;
        // Group by store, keeping commit order inside a store.
        const groups = new Map();
        for (const op of ops) {
            const k = op.db + "\u0000" + op.store;
            let g = groups.get(k);
            if (!g)
                groups.set(k, (g = []));
            g.push(op);
        }
        const idsOf = (list) => list.map((op) => op.id).filter((id) => id !== undefined);
        // Ops leave the log as soon as the shard holding them is written, so
        // `pending` counts down while a long push runs, and a push cut short
        // keeps only what really is still unsent.
        const settle = async (ids) => {
            if (ids.length === 0)
                return;
            await this.log.remove(ids);
            this.moved = true;
            await this.refreshPending();
        };
        const limit = limiter(PUSH_CONCURRENCY);
        const work = [];
        for (const [, g] of groups) {
            const db = g[0].db;
            const store = g[0].store;
            if (this.storeExcluded(db, store)) {
                work.push(settle(idsOf(g)));
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
            const byShard = new Map();
            for (const op of live) {
                const s = this.shardOf(op.kid);
                let list = byShard.get(s);
                if (!list)
                    byShard.set(s, (list = []));
                list.push(op);
            }
            const shards = clearedAt > 0 ? Array.from({ length: this.options.shards }, (_, i) => i) : Array.from(byShard.keys());
            const written = shards.map((n) => limit(async () => {
                const path = this.shardPath(db, store, n);
                const shardOps = byShard.get(n) ?? [];
                const encoded = await Promise.all(shardOps.map((op) => this.encodeOp(op)));
                const etag = await this.writeShard(path, clearedAt, encoded);
                await this.log.setMeta({ ["etag:" + path]: etag });
                await settle(idsOf(shardOps));
            }));
            // The clear itself, and what it superseded, once every shard is.
            work.push(Promise.all(written).then(() => settle(idsOf(g.slice(0, lastClear + 1)))));
        }
        const results = await Promise.allSettled(work);
        const failed = results.find((r) => r.status === "rejected");
        if (failed)
            throw failed.reason;
    }
    async encodeOp(op) {
        if (op.kind === "del")
            return { kid: op.kid, rec: { k: op.key, v: null, t: op.ts, d: 1 } };
        const v = await encodeValue(op.value, (blob) => this.storeBlob(blob));
        return { kid: op.kid, rec: { k: op.key, v, t: op.ts }, changed: op.changed };
    }
    /** Merge ops into one shard and write it; retried on a 412. The first
     *  try starts from the cached copy, or from nothing when the last
     *  listing showed no such shard — no read either way. */
    async writeShard(path, clearedAt, ops) {
        for (let attempt = 0; attempt < 5; attempt++) {
            const cached = attempt === 0 ? this.shardCache.get(path) : undefined;
            const { shard, etag } = cached
                ? { shard: copyShard(cached.shard), etag: cached.etag }
                : attempt === 0 && this.knownAbsent(path)
                    ? { shard: { v: 1, cleared: 0, r: {} }, etag: undefined }
                    : await this.readShard(path);
            const now = this.clock.now();
            if (clearedAt > shard.cleared) {
                shard.cleared = clearedAt;
                for (const kid of Object.keys(shard.r)) {
                    if (shard.r[kid].t <= clearedAt)
                        delete shard.r[kid];
                }
            }
            for (const { kid, rec, changed } of ops) {
                if (rec.t <= shard.cleared)
                    continue;
                shard.r[kid] = mergeRecord(shard.r[kid], rec, changed);
            }
            // Tombstones only matter until every device has seen them.
            for (const kid of Object.keys(shard.r)) {
                const rec = shard.r[kid];
                if (rec.d && now - rec.t > TOMBSTONE_TTL_MS)
                    delete shard.r[kid];
            }
            const before = Date.now();
            const r = await this.deps.remote.putJSON(path, shard, etag ? { ifMatch: etag } : { ifNoneMatch: true });
            if (r.status === "ok") {
                if (r.serverTime)
                    this.clock.observe(r.serverTime, before, Date.now());
                this.etags.set(path, r.etag);
                this.cacheShard(path, r.etag, shard);
                this.listedPaths.add(path);
                return r.etag;
            }
            this.etags.delete(path);
            this.shardCache.delete(path);
            this.listedPaths.add(path); // it exists after all
        }
        throw new Error(`could not write ${path}: too many concurrent writers`);
    }
    cacheShard(path, etag, shard) {
        this.shardCache.delete(path);
        this.shardCache.set(path, { etag, shard });
        while (this.shardCache.size > SHARD_CACHE_MAX) {
            const oldest = this.shardCache.keys().next().value;
            if (oldest === undefined)
                break;
            this.shardCache.delete(oldest);
        }
    }
    knownAbsent(path) {
        if (this.listedPaths.has(path))
            return false;
        for (const p of this.listedPrefixes)
            if (path.startsWith(p))
                return true;
        return false;
    }
    /** Remember what a listing of `prefix` showed (see listedPaths). */
    rememberListing(prefix, listing) {
        for (const p of [...this.listedPaths])
            if (p.startsWith(prefix))
                this.listedPaths.delete(p);
        for (const e of listing)
            this.listedPaths.add(e.path);
        this.listedPrefixes.add(prefix);
    }
    async storeBlob(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
        const ref = `${this.options.prefix}/_blobs/${hex}`;
        await this.deps.remote.putBlob(ref, blob);
        return { ref, type: blob.type, size: blob.size };
    }
    // ── Pull ─────────────────────────────────────────────────────────
    async pull() {
        const prefix = this.options.prefix + "/";
        const listing = await this.deps.remote.list(prefix);
        this.rememberListing(prefix, listing);
        await this.applyListing(listing);
    }
    async pullDatabase(name) {
        if (!this.deps.userId())
            return;
        await this.loadMeta();
        const prefix = `${this.options.prefix}/${pathSeg(name)}/`;
        const listing = await this.deps.remote.list(prefix);
        this.rememberListing(prefix, listing);
        await this.applyListing(listing);
    }
    async applyListing(listing) {
        const re = new RegExp("^" + this.options.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/([^/]+)/([^/]+)/(\\d+)\\.json$");
        const pending = await this.log.pending();
        const etagUpdates = {};
        for (const entry of listing) {
            const m = re.exec(entry.path);
            if (!m)
                continue;
            const db = decodeURIComponent(m[1]);
            const store = decodeURIComponent(m[2]);
            if (this.etags.get(entry.path) === entry.etag)
                continue;
            if (this.storeExcluded(db, store))
                continue;
            const schema = this.schemas.get(db);
            if (!schema || !schema.has(store))
                continue; // the app has not created it (yet)
            const r = await this.deps.remote.getJSON(entry.path, this.etags.get(entry.path));
            if (r.status === "unchanged") {
                continue;
            }
            if (r.status === "missing") {
                this.etags.delete(entry.path);
                etagUpdates["etag:" + entry.path] = undefined;
                continue;
            }
            const s = r.value;
            const shard = { v: 1, cleared: s?.cleared ?? 0, r: s?.r ?? {} };
            // Cached before applying: applyShard annotates the records.
            this.cacheShard(entry.path, r.etag, copyShard(shard));
            await this.applyShard(db, store, shard, pending);
            this.etags.set(entry.path, r.etag);
            etagUpdates["etag:" + entry.path] = r.etag;
        }
        if (Object.keys(etagUpdates).length)
            await this.log.setMeta(etagUpdates);
    }
    async applyShard(db, store, shard, pending) {
        // A local write newer than the remote record wins until it is pushed.
        const localNewer = new Map();
        let localClear = 0;
        for (const op of pending) {
            if (op.db !== db || op.store !== store)
                continue;
            if (op.kind === "clear")
                localClear = Math.max(localClear, op.ts);
            else
                localNewer.set(op.kid, Math.max(localNewer.get(op.kid) ?? 0, op.ts));
        }
        const clearKey = `cleared:${db}/${store}`;
        const appliedClear = (await this.log.getMeta(clearKey)) ?? 0;
        const schema = this.schemas.get(db)?.get(store);
        const keys = [];
        let clearedLocally = false;
        await this.withStore(db, store, "readwrite", (st) => {
            if (shard.cleared > appliedClear && shard.cleared > localClear) {
                // Another device cleared this store after our last pull: drop the
                // local rows, keep what is still unpushed (replayed below).
                st.clear();
                clearedLocally = true;
            }
            for (const kid of Object.keys(shard.r)) {
                const rec = shard.r[kid];
                if ((localNewer.get(kid) ?? 0) >= rec.t)
                    continue;
                if (rec.t <= localClear)
                    continue;
                const key = decodeKey(rec.k);
                keys.push(key);
                if (rec.d) {
                    st.delete(key);
                }
                else {
                    // Values are decoded before the transaction (Blobs need the
                    // network); see the pre-pass below.
                    const value = rec._decoded;
                    if (schema && schema.keyPath !== null)
                        st.put(value);
                    else
                        st.put(value, key);
                }
            }
            if (clearedLocally) {
                for (const op of pending) {
                    if (op.db !== db || op.store !== store || op.kind !== "put" || op.ts <= shard.cleared)
                        continue;
                    if (schema && schema.keyPath !== null)
                        st.put(op.value);
                    else
                        st.put(op.value, decodeKey(op.key));
                }
            }
        }, async () => {
            for (const kid of Object.keys(shard.r)) {
                const rec = shard.r[kid];
                if (rec.d || (localNewer.get(kid) ?? 0) >= rec.t || rec.t <= localClear)
                    continue;
                rec._decoded = await decodeValue(rec.v, (ref) => this.deps.remote.getBlob(ref.ref));
            }
        });
        if (shard.cleared > appliedClear)
            await this.log.setMeta({ [clearKey]: shard.cleared });
        if (keys.length > 0 || clearedLocally) {
            this.emitChange({ db, store, keys, cleared: clearedLocally, source: "remote" });
        }
    }
    emitChange(change) {
        this.moved = true;
        this.deps.events.emit("db:change", change);
        try {
            this.post(change);
        }
        catch {
            /* keys that cannot be cloned across tabs: the local event already fired */
        }
    }
    // ── The engine's own connections ─────────────────────────────────
    conn(db) {
        let p = this.conns.get(db);
        if (!p) {
            p = new Promise((resolve, reject) => {
                const open = this.hook ? this.hook.originalOpen : (n) => indexedDB.open(n);
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
    async withStore(db, store, mode, fn, prepare) {
        if (prepare)
            await prepare();
        const h = await this.conn(db);
        if (!h.objectStoreNames.contains(store))
            return;
        const tx = h.transaction(store, mode);
        fn(tx.objectStore(store));
        await idbDone(tx);
    }
}
export { idbRequest };
/** A shard is plain JSON: a deep copy is a JSON round trip. */
function copyShard(shard) {
    return JSON.parse(JSON.stringify(shard));
}
/** Run at most `n` of the given tasks at once. */
function limiter(n) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= n)
            return;
        const start = queue.shift();
        if (start)
            start();
    };
    return (task) => new Promise((resolve, reject) => {
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
//# sourceMappingURL=engine.js.map