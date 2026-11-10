// sync/log.ts — the SDK's own IndexedDB databases.
//
// `__runapps_sync__` (version 1, the same since the first SDK with sync:
// an SDK still open in another tab keeps working with it):
//   ops     — local changes not yet pushed, in commit order. Values are
//             kept as the app wrote them (structured clone, Blobs
//             included); they are encoded only when pushed, so logging
//             works offline. Each op names the user it was written for.
//   meta    — small key/value state: the owner (user id the local data
//             belongs to), schemas, journals seen, the clock offset. The
//             `etag:` entries are written by SDKs before 0.20 (whole
//             shards applied) and only read now.
//
// `__runapps_sync_state__` (0.20):
//   applied — per record, the cloud version this device holds locally
//             (its write time and the shard it came from). A shard is
//             applied record by record against it, so a record is written
//             locally only when the cloud has something newer, and a
//             record the cloud no longer has is recognised as deleted.
//   marks   — shard ETags applied that way.
//   dead    — ops that can never be pushed (a value the codec refuses),
//             kept for inspection instead of blocking every later push.
//   info    — whose data `applied` describes.
//
// Opened through the untouched `indexedDB.open`, never the hooked one,
// and their names start with `__runapps` so the hook leaves them alone.
export const SYNC_DB_NAME = "__runapps_sync__";
const SYNC_DB_VERSION = 1;
export const SYNC_STATE_DB_NAME = "__runapps_sync_state__";
const SYNC_STATE_DB_VERSION = 1;
function req(r) {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
    });
}
function done(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
}
export class SyncLog {
    open;
    mainPromise = null;
    statePromise = null;
    constructor(open) {
        this.open = open;
    }
    openDb(name, version, upgrade, reset) {
        const p = new Promise((resolve, reject) => {
            const r = this.open(name, version);
            r.onupgradeneeded = () => upgrade(r.result);
            r.onsuccess = () => {
                const db = r.result;
                // Another tab upgrading (a future SDK) must not be blocked by us.
                db.onversionchange = () => {
                    db.close();
                    reset();
                };
                resolve(db);
            };
            r.onerror = () => reject(r.error ?? new Error(`cannot open ${name}`));
            r.onblocked = () => reject(new Error(`${name} open blocked`));
        });
        p.catch(() => reset());
        return p;
    }
    db() {
        if (!this.mainPromise) {
            this.mainPromise = this.openDb(SYNC_DB_NAME, SYNC_DB_VERSION, (db) => {
                if (!db.objectStoreNames.contains("ops")) {
                    const ops = db.createObjectStore("ops", { keyPath: "id", autoIncrement: true });
                    ops.createIndex("store", ["db", "store"], { unique: false });
                }
                if (!db.objectStoreNames.contains("meta"))
                    db.createObjectStore("meta");
            }, () => (this.mainPromise = null));
        }
        return this.mainPromise;
    }
    state() {
        if (!this.statePromise) {
            this.statePromise = this.openDb(SYNC_STATE_DB_NAME, SYNC_STATE_DB_VERSION, (db) => {
                // Keyed [db, store, kid].
                if (!db.objectStoreNames.contains("applied"))
                    db.createObjectStore("applied");
                if (!db.objectStoreNames.contains("marks"))
                    db.createObjectStore("marks");
                if (!db.objectStoreNames.contains("dead"))
                    db.createObjectStore("dead", { autoIncrement: true });
                if (!db.objectStoreNames.contains("info"))
                    db.createObjectStore("info");
            }, () => (this.statePromise = null));
        }
        return this.statePromise;
    }
    async append(ops) {
        if (ops.length === 0)
            return;
        const db = await this.db();
        const tx = db.transaction("ops", "readwrite");
        const st = tx.objectStore("ops");
        for (const op of ops)
            st.add(op);
        await done(tx);
    }
    async pending() {
        const db = await this.db();
        const tx = db.transaction("ops", "readonly");
        const all = (await req(tx.objectStore("ops").getAll()));
        return all;
    }
    async pendingCount() {
        const db = await this.db();
        const tx = db.transaction("ops", "readonly");
        return req(tx.objectStore("ops").count());
    }
    async remove(ids) {
        if (ids.length === 0)
            return;
        const db = await this.db();
        const tx = db.transaction("ops", "readwrite");
        const st = tx.objectStore("ops");
        for (const id of ids)
            st.delete(id);
        await done(tx);
    }
    /** Give every op whose owner is `from` (undefined: logged before owners
     *  were recorded, or null: nobody signed in) to `to`. */
    async reassignOwner(from, to) {
        const db = await this.db();
        const tx = db.transaction("ops", "readwrite");
        const cur = tx.objectStore("ops").openCursor();
        cur.onsuccess = () => {
            const c = cur.result;
            if (!c)
                return;
            const op = c.value;
            if (from(op.owner))
                c.update({ ...op, owner: to });
            c.continue();
        };
        await done(tx);
    }
    /** Move ops that can never be pushed out of the way. */
    async bury(ops) {
        if (ops.length === 0)
            return;
        const st = await this.state();
        const tx = st.transaction("dead", "readwrite");
        for (const { op, error } of ops) {
            const { value: _v, ...rest } = op;
            // The value itself may be what cannot be stored again: keep its
            // description, not the value.
            tx.objectStore("dead").add({ op: rest, error, at: Date.now() });
        }
        await done(tx);
        await this.remove(ops.map((o) => o.op.id).filter((id) => id !== undefined));
    }
    /** db\0store\0kid of every op set aside. */
    async deadKeys() {
        const st = await this.state();
        const tx = st.transaction("dead", "readonly");
        const all = (await req(tx.objectStore("dead").getAll()));
        return new Set(all.map((d) => d.op.db + "\u0000" + d.op.store + "\u0000" + d.op.kid));
    }
    async deadCount() {
        const st = await this.state();
        const tx = st.transaction("dead", "readonly");
        return req(tx.objectStore("dead").count());
    }
    async appliedFor(dbName, store) {
        const st = await this.state();
        const tx = st.transaction("applied", "readonly");
        const os = tx.objectStore("applied");
        const range = IDBKeyRange.bound([dbName, store], [dbName, store, []]);
        const keys = (await req(os.getAllKeys(range)));
        const vals = (await req(os.getAll(range)));
        const out = new Map();
        keys.forEach((k, i) => out.set(k[2], vals[i]));
        return out;
    }
    /** Forget what this device holds of one store or a whole database,
     *  and the shard ETags under `markPrefix`. */
    async forgetApplied(dbName, store, markPrefix) {
        const st = await this.state();
        const tx = st.transaction(["applied", "marks"], "readwrite");
        const range = store === undefined
            ? IDBKeyRange.bound([dbName], [dbName, []])
            : IDBKeyRange.bound([dbName, store], [dbName, store, []]);
        tx.objectStore("applied").delete(range);
        tx.objectStore("marks").delete(IDBKeyRange.bound(markPrefix, markPrefix + "\uffff"));
        await done(tx);
    }
    /** Bookkeeping for one apply, in one transaction: what this device
     *  now holds of each store, and the shard ETags applied (undefined:
     *  forget). */
    async commitApply(dbName, applied, marks) {
        const st = await this.state();
        const tx = st.transaction(["applied", "marks"], "readwrite");
        const os = tx.objectStore("applied");
        for (const [store, entries] of applied) {
            for (const [kid, e] of entries) {
                if (e === undefined)
                    os.delete([dbName, store, kid]);
                else
                    os.put(e, [dbName, store, kid]);
            }
        }
        const m = tx.objectStore("marks");
        for (const [path, etag] of marks) {
            if (etag === undefined)
                m.delete(path);
            else
                m.put(etag, path);
        }
        await done(tx);
    }
    /** Every shard ETag applied record by record. */
    async marks() {
        const st = await this.state();
        const tx = st.transaction("marks", "readonly");
        const os = tx.objectStore("marks");
        const keys = (await req(os.getAllKeys()));
        const vals = (await req(os.getAll()));
        const out = new Map();
        keys.forEach((k, i) => out.set(k, vals[i]));
        return out;
    }
    /** The user `applied` describes. */
    async stateOwner() {
        const st = await this.state();
        const tx = st.transaction("info", "readonly");
        return (await req(tx.objectStore("info").get("owner")));
    }
    /** Forget everything held (applied and marks) and record a new owner. */
    async resetState(owner) {
        const st = await this.state();
        const tx = st.transaction(["applied", "marks", "info"], "readwrite");
        tx.objectStore("applied").clear();
        tx.objectStore("marks").clear();
        tx.objectStore("info").put(owner, "owner");
        await done(tx);
    }
    async setStateOwner(owner) {
        const st = await this.state();
        const tx = st.transaction("info", "readwrite");
        tx.objectStore("info").put(owner, "owner");
        await done(tx);
    }
    async getMeta(key) {
        const db = await this.db();
        const tx = db.transaction("meta", "readonly");
        return (await req(tx.objectStore("meta").get(key)));
    }
    async setMeta(entries) {
        const db = await this.db();
        const tx = db.transaction("meta", "readwrite");
        const st = tx.objectStore("meta");
        for (const k of Object.keys(entries)) {
            if (entries[k] === undefined)
                st.delete(k);
            else
                st.put(entries[k], k);
        }
        await done(tx);
    }
    /** Every meta entry whose key starts with `prefix`, as a map. */
    async metaWithPrefix(prefix) {
        const db = await this.db();
        const tx = db.transaction("meta", "readonly");
        const st = tx.objectStore("meta");
        const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
        const keys = (await req(st.getAllKeys(range)));
        const vals = await req(st.getAll(range));
        const out = new Map();
        keys.forEach((k, i) => out.set(k, vals[i]));
        return out;
    }
    /** Delete every meta entry whose key starts with one of `prefixes`. */
    async deleteMetaWithPrefix(...prefixes) {
        const db = await this.db();
        const tx = db.transaction("meta", "readwrite");
        const st = tx.objectStore("meta");
        for (const p of prefixes)
            st.delete(IDBKeyRange.bound(p, p + "\uffff"));
        await done(tx);
    }
    /** A new owner: every meta entry, and everything held. The ops (which
     *  carry their owner) and the dead letters stay. */
    async resetForOwner(owner) {
        const db = await this.db();
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").clear();
        await done(tx);
        await this.resetState(owner);
    }
    close() {
        this.mainPromise?.then((db) => db.close()).catch(() => { });
        this.statePromise?.then((db) => db.close()).catch(() => { });
        this.mainPromise = null;
        this.statePromise = null;
    }
}
export { req as idbRequest, done as idbDone };
//# sourceMappingURL=log.js.map