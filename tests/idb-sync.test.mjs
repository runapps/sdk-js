// IndexedDB sync: the hook observes an app's writes, the engine pushes
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
    return { status: "ok", value: JSON.parse(o.body), etag: o.etag };
  }
  async putJSON(path, value, cond) {
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
function device(remote, { user = "u1", options = {} } = {}) {
  const factory = new IDBFactory();
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
  const A = device(remote);
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
