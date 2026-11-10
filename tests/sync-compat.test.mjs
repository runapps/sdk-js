import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
// Run with OLD_SDK=<path to a 0.19 build>/dist/index.js; skipped otherwise.
const OLD = process.env.OLD_SDK ? await import(process.env.OLD_SDK) : null;
const NEW = await import("../dist/index.js");

class MemoryRemote {
  constructor() { this.objects = new Map(); this.seq = 0; this.blobGets = 0; this.offline = false; }
  async list(prefix) { if (this.offline) throw new TypeError("offline"); return [...this.objects.entries()].filter(([p]) => p.startsWith(prefix)).map(([path, o]) => ({ path, etag: o.etag })); }
  async getJSON(path, inm) {
    if (this.offline) throw new TypeError("offline");
    const o = this.objects.get(path); if (!o) return { status: "missing" };
    if (inm && inm === o.etag) return { status: "unchanged" };
    try { return { status: "ok", value: JSON.parse(o.body), etag: o.etag }; } catch { return { status: "corrupt", etag: o.etag }; }
  }
  async putJSON(path, value, cond) {
    if (this.offline) throw new TypeError("offline");
    const o = this.objects.get(path);
    if (cond.ifNoneMatch && o) return { status: "conflict" };
    if (cond.ifMatch && (!o || o.etag !== cond.ifMatch)) return { status: "conflict" };
    const etag = "e" + ++this.seq; this.objects.set(path, { body: JSON.stringify(value), etag }); return { status: "ok", etag };
  }
  async remove(path) { this.objects.delete(path); }
  async putBlob(path, blob) { if (!this.objects.has(path)) this.objects.set(path, { body: await blob.arrayBuffer(), etag: "b" + ++this.seq, type: blob.type }); }
  async getBlob(path) { this.blobGets++; const o = this.objects.get(path); return new Blob([o.body], { type: o.type }); }
  records(store) { const out = {}; for (const [p, o] of this.objects) if (p.startsWith(`db/app/${store}/`)) Object.assign(out, JSON.parse(o.body).r); return out; }
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onabort = () => rej(tx.error); });

function device(M, remote, factory) {
  globalThis.indexedDB = factory;
  const events = new M.SDKEvents();
  let localWrites = 0;
  const engine = new M.SyncEngine({ remote, events, userId: () => "u1", onAuthChange: () => () => {}, factory },
    { pushDelayMs: 50, pullIntervalMs: 0, openTimeoutMs: 3000 });
  events.on("db:change", (c) => { if (c.source === "remote") { localWrites += c.keys.length; } });
  return {
    engine, get localWrites() { return localWrites; },
    open: () => new Promise((resolve, reject) => {
      const r = factory.open("app", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("notes", { keyPath: "id" }); r.result.createObjectStore("kv"); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    }),
    async write(db, store, fn) { const tx = db.transaction(store, "readwrite"); fn(tx.objectStore(store)); await done(tx); },
    async all(db, store) { return req(db.transaction(store).objectStore(store).getAll()); },
    dispose() { engine.dispose(); },
  };
}

test("0.19 data and 0.20 on the same device and across devices", { skip: !OLD }, async () => {
  const remote = new MemoryRemote();
  const F = new IDBFactory();
  // 1. Old SDK writes and pushes, then edits offline (left in the log).
  let A = device(OLD, remote, F);
  let db = await A.open();
  await A.write(db, "notes", (st) => { for (let i = 0; i < 20; i++) st.put({ id: "n" + i, i, ...(i === 3 ? { file: new Blob(["pic"], { type: "image/png" }) } : {}) }); });
  await A.write(db, "kv", (st) => st.put("dark", "theme"));
  await A.engine.now();
  assert.equal(Object.keys(remote.records("notes")).length, 20);
  remote.offline = true;
  await A.write(db, "notes", (st) => st.put({ id: "n1", i: 1, edited: "offline in 0.19" }));
  await A.engine.now();
  assert.ok(A.engine.status().pending > 0);
  db.close(); A.dispose();
  remote.offline = false;

  // 2. The same device reloads with 0.20.
  let N = device(NEW, remote, F);
  db = await N.open();
  assert.equal(remote.blobGets, 0, "no blob downloaded again");
  assert.ok(N.localWrites <= 1, `nothing rewritten locally but the pushed edit (${N.localWrites})`);
  assert.equal((await N.all(db, "notes")).length, 20);
  await N.engine.now();
  assert.equal(N.engine.status().pending, 0, "0.19's unsent edit went up");
  assert.equal(remote.records("notes")['"n1"'].v.edited, "offline in 0.19");
  assert.equal(remote.blobGets, 0);
  // 0.20 writes across shards (journal) and deletes.
  await N.write(db, "notes", (st) => { for (let i = 0; i < 20; i += 2) st.put({ id: "n" + i, i, by: "0.20" }); st.delete("n5"); });
  await N.engine.now();
  db.close(); N.dispose();

  // 3. A fresh device on the OLD SDK reads what 0.20 wrote.
  const C = device(OLD, remote, new IDBFactory());
  const dbC = await C.open();
  const notes = await C.all(dbC, "notes");
  assert.equal(notes.length, 19);
  assert.equal(notes.filter((n) => n.by === "0.20").length, 10);
  assert.ok((await C.all(dbC, "kv")).includes("dark"));
  const pic = notes.find((n) => n.id === "n3").file;
  assert.equal(await pic.text(), "pic");
  await C.write(dbC, "notes", (st) => st.put({ id: "from-old", v: 1 }));
  await C.engine.now();
  dbC.close(); C.dispose();

  // 4. The first device goes back to the old SDK (a tab not yet reloaded), then to 0.20 again.
  A = device(OLD, remote, F);
  db = await A.open();
  assert.ok((await A.all(db, "notes")).some((n) => n.id === "from-old"), "old SDK still works on the shared log");
  await A.write(db, "notes", (st) => st.put({ id: "old-again", v: 1 }));
  await A.engine.now();
  db.close(); A.dispose();
  N = device(NEW, remote, F);
  db = await N.open();
  await N.engine.now();
  const ids = (await N.all(db, "notes")).map((n) => n.id);
  assert.ok(ids.includes("from-old") && ids.includes("old-again") && !ids.includes("n5"));
  assert.equal(N.engine.status().state, "idle");
  db.close(); N.dispose();

  // 5. A fresh 0.20 device sees everything.
  const B = device(NEW, remote, new IDBFactory());
  const dbB = await B.open();
  const all = await B.all(dbB, "notes");
  assert.equal(all.length, 21);
  assert.equal(all.find((n) => n.id === "n1").edited, "offline in 0.19");
  dbB.close(); B.dispose();
});
