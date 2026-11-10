// RunApps Sync: the hook observes an app's writes, the engine pushes
// them to sharded snapshots and pulls other devices' changes back.
//
// Runs against fake-indexeddb in Node. "Devices" are separate IDBFactory
// instances sharing one in-memory remote; the hook is installed on the
// shared prototypes, so each test disposes its engines.

import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { SyncEngine, SDKEvents } from "../dist/index.js";

// ── In-memory remote with the files API's conditional semantics ─────
class MemoryRemote {
  constructor() {
    this.objects = new Map(); // path -> { body, etag }
    this.seq = 0;
    this.puts = 0;
    this.gets = 0;
    this.beforePut = null; // test hook: (path) => void
  }
  async list(prefix) {
    return [...this.objects.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .map(([path, o]) => ({ path, etag: o.etag }));
  }
  async getJSON(path, ifNoneMatch) {
    this.gets++;
    const o = this.objects.get(path);
    if (!o) return { status: "missing" };
    if (ifNoneMatch && ifNoneMatch === o.etag) return { status: "unchanged" };
    try {
      return { status: "ok", value: JSON.parse(o.body), etag: o.etag };
    } catch {
      return { status: "corrupt", etag: o.etag };
    }
  }
  async remove(path) {
    this.removed = (this.removed ?? 0) + 1;
    this.objects.delete(path);
  }
  async putJSON(path, value, cond, opts) {
    this.lastPutOpts = opts;
    if (this.beforePut) this.beforePut(path);
    const o = this.objects.get(path);
    if (cond.ifNoneMatch && o) return { status: "conflict" };
    if (cond.ifMatch && (!o || o.etag !== cond.ifMatch)) return { status: "conflict" };
    this.puts++;
    const etag = "e" + ++this.seq;
    this.objects.set(path, { body: JSON.stringify(value), etag });
    return { status: "ok", etag };
  }
  async putBlob(path, blob) {
    if (!this.objects.has(path)) this.objects.set(path, { body: await blob.arrayBuffer(), etag: "b" + ++this.seq, type: blob.type });
  }
  async getBlob(path) {
    const o = this.objects.get(path);
    if (!o) throw new Error("missing blob " + path);
    return new Blob([o.body], { type: o.type });
  }
  shards(db, store) {
    return [...this.objects.entries()].filter(([p]) => p.startsWith(`db/${db}/${store}/`)).map(([, o]) => JSON.parse(o.body));
  }
  journals(db = "app") {
    return [...this.objects.keys()].filter((p) => p.startsWith(`db/@j/${db}/`));
  }
  records(db, store) {
    const out = {};
    for (const s of this.shards(db, store)) Object.assign(out, s.r);
    return out;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); tx.onerror = () => rej(tx.error); });

/** A "device": its own IDB factory, user and engine over a shared remote. */
function device(remote, { user = "u1", options = {}, factory = new IDBFactory(), storage } = {}) {
  globalThis.indexedDB = factory;
  const events = new SDKEvents();
  const states = [];
  events.on("sync:state", (s) => states.push(s));
  const changes = [];
  events.on("db:change", (c) => changes.push(c));
  let authCb = null;
  let currentUser = user;
  const engine = new SyncEngine(
    {
      remote,
      events,
      userId: () => currentUser,
      onAuthChange: (cb) => { authCb = cb; return () => { authCb = null; }; },
      factory,
      ...(storage ? { storage } : {}),
    },
    { pushDelayMs: 50, pullIntervalMs: 0, openTimeoutMs: 2000, ...options },
  );
  return {
    engine, events, states, changes, factory,
    setUser(u) { currentUser = u; authCb?.(); },
    /** Open the app database the way an app would, through the hooked open. */
    openApp(version = 1, upgrade) {
      return new Promise((resolve, reject) => {
        const r = factory.open("app", version);
        r.onupgradeneeded = (ev) => {
          const db = ev.target.result;
          if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
          if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache", { keyPath: "id" });
          upgrade?.(db, ev);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async write(db, store, fn) {
      const tx = db.transaction(store, "readwrite");
      fn(tx.objectStore(store), tx);
      await done(tx);
    },
    async readAll(db, store) {
      const tx = db.transaction(store, "readonly");
      return req(tx.objectStore(store).getAll());
    },
    async get(db, store, key) {
      const tx = db.transaction(store, "readonly");
      return req(tx.objectStore(store).get(key));
    },
    dispose() { engine.dispose(); },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

test("hooked open behaves like the real request", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const r = indexedDB.open("app", 1);
    assert.ok(r instanceof IDBOpenDBRequest, "instanceof IDBOpenDBRequest");
    assert.equal(r.readyState, "pending");
    let upgradeSawTx = false;
    r.onupgradeneeded = (ev) => {
      assert.equal(ev.target, r);
      assert.ok(ev.target.result, "result available during upgrade");
      upgradeSawTx = r.transaction !== null;
      ev.target.result.createObjectStore("notes", { keyPath: "id" });
    };
    const db = await req(r);
    assert.ok(upgradeSawTx, "request.transaction set during upgrade");
    assert.equal(r.readyState, "done");
    assert.equal(db.name, "app");
    db.close();
  } finally {
    A.dispose();
  }
});

test("commits are recorded and pushed; aborted writes are not", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => {
      st.put({ id: "n1", title: "one" });
      st.put({ id: "n2", title: "two" });
    });
    await A.write(db, "notes", (st) => st.delete("n2"));
    // an aborted transaction leaves no trace
    const tx = db.transaction("notes", "readwrite");
    tx.objectStore("notes").put({ id: "n3", title: "never" });
    tx.abort();
    await new Promise((r) => (tx.onabort = r));

    await A.engine.now();
    const recs = remote.records("app", "notes");
    assert.deepEqual(Object.keys(recs).sort(), ['"n1"', '"n2"']);
    assert.equal(recs['"n1"'].v.title, "one");
    assert.equal(recs['"n2"'].d, 1, "n2 is a tombstone");
    assert.equal(A.engine.status().pending, 0);
    assert.equal(A.engine.status().state, "idle");
    assert.ok(A.states.some((s) => s.state === "syncing"), "badge saw syncing");
    db.close();
  } finally {
    A.dispose();
  }
});

test("a new device gets the data before its first read", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => st.put({ id: "n1", title: "from A", tags: ["x"] }));
  await A.write(dbA, "kv", (st) => st.put({ theme: "dark" }, "settings"));
  await A.engine.now();
  dbA.close();
  A.dispose();

  const B = device(remote);
  try {
    const dbB = await B.openApp(); // success is held until the first pull
    assert.deepEqual(await B.get(dbB, "notes", "n1"), { id: "n1", title: "from A", tags: ["x"] });
    assert.deepEqual(await B.get(dbB, "kv", "settings"), { theme: "dark" });
    assert.ok(B.changes.some((c) => c.db === "app" && c.store === "notes"), "db:change fired for the pulled store");
    dbB.close();
  } finally {
    B.dispose();
  }
});

test("deletes, range deletes, cursor edits and clears reach the other device", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => {
    for (let i = 1; i <= 5; i++) st.put({ id: "n" + i, n: i });
  });
  await A.engine.now();
  dbA.close();
  A.dispose();

  const B = device(remote);
  const dbB = await B.openApp();
  assert.equal((await B.readAll(dbB, "notes")).length, 5);
  await B.write(dbB, "notes", (st) => st.delete(IDBKeyRange.bound("n1", "n2")));
  await B.write(dbB, "notes", (st) => {
    const c = st.openCursor("n3");
    c.onsuccess = () => {
      const cur = c.result;
      if (cur) cur.update({ ...cur.value, edited: true });
    };
  });
  await B.write(dbB, "notes", (st) => {
    const c = st.openCursor("n4");
    c.onsuccess = () => c.result?.delete();
  });
  await B.engine.now();
  dbB.close();
  B.dispose();

  const C = device(remote);
  try {
    const dbC = await C.openApp();
    const all = await C.readAll(dbC, "notes");
    assert.deepEqual(all.map((r) => r.id).sort(), ["n3", "n5"]);
    assert.equal(all.find((r) => r.id === "n3").edited, true);
    // and a clear
    await C.write(dbC, "notes", (st) => st.clear());
    await C.engine.now();
    dbC.close();
  } finally {
    C.dispose();
  }
  const D = device(remote);
  try {
    const dbD = await D.openApp();
    assert.equal((await D.readAll(dbD, "notes")).length, 0, "clear applied on a fresh device");
    dbD.close();
  } finally {
    D.dispose();
  }
});

test("two devices editing different fields of one record both keep their edit", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => st.put({ id: "n1", title: "t", body: "b", stars: 0 }));
  await A.engine.now();
  dbA.close();
  A.dispose();

  // B pulls, then edits title; A (still on the old copy) edits stars.
  const B = device(remote);
  const dbB = await B.openApp();
  await B.write(dbB, "notes", (st) => st.put({ id: "n1", title: "B's title", body: "b", stars: 0 }));
  await B.engine.now();
  dbB.close();
  B.dispose();

  const A2 = device(remote);
  const dbA2 = await A2.openApp(); // pulls B's title
  assert.equal((await A2.get(dbA2, "notes", "n1")).title, "B's title");
  await A2.write(dbA2, "notes", (st) => st.put({ id: "n1", title: "B's title", body: "b", stars: 5 }));
  await A2.engine.now();
  dbA2.close();
  A2.dispose();

  const merged = remote.records("app", "notes")['"n1"'].v;
  assert.deepEqual(merged, { id: "n1", title: "B's title", body: "b", stars: 5 });

  // Field-level: both edit from the same base, different fields.
  const X = device(remote);
  const dbX = await X.openApp();
  const Y = device(remote); // note: a new factory; X's db handle still works on its own factory
  const dbY = await Y.openApp();
  await X.write(dbX, "notes", (st) => st.put({ id: "n1", title: "X title", body: "b", stars: 5 }));
  await Y.write(dbY, "notes", (st) => st.put({ id: "n1", title: "B's title", body: "Y body", stars: 5 }));
  await X.engine.now();
  await Y.engine.now();
  const v = remote.records("app", "notes")['"n1"'].v;
  assert.deepEqual(v, { id: "n1", title: "X title", body: "Y body", stars: 5 });
  dbX.close();
  dbY.close();
  X.dispose();
  Y.dispose();
});

test("a lost conditional write is retried with the newer shard merged in", async () => {
  const remote = new MemoryRemote();
  const A = device(remote, { options: { shards: 1 } });
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "mine", v: 1 }));
    // Someone else writes the same shard between our read and write.
    let injected = false;
    remote.beforePut = async (path) => {
      if (injected || !path.includes("/notes/")) return;
      injected = true;
      const o = remote.objects.get(path);
      const shard = o ? JSON.parse(o.body) : { v: 1, cleared: 0, r: {} };
      shard.r['"theirs"'] = { k: "theirs", v: { id: "theirs", v: 9 }, t: Date.now() };
      remote.objects.set(path, { body: JSON.stringify(shard), etag: "x" + ++remote.seq });
    };
    await A.engine.now();
    const recs = remote.records("app", "notes");
    assert.ok(recs['"mine"'] && recs['"theirs"'], "both records survive the conflict");
    assert.equal(A.engine.status().pending, 0);
    // The writer merged the other record into the shard; it must also
    // reach the writer's own database, not only the server.
    assert.deepEqual(await A.get(db, "notes", "theirs"), { id: "theirs", v: 9 });
    db.close();
  } finally {
    A.dispose();
  }
});

test("Dates, Maps, binary and Blobs survive the round trip", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const dbA = await A.openApp();
  const when = new Date("2026-10-10T08:00:00Z");
  await A.write(dbA, "notes", (st) =>
    st.put({
      id: "rich",
      when,
      tags: new Map([["a", 1]]),
      set: new Set(["x"]),
      bytes: new Uint8Array([1, 2, 3]),
      file: new Blob(["hello"], { type: "text/plain" }),
      nothing: undefined,
      nan: NaN,
    }),
  );
  await A.engine.now();
  assert.ok([...remote.objects.keys()].some((p) => p.startsWith("db/_blobs/")), "blob stored out of band");
  dbA.close();
  A.dispose();

  const B = device(remote);
  try {
    const dbB = await B.openApp();
    const r = await B.get(dbB, "notes", "rich");
    assert.ok(r.when instanceof Date && r.when.getTime() === when.getTime());
    assert.ok(r.tags instanceof Map && r.tags.get("a") === 1);
    assert.ok(r.set instanceof Set && r.set.has("x"));
    assert.ok(r.bytes instanceof Uint8Array && [...r.bytes].join() === "1,2,3");
    assert.ok(r.file instanceof Blob && (await r.file.text()) === "hello" && r.file.type === "text/plain");
    assert.ok("nothing" in r && r.nothing === undefined);
    assert.ok(Number.isNaN(r.nan));
    dbB.close();
  } finally {
    B.dispose();
  }
});

test("excluded stores stay local", async () => {
  const remote = new MemoryRemote();
  const A = device(remote, { options: { exclude: ["app/cache"] } });
  try {
    const db = await A.openApp();
    await A.write(db, "cache", (st) => st.put({ id: "c1", big: "x" }));
    await A.write(db, "notes", (st) => st.put({ id: "n1" }));
    await A.engine.now();
    assert.equal(Object.keys(remote.records("app", "cache")).length, 0);
    assert.equal(Object.keys(remote.records("app", "notes")).length, 1);
    db.close();
  } finally {
    A.dispose();
  }
});

test("another user signing in on the same browser does not see the first user's data", async () => {
  const remote = new MemoryRemote();
  const A = device(remote, { user: "u1" });
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "secret", owner: "u1" }));
    await A.engine.now();
    assert.equal((await A.readAll(db, "notes")).length, 1);
    // u2 signs in; the remote (a different user's file space) is empty.
    const remote2 = new MemoryRemote();
    A.engine["deps"].remote = remote2;
    A.setUser("u2");
    await A.engine.now();
    assert.equal((await A.readAll(db, "notes")).length, 0, "u1's rows were wiped");
    assert.equal(Object.keys(remote2.records("app", "notes")).length, 0, "nothing of u1's was pushed to u2");
    db.close();
  } finally {
    A.dispose();
  }
});

test("no user: writes queue locally and go out after sign-in", async () => {
  const remote = new MemoryRemote();
  const A = device(remote, { user: null });
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "offline-note" }));
    await sleep(120);
    assert.equal(A.engine.status().state, "off");
    assert.equal(Object.keys(remote.records("app", "notes")).length, 0);
    A.setUser("u1");
    await A.engine.now();
    assert.equal(Object.keys(remote.records("app", "notes")).length, 1);
    assert.equal(A.engine.status().pending, 0);
    db.close();
  } finally {
    A.dispose();
  }
});

test("unchanged shards cost no download on the next pull", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "n1" }));
    await A.engine.now();
    const gets = remote.gets;
    await A.engine.now();
    assert.equal(remote.gets, gets, "etags match the listing: nothing re-read");
    db.close();
  } finally {
    A.dispose();
  }
});

// ── Push speed: parallel shards, no read before a write ─────────────

/** A remote whose writes take a while, counting how many overlap. */
function slowRemote(ms = 20) {
  const remote = new MemoryRemote();
  const put = remote.putJSON.bind(remote);
  remote.inFlight = 0;
  remote.maxInFlight = 0;
  remote.putJSON = async (...args) => {
    remote.inFlight++;
    remote.maxInFlight = Math.max(remote.maxInFlight, remote.inFlight);
    try {
      await sleep(ms);
      return await put(...args);
    } finally {
      remote.inFlight--;
    }
  };
  return remote;
}

test("a push writes several shards at once", async () => {
  const remote = slowRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => {
      for (let i = 0; i < 64; i++) st.put({ id: "n" + i });
    });
    await A.engine.now();
    assert.ok(remote.maxInFlight > 1, `writes overlapped (max ${remote.maxInFlight})`);
    assert.ok(remote.maxInFlight <= 6, "but no more than six at a time");
    assert.equal(Object.keys(remote.records("app", "notes")).length, 64);
    assert.equal(A.engine.status().pending, 0);
    db.close();
  } finally {
    A.dispose();
  }
});

test("pending counts down while a push runs", async () => {
  const remote = slowRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => {
      for (let i = 0; i < 64; i++) st.put({ id: "n" + i });
    });
    await A.engine.now();
    const seen = A.states.map((s) => s.pending);
    assert.ok(seen.some((p) => p > 0 && p < 64), `intermediate counts reported: ${seen.join(",")}`);
    db.close();
  } finally {
    A.dispose();
  }
});

test("a shard the listing lacks is created without a read", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp(); // the open lists the database: nothing there
    const gets = remote.gets;
    await A.write(db, "notes", (st) => st.put({ id: "n1" }));
    await A.engine.now();
    assert.equal(remote.gets, gets, "created with If-None-Match, unread");
    assert.ok(remote.records("app", "notes")['"n1"']);
    db.close();
  } finally {
    A.dispose();
  }
});

test("writing a shard again needs no read", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "n1", v: 1 }));
    await A.engine.now();
    const gets = remote.gets;
    await A.write(db, "notes", (st) => st.put({ id: "n1", v: 2 }));
    await A.engine.now();
    assert.equal(remote.gets, gets, "merged into the cached copy, sent with If-Match");
    assert.equal(remote.records("app", "notes")['"n1"'].v.v, 2);
    db.close();
  } finally {
    A.dispose();
  }
});

test("a cached shard someone else changed since is re-read and merged", async () => {
  const remote = new MemoryRemote();
  const A = device(remote, { options: { shards: 1 } });
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "mine", v: 1 }));
    await A.engine.now();
    // Another device writes the same shard: our cached etag is stale.
    const [path, o] = [...remote.objects.entries()].find(([p]) => p.includes("/notes/"));
    const shard = JSON.parse(o.body);
    shard.r['"theirs"'] = { k: "theirs", v: { id: "theirs" }, t: Date.now() };
    remote.objects.set(path, { body: JSON.stringify(shard), etag: "x" + ++remote.seq });
    await A.write(db, "notes", (st) => st.put({ id: "mine", v: 2 }));
    await A.engine.now();
    const recs = remote.records("app", "notes");
    assert.ok(recs['"theirs"'], "their record survives");
    assert.equal(recs['"mine"'].v.v, 2);
    db.close();
  } finally {
    A.dispose();
  }
});

/** Open "app" on a factory with no engine watching: what an app wrote
 *  before the SDK loaded, or before it used sync at all. */
async function writeBeforeSync(factory, fill) {
  const db = await new Promise((resolve, reject) => {
    const r = factory.open("app", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("notes", { keyPath: "id" });
      d.createObjectStore("kv");
      d.createObjectStore("cache", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = db.transaction(["notes", "kv"], "readwrite");
  fill(tx.objectStore("notes"), tx.objectStore("kv"));
  await done(tx);
  db.close();
}

test("records written before sync saw them are pushed once; the cloud's own records win", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => st.put({ id: "shared", title: "cloud" }));
  await A.engine.now();
  dbA.close();
  A.dispose();

  const factory = new IDBFactory();
  await writeBeforeSync(factory, (notes, kv) => {
    notes.put({ id: "shared", title: "stale local" });
    notes.put({ id: "local-only", title: "never synced" });
    kv.put("v", "pref");
  });
  const B = device(remote, { factory });
  try {
    const db = await B.openApp();
    await B.engine.now();
    const recs = remote.records("app", "notes");
    assert.equal(recs['"local-only"']?.v.title, "never synced", "the record only this device had is on the server");
    assert.equal(recs['"local-only"'].t, 1, "stamped older than any real write");
    assert.equal(recs['"shared"'].v.title, "cloud", "a record the cloud has is not overwritten");
    assert.equal((await B.get(db, "notes", "shared")).title, "cloud");
    assert.equal(remote.records("app", "kv")['"pref"']?.v, "v", "out-of-line keys too");
    const puts = remote.puts;
    await B.engine.now();
    assert.equal(remote.puts, puts, "the scan runs once per store");
    db.close();
  } finally {
    B.dispose();
  }
});

test("an edit made elsewhere beats a record adopted from before sync", async () => {
  const remote = new MemoryRemote();
  const factory = new IDBFactory();
  await writeBeforeSync(factory, (notes) => notes.put({ id: "n", title: "old" }));
  const B = device(remote, { factory });
  const dbB = await B.openApp();
  await B.engine.now();
  dbB.close();
  B.dispose();
  const A = device(remote);
  try {
    const db = await A.openApp();
    assert.equal((await A.get(db, "notes", "n")).title, "old");
    await A.write(db, "notes", (st) => st.put({ id: "n", title: "new" }));
    await A.engine.now();
    assert.equal(remote.records("app", "notes")['"n"'].v.title, "new");
    db.close();
  } finally {
    A.dispose();
  }
});

/** Run with a browser-like window/document and a Web Locks stub that
 *  grants the sync lock after `grantAfterMs` (a page that just loaded). */
async function inBrowser(fn, { grantAfterMs = 0 } = {}) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const locks = {
    request: (_name, cb) => new Promise((resolve) => setTimeout(() => resolve(cb()), grantAfterMs)),
  };
  globalThis.window = win;
  globalThis.document = doc;
  Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
  try {
    await fn({ win, doc });
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.navigator.locks;
  }
}

test("another user's rows are gone before the app's first read", async () => {
  const remote1 = new MemoryRemote();
  const factory = new IDBFactory();
  const A = device(remote1, { user: "u1", factory });
  const db1 = await A.openApp();
  await A.write(db1, "notes", (st) => st.put({ id: "secret", owner: "u1" }));
  await A.engine.now();
  db1.close();
  A.dispose();

  // u2 already has data in their own space.
  const remote2 = new MemoryRemote();
  const C = device(remote2, { user: "u2" });
  const dbC = await C.openApp();
  await C.write(dbC, "notes", (st) => st.put({ id: "mine", owner: "u2" }));
  await C.engine.now();
  dbC.close();
  C.dispose();

  // A page that just loaded: the app opens its database while the sync
  // lock is still being granted.
  await inBrowser(async () => {
    const B = device(remote2, { user: "u2", factory });
    try {
      const db = await B.openApp(); // the first read
      const ids = (await B.readAll(db, "notes")).map((n) => n.id).sort();
      assert.deepEqual(ids, ["mine"], "u2's data is there and u1's row is not, even briefly");
      await B.engine.now();
      assert.equal(remote2.records("app", "notes")['"secret"'], undefined, "and u1's row never reaches u2");
      db.close();
    } finally {
      B.dispose();
    }
  }, { grantAfterMs: 30 });
});

test("hiding the page pushes at once; leaving it asks the write to outlive the page", async () => {
  await inBrowser(async ({ win, doc }) => {
    const remote = new MemoryRemote();
    const A = device(remote, { options: { pushDelayMs: 60_000 } });
    try {
      const db = await A.openApp();
      await A.engine.now();
      await A.write(db, "notes", (st) => st.put({ id: "edited" }));
      await sleep(50);
      assert.equal(remote.records("app", "notes")['"edited"'], undefined, "still gathering");
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      await sleep(100);
      assert.ok(remote.records("app", "notes")['"edited"'], "pushed when hidden");
      assert.notEqual(remote.lastPutOpts?.keepalive, true, "a hidden page is alive: an ordinary write");

      await A.write(db, "notes", (st) => st.put({ id: "last" }));
      await sleep(20);
      win.dispatchEvent(new Event("pagehide"));
      await sleep(100);
      assert.ok(remote.records("app", "notes")['"last"'], "pushed on pagehide");
      assert.equal(remote.lastPutOpts?.keepalive, true, "with keepalive");
      db.close();
    } finally {
      A.dispose();
    }
  });
});

// ── Integrity: partial pushes, concurrent writes, recovery (0.20) ───

/** A remote that can be taken offline, or made to fail writes. */
function flakyRemote(base) {
  const r = Object.create(base);
  r.offline = false;
  r.failPuts = false;
  const guard = () => { if (r.offline) throw new TypeError("Failed to fetch"); };
  r.list = async (...a) => { guard(); return base.list(...a); };
  r.getJSON = async (...a) => { guard(); return base.getJSON(...a); };
  r.putJSON = async (...a) => { guard(); if (r.failPuts) throw new Error("HTTP 402"); return base.putJSON(...a); };
  r.remove = async (...a) => { guard(); return base.remove(...a); };
  r.putBlob = async (...a) => { guard(); return base.putBlob(...a); };
  r.getBlob = async (...a) => { guard(); return base.getBlob(...a); };
  return r;
}

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

test("a push cut short after one shard is seen whole, and finished by another device", async () => {
  const base = new MemoryRemote();
  const A = device(base, { options: { shards: 2 } });
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => {
    for (let i = 0; i < 10; i++) st.put({ id: "n" + i, i });
  });
  // The page dies after the journal and the first shard are written.
  let puts = 0;
  base.beforePut = () => {
    if (++puts > 2) throw new Error("page closed");
  };
  await A.engine.now();
  base.beforePut = null;
  assert.equal(base.journals().length, 1, "the journal was written first");
  const inShards = Object.keys(base.records("app", "notes")).length;
  assert.ok(inShards > 0 && inShards < 10, `only part of the push reached the shards (${inShards})`);
  dbA.close();
  A.dispose();

  // Another device sees all of it, not the half that was folded.
  const B = device(base, { options: { shards: 2, journalFoldAfterMs: 0, journalKeepMs: 0 } });
  try {
    const dbB = await B.openApp();
    assert.equal((await B.readAll(dbB, "notes")).length, 10, "the journal filled in the rest");
    await B.engine.now();
    assert.equal(Object.keys(base.records("app", "notes")).length, 10, "and B folded it into the shards");
    await B.engine.now();
    assert.equal(base.journals().length, 0, "a folded journal is deleted once it is old enough");
    dbB.close();
  } finally {
    B.dispose();
  }
});

test("a journal is not folded by others while its writer may still be at it", async () => {
  const base = new MemoryRemote();
  const A = device(base, { options: { shards: 2 } });
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => {
    for (let i = 0; i < 10; i++) st.put({ id: "n" + i });
  });
  let puts = 0;
  base.beforePut = () => {
    if (++puts > 2) throw new Error("page closed");
  };
  await A.engine.now();
  base.beforePut = null;
  dbA.close();
  A.dispose();
  const B = device(base, { options: { shards: 2 } }); // fold after 2 min
  try {
    const dbB = await B.openApp();
    assert.equal((await B.readAll(dbB, "notes")).length, 10);
    const before = Object.keys(base.records("app", "notes")).length;
    await B.engine.now();
    assert.equal(Object.keys(base.records("app", "notes")).length, before, "left to its writer for now");
    assert.equal(base.journals().length, 1);
    dbB.close();
  } finally {
    B.dispose();
  }
});

test("a clear on one device, then writes on another, leaves everyone with the new data", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const B = device(remote);
  try {
    const dbA = await A.openApp();
    await A.write(dbA, "notes", (st) => { st.put({ id: "old1" }); st.put({ id: "old2" }); });
    await A.engine.now();
    const dbB = await B.openApp();
    assert.equal((await B.readAll(dbB, "notes")).length, 2);
    await A.write(dbA, "notes", (st) => st.clear());
    await A.write(dbA, "notes", (st) => st.put({ id: "a-new" }));
    await A.engine.now();
    await B.write(dbB, "notes", (st) => st.put({ id: "b-new" }));
    await B.engine.now();
    await A.engine.now();
    assert.deepEqual((await A.readAll(dbA, "notes")).map((r) => r.id).sort(), ["a-new", "b-new"]);
    assert.deepEqual((await B.readAll(dbB, "notes")).map((r) => r.id).sort(), ["a-new", "b-new"]);
    dbA.close();
    dbB.close();
  } finally {
    A.dispose();
    B.dispose();
  }
});

test("a pull does not overwrite a local write still waiting to go up, and runs when the push fails", async () => {
  const base = new MemoryRemote();
  const A = device(base);
  const dbA0 = await A.openApp();
  await A.write(dbA0, "notes", (st) => st.put({ id: "n1", v: 1 }));
  await A.engine.now();
  dbA0.close();
  A.dispose();

  const remoteB = flakyRemote(base);
  const B = device(remoteB, { options: { pushDelayMs: 60_000 } });
  const C = device(base);
  try {
    const dbB = await B.openApp();
    const dbC = await C.openApp();
    await C.write(dbC, "notes", (st) => { st.put({ id: "other", v: 1 }); st.put({ id: "n1", v: 2 }); });
    await C.engine.now();
    await B.write(dbB, "notes", (st) => st.put({ id: "n1", v: 3 })); // later than C's
    remoteB.failPuts = true; // no balance: pushes fail, reads work
    await B.engine.now();
    assert.equal(B.engine.status().state, "error");
    assert.ok(await B.get(dbB, "notes", "other"), "the pull ran although the push failed");
    assert.equal((await B.get(dbB, "notes", "n1")).v, 3, "the unsent local write is kept");
    remoteB.failPuts = false;
    await B.engine.now();
    assert.equal(base.records("app", "notes")['"n1"'].v.v, 3);
    dbB.close();
    dbC.close();
  } finally {
    B.dispose();
    C.dispose();
  }
});

test("a field merge made while pushing reaches the writer's own database", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => st.put({ id: "n1", title: "t", body: "b" }));
  await A.engine.now();
  const B = device(remote);
  try {
    const dbB = await B.openApp();
    await A.write(dbA, "notes", (st) => st.put({ id: "n1", title: "A title", body: "b" }));
    await B.write(dbB, "notes", (st) => st.put({ id: "n1", title: "t", body: "B body" }));
    await A.engine.now();
    await B.engine.now(); // merges A's title into its write
    assert.deepEqual(await B.get(dbB, "notes", "n1"), { id: "n1", title: "A title", body: "B body" });
    dbB.close();
  } finally {
    dbA.close();
    A.dispose();
    B.dispose();
  }
});

test("autoIncrement keys travel with the record; a cursor edit in place keeps the other device's field", async () => {
  const remote = new MemoryRemote();
  const upgrade = (db) => {
    if (!db.objectStoreNames.contains("auto")) db.createObjectStore("auto", { keyPath: "id", autoIncrement: true });
  };
  const A = device(remote);
  const dbA = await A.openApp(1, upgrade);
  await A.write(dbA, "auto", (st) => st.add({ text: "first" }));
  await A.write(dbA, "notes", (st) => st.put({ id: "n1", a: 1, b: 1 }));
  await A.engine.now();
  const B = device(remote);
  try {
    const dbB = await B.openApp(1, upgrade);
    assert.deepEqual(await B.readAll(dbB, "auto"), [{ id: 1, text: "first" }], "stored once, under its key");
    // A edits a through a cursor, changing cursor.value in place; B edits b.
    await A.write(dbA, "notes", (st) => {
      const c = st.openCursor("n1");
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return;
        cur.value.a = 2;
        cur.update(cur.value);
      };
    });
    await B.write(dbB, "notes", (st) => st.put({ id: "n1", a: 1, b: 2 }));
    await A.engine.now();
    await B.engine.now();
    assert.deepEqual(remote.records("app", "notes")['"n1"'].v, { id: "n1", a: 2, b: 2 });
    dbB.close();
  } finally {
    dbA.close();
    A.dispose();
    B.dispose();
  }
});

test("writes made by an upgrade, and a deleted store, are synced", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const db1 = await A.openApp();
  await A.write(db1, "kv", (st) => st.put("v", "k"));
  await A.engine.now();
  db1.close();
  assert.ok(remote.records("app", "kv")['"k"']);
  const db2 = await A.openApp(2, (db, ev) => {
    if (ev.oldVersion < 2) {
      ev.target.transaction.objectStore("notes").put({ id: "migrated" });
      db.deleteObjectStore("kv");
    }
  });
  try {
    await A.engine.now();
    assert.ok(remote.records("app", "notes")['"migrated"'], "the migration's write");
    assert.equal(Object.keys(remote.records("app", "kv")).length, 0, "the deleted store is cleared");
    db2.close();
  } finally {
    A.dispose();
  }
});

test("a record that cannot be stored here does not stall the others", async () => {
  const remote = new MemoryRemote();
  remote.objects.set("db/app/users/0.json", {
    etag: "x1",
    body: JSON.stringify({
      v: 1,
      cleared: 0,
      r: {
        '"u1"': { k: "u1", v: { id: "u1", email: "same" }, t: 10 },
        '"u2"': { k: "u2", v: { id: "u2", email: "same" }, t: 11 },
        '"u3"': { k: "u3", v: { id: "u3", email: "other" }, t: 12 },
      },
    }),
  });
  const A = device(remote, { options: { shards: 1 } });
  try {
    const db = await A.openApp(1, (d) => {
      const st = d.createObjectStore("users", { keyPath: "id" });
      st.createIndex("email", "email", { unique: true });
    });
    const ids = (await A.readAll(db, "users")).map((u) => u.id).sort();
    assert.equal(ids.length, 2, `one of the clashing pair and the other record (${ids})`);
    assert.ok(ids.includes("u3"));
    await A.engine.now();
    assert.equal(A.engine.status().state, "idle", "sync goes on");
    db.close();
  } finally {
    A.dispose();
  }
});

test("a value sync cannot store is set aside; the rest goes up", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => {
      const cyclic = { id: "cyc" };
      cyclic.self = cyclic;
      st.put(cyclic);
      st.put({ id: "fine" });
    });
    await A.engine.now();
    await A.engine.now();
    assert.ok(remote.records("app", "notes")['"fine"']);
    assert.equal(remote.records("app", "notes")['"cyc"'], undefined);
    const s = A.engine.status();
    assert.equal(s.state, "idle");
    assert.equal(s.pending, 0);
    assert.equal(s.failed, 1);
    db.close();
  } finally {
    A.dispose();
  }
});

test("writes made before a device ever pulled lose to the cloud's copy", async () => {
  const base = new MemoryRemote();
  const A = device(base);
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => st.put({ id: "settings", theme: "dark" }));
  await A.engine.now();
  dbA.close();
  A.dispose();

  const remoteB = flakyRemote(base);
  remoteB.offline = true;
  const B = device(remoteB);
  try {
    const db = await B.openApp(); // offline: no pull
    await B.write(db, "notes", (st) => st.put({ id: "settings", theme: "light" })); // the app's default
    await B.write(db, "notes", (st) => st.put({ id: "draft", text: "typed offline" }));
    remoteB.offline = false;
    await B.engine.now();
    assert.equal(base.records("app", "notes")['"settings"'].v.theme, "dark", "the user's setting survives");
    assert.equal((await B.get(db, "notes", "settings")).theme, "dark", "and comes down");
    assert.equal(base.records("app", "notes")['"draft"'].v.text, "typed offline", "a record the cloud lacks still goes up");
    db.close();
  } finally {
    B.dispose();
  }
});

test("Errors round-trip", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  const dbA = await A.openApp();
  await A.write(dbA, "notes", (st) => st.put({ id: "e", err: new RangeError("boom") }));
  await A.engine.now();
  dbA.close();
  A.dispose();
  const B = device(remote);
  try {
    const db = await B.openApp();
    const r = await B.get(db, "notes", "e");
    assert.ok(r.err instanceof RangeError);
    assert.equal(r.err.message, "boom");
    db.close();
  } finally {
    B.dispose();
  }
});

const deleteDb = (factory, name) => new Promise((res, rej) => {
  const r = factory.deleteDatabase(name);
  r.onsuccess = () => res();
  r.onerror = () => rej(r.error);
});

test("deleting the database signed in deletes the cloud copy; the engine never recreates it", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "n1" }));
    await A.write(db, "kv", (st) => st.put(1, "k"));
    await A.engine.now();
    db.close();
    await deleteDb(A.factory, "app");
    await A.engine.now();
    const names = (await A.factory.databases()).map((d) => d.name);
    assert.ok(!names.includes("app"), "no empty database left behind");
    assert.equal(Object.keys(remote.records("app", "notes")).length, 0);
    assert.equal(Object.keys(remote.records("app", "kv")).length, 0);
    const db2 = await A.openApp();
    await A.write(db2, "notes", (st) => st.put({ id: "fresh" }));
    await A.engine.now();
    assert.deepEqual((await A.readAll(db2, "notes")).map((r) => r.id), ["fresh"]);
    assert.ok(remote.records("app", "notes")['"fresh"'], "new writes after the reset are kept");
    db2.close();
  } finally {
    A.dispose();
  }
});

test("signed out, a clear or a deleted database is local only and refills on sign-in", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => { st.put({ id: "n1" }); st.put({ id: "n2" }); });
    await A.engine.now();
    A.setUser(null);
    await A.write(db, "notes", (st) => st.clear()); // the app's sign-out cleanup
    A.setUser("u1");
    await A.engine.now();
    assert.equal(Object.keys(remote.records("app", "notes")).length, 2, "the cloud copy is untouched");
    assert.equal((await A.readAll(db, "notes")).length, 2, "and the local copy came back");
    db.close();
    A.setUser(null);
    await deleteDb(A.factory, "app");
    A.setUser("u1");
    const db2 = await A.openApp();
    assert.equal((await A.readAll(db2, "notes")).length, 2);
    db2.close();
  } finally {
    A.dispose();
  }
});

test("a change of user keeps the first user's unsent writes for them", async () => {
  const r1 = new MemoryRemote();
  const r2 = new MemoryRemote();
  const flaky1 = flakyRemote(r1);
  const A = device(flaky1, { user: "u1" });
  try {
    const db = await A.openApp();
    flaky1.offline = true;
    await A.write(db, "notes", (st) => st.put({ id: "u1-note" }));
    await A.engine.now(); // offline: stays in the log
    A.engine["deps"].remote = r2;
    A.setUser("u2");
    await A.engine.now();
    assert.equal(r2.records("app", "notes")['"u1-note"'], undefined, "never pushed to u2");
    assert.equal((await A.readAll(db, "notes")).length, 0, "nor shown to u2");
    assert.equal(A.engine.status().pending, 0, "and not counted as u2's");
    flaky1.offline = false;
    A.engine["deps"].remote = flaky1;
    A.setUser("u1");
    await A.engine.now();
    assert.ok(r1.records("app", "notes")['"u1-note"'], "pushed when u1 is back");
    db.close();
  } finally {
    A.dispose();
  }
});

test("a write after seeing a record from a clock ahead still wins", async () => {
  const remote = new MemoryRemote();
  const ahead = Date.now() + 10 * 60_000;
  remote.objects.set("db/app/notes/0.json", {
    etag: "x1",
    body: JSON.stringify({ v: 1, cleared: 0, r: { '"n1"': { k: "n1", v: { id: "n1", v: "from the future" }, t: ahead } } }),
  });
  const A = device(remote, { options: { shards: 1 } });
  try {
    const db = await A.openApp();
    assert.equal((await A.get(db, "notes", "n1")).v, "from the future");
    await A.write(db, "notes", (st) => st.put({ id: "n1", v: "edited" }));
    await A.engine.now();
    assert.equal(remote.records("app", "notes")['"n1"'].v.v, "edited");
    db.close();
  } finally {
    A.dispose();
  }
});

test("a deletion whose tombstone expired while a device was away still reaches it", async () => {
  const remote = new MemoryRemote();
  const longAgo = Date.now() - 100 * 24 * 3600_000;
  const path = "db/app/notes/0.json";
  const rec = (id) => ({ k: id, v: { id }, t: longAgo });
  remote.objects.set(path, { etag: "x1", body: JSON.stringify({ v: 1, cleared: 0, r: { '"gone"': rec("gone"), '"kept"': rec("kept") } }) });
  const B = device(remote, { options: { shards: 1 } });
  try {
    const dbB = await B.openApp();
    assert.equal((await B.readAll(dbB, "notes")).length, 2);
    // B goes away; "gone" is deleted elsewhere and, 90 days on, its
    // tombstone is purged.
    remote.objects.set(path, { etag: "x2", body: JSON.stringify({ v: 1, cleared: 0, r: { '"kept"': rec("kept") } }) });
    await B.engine.now();
    assert.deepEqual((await B.readAll(dbB, "notes")).map((r) => r.id), ["kept"]);
    dbB.close();
  } finally {
    B.dispose();
  }
});

test("a recent record missing from its shard is uploaded again, not deleted", async () => {
  const remote = new MemoryRemote();
  const A = device(remote, { options: { shards: 1 } });
  const B = device(remote, { options: { shards: 1 } });
  try {
    const dbA = await A.openApp();
    await A.write(dbA, "notes", (st) => { st.put({ id: "a" }); st.put({ id: "b" }); });
    await A.engine.now();
    const dbB = await B.openApp();
    // The shard is rebuilt without "b" (an unreadable copy replaced by a
    // device that never had it), with no tombstone.
    const path = "db/app/notes/0.json";
    const shard = JSON.parse(remote.objects.get(path).body);
    delete shard.r['"b"'];
    remote.objects.set(path, { body: JSON.stringify(shard), etag: "x" + ++remote.seq });
    await B.engine.now();
    assert.equal((await B.readAll(dbB, "notes")).length, 2, "kept");
    assert.ok(remote.records("app", "notes")['"b"'], "and back in the cloud");
    dbA.close();
    dbB.close();
  } finally {
    A.dispose();
    B.dispose();
  }
});

test("a write whose tab closed before it was logged is recovered", async () => {
  const remote = new MemoryRemote();
  const storage = new MemStorage();
  const A = device(remote, { storage });
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => st.put({ id: "w1", v: 1 }));
    await A.engine.now();
    // Another tab committed v2 and died before logging it: the database
    // has it, the log does not, its WAL entry is left.
    const raw = await new Promise((res) => {
      const r = A.engine["hook"].originalOpen("app");
      r.onsuccess = () => res(r.result);
    });
    A.engine["hook"].markInternal(raw);
    const tx = raw.transaction("notes", "readwrite");
    tx.objectStore("notes").put({ id: "w1", v: 2 });
    await done(tx);
    raw.close();
    storage.setItem("__runapps_sync_wal:deadtab", JSON.stringify([["app", "notes", '"w1"', Date.now(), Date.now() - 10 * 60_000, "u1"]]));
    await A.engine.now();
    assert.equal(remote.records("app", "notes")['"w1"'].v.v, 2);
    assert.equal(storage.getItem("__runapps_sync_wal:deadtab"), null);
    db.close();
  } finally {
    A.dispose();
  }
});

test("a put then a delete of one key in one transaction ends deleted; the reverse ends present", async () => {
  const remote = new MemoryRemote();
  const A = device(remote);
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => { st.put({ id: "x" }); st.delete("x"); });
    await A.write(db, "notes", (st) => { st.delete("y"); st.put({ id: "y" }); });
    await A.engine.now();
    const recs = remote.records("app", "notes");
    assert.equal(recs['"x"'].d, 1);
    assert.ok(recs['"y"'] && !recs['"y"'].d);
    db.close();
  } finally {
    A.dispose();
  }
});

test("a vanished or unreadable shard is rebuilt from the devices that hold its records", async () => {
  const remote = new MemoryRemote();
  const A = device(remote, { options: { shards: 1 } });
  try {
    const db = await A.openApp();
    await A.write(db, "notes", (st) => { st.put({ id: "a" }); st.put({ id: "b" }); });
    await A.engine.now();
    const path = "db/app/notes/0.json";
    remote.objects.delete(path); // the user deleted the app's files
    await A.engine.now();
    assert.equal(Object.keys(remote.records("app", "notes")).length, 2, "uploaded again");
    assert.equal((await A.readAll(db, "notes")).length, 2, "and kept here");
    remote.objects.set(path, { body: '{"v":1,"r":{"\\"a\\"', etag: "x" + ++remote.seq }); // a write cut short
    await A.engine.now();
    assert.equal(Object.keys(remote.records("app", "notes")).length, 2, "rewritten as valid JSON");
    assert.equal((await A.readAll(db, "notes")).length, 2);
    db.close();
  } finally {
    A.dispose();
  }
});
