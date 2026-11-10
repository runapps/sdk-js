// RunApps Sync under random use: several devices write, edit, delete and
// clear at random while the network fails, answers get lost, pages
// reload mid-push, and sync files disappear from the cloud or are cut
// short. Whatever happened, once every device has synced in peace:
//   - they all hold the same records, and the cloud the same;
//   - a record only one device ever wrote is everywhere, with the last
//     value that device gave it.
//
// Seeds are fixed, so a failure can be run again: FUZZ_SEED=<n> for one
// seed, FUZZ_RUNS=<n> (from FUZZ_BASE, default 1000) for more of them,
// FUZZ_DEBUG=1 to print what each side holds when a run fails. Timing
// matters too (run a failing seed several times).

import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { SyncEngine, SDKEvents } from "../dist/index.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Cloud {
  constructor() {
    this.objects = new Map();
    this.seq = 0;
  }
  async list(prefix) {
    return [...this.objects.entries()].filter(([p]) => p.startsWith(prefix)).map(([path, o]) => ({ path, etag: o.etag }));
  }
  async getJSON(path, ifNoneMatch) {
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
    this.objects.delete(path);
  }
  async putJSON(path, value, cond) {
    const o = this.objects.get(path);
    if (cond.ifNoneMatch && o) return { status: "conflict" };
    if (cond.ifMatch && (!o || o.etag !== cond.ifMatch)) return { status: "conflict" };
    const etag = "e" + ++this.seq;
    this.objects.set(path, { body: JSON.stringify(value), etag });
    return { status: "ok", etag };
  }
  async putBlob() {}
  async getBlob() {
    throw new Error("no blobs here");
  }
  live(db, store) {
    const out = {};
    for (const [p, o] of this.objects) {
      if (!p.startsWith(`db/${db}/${store}/`)) continue;
      let s;
      try {
        s = JSON.parse(o.body);
      } catch {
        continue;
      }
      for (const [kid, rec] of Object.entries(s.r)) if (!rec.d) out[kid] = rec.v;
    }
    return out;
  }
}

/** One device's line to the cloud: it can be down, lose a request before
 *  it arrives, or lose the answer after the write was stored. */
function line(cloud, rand) {
  const l = { down: false, lossy: 0 };
  // The line of one page load. Once the page is gone nothing it asked
  // for ever answers, and nothing more leaves it: its code stops where
  // it stood.
  l.page = () => {
    const page = { gone: false };
    const never = new Promise(() => {});
    for (const m of ["list", "getJSON", "remove", "putBlob", "getBlob", "putJSON"]) {
      page[m] = async (...a) => {
        if (page.gone) return never;
        let out;
        try {
          out = await l[m](...a);
        } catch (e) {
          if (page.gone) return never;
          throw e;
        }
        return page.gone ? never : out;
      };
    }
    return page;
  };
  const maybe = (after) => {
    if (l.down) throw new TypeError("Failed to fetch");
    if (l.lossy && rand() < l.lossy) {
      const e = new TypeError("Failed to fetch");
      e.after = after && rand() < 0.5;
      throw e;
    }
  };
  l.list = async (p) => { maybe(); return cloud.list(p); };
  l.getJSON = async (...a) => { maybe(); return cloud.getJSON(...a); };
  l.remove = async (p) => { maybe(); return cloud.remove(p); };
  l.putBlob = async () => {};
  l.getBlob = async () => { throw new Error("no blobs here"); };
  l.putJSON = async (...a) => {
    try {
      maybe(true);
    } catch (e) {
      if (e.after) await cloud.putJSON(...a); // stored, but the answer never came
      throw e;
    }
    return cloud.putJSON(...a);
  };
  return l;
}

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); tx.onerror = () => rej(tx.error); });
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Device {
  constructor(cloud, rand, name) {
    this.name = name;
    this.factory = new IDBFactory();
    this.storage = new MemStorage();
    this.line = line(cloud, rand);
    this.db = null;
    this.engine = null;
  }
  async start() {
    globalThis.indexedDB = this.factory;
    this.engine = new SyncEngine(
      { remote: (this.page = this.line.page()), events: new SDKEvents(), userId: () => "u1", onAuthChange: () => () => {}, factory: this.factory, storage: this.storage },
      { pushDelayMs: 5, pullIntervalMs: 0, openTimeoutMs: 300, shards: 4, journalFoldAfterMs: 40, journalKeepMs: 80 },
    );
    this.db = await new Promise((resolve, reject) => {
      const r = this.factory.open("app", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("notes", { keyPath: "id" });
        r.result.createObjectStore("kv");
        r.result.createObjectStore("own", { keyPath: "id" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  /** The page goes away, whatever was in flight, and loads again. */
  async reload() {
    // The old page stops: no answer reaches it any more, and what it was
    // doing to its databases at that moment finishes or not, before the
    // new page starts (a browser never runs both).
    this.page.gone = true;
    this.db.close();
    this.engine.dispose();
    await sleep(8);
    await this.start();
  }
  async tx(store, fn) {
    const tx = this.db.transaction(store, "readwrite");
    fn(tx.objectStore(store));
    await done(tx);
  }
  async all(store) {
    const tx = this.db.transaction(store, "readonly");
    const st = tx.objectStore(store);
    const keys = await req(st.getAllKeys());
    const vals = await req(st.getAll());
    const out = {};
    keys.forEach((k, i) => (out[JSON.stringify(k)] = vals[i]));
    return out;
  }
  sync() {
    return this.engine.now();
  }
}

const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
function sortKeys(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}

async function run(seed, steps = 220) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const cloud = new Cloud();
  const devices = [];
  for (const n of ["A", "B", "C"]) {
    const d = new Device(cloud, rand, n);
    await d.start();
    devices.push(d);
  }
  const ids = Array.from({ length: 14 }, (_, i) => "n" + i);
  const fields = ["title", "body", "tag", "count"];
  let stamp = 0;
  // Records only one device ever writes, in a store nobody clears: no
  // conflict can explain losing one, so each must end everywhere with
  // the last value its device gave it.
  const expected = {};
  for (let i = 0; i < steps; i++) {
    const d = pick(devices);
    const x = rand();
    if (x < 0.12) {
      const id = `${d.name}-${Math.floor(rand() * 10)}`;
      const rec = { id, v: ++stamp, by: d.name };
      await d.tx("own", (st) => st.put(rec));
      expected[JSON.stringify(id)] = rec;
    } else if (x < 0.3) {
      const id = pick(ids);
      await d.tx("notes", (st) => st.put({ id, title: "t" + ++stamp, body: "b" + stamp, count: stamp }));
    } else if (x < 0.55) {
      // Edit one field of a record, the way an app does: read, change, put.
      const id = pick(ids);
      const f = pick(fields);
      await d.tx("notes", (st) => {
        const g = st.get(id);
        g.onsuccess = () => {
          if (g.result) st.put({ ...g.result, [f]: f + ++stamp });
        };
      });
    } else if (x < 0.65) {
      await d.tx("notes", (st) => st.delete(pick(ids)));
    } else if (x < 0.69) {
      await d.tx("kv", (st) => st.put({ v: ++stamp, list: [stamp] }, pick(["settings", "state", "recent"])));
    } else if (x < 0.705) {
      await d.tx("notes", (st) => st.clear());
    } else if (x < 0.715) {
      // A sync file is lost (the user deleted it in their storage).
      // ... or was cut short by a write that never finished.
      const shards = [...cloud.objects.keys()].filter((p) => !p.startsWith("db/@j/"));
      if (shards.length) {
        const p = pick(shards);
        if (rand() < 0.5) cloud.objects.delete(p);
        else cloud.objects.set(p, { body: cloud.objects.get(p).body.slice(0, 20), etag: "cut" + ++cloud.seq });
      }
    } else if (x < 0.78) {
      d.line.down = !d.line.down;
    } else if (x < 0.84) {
      d.line.lossy = d.line.lossy ? 0 : 0.3;
    } else if (x < 0.9) {
      // Leave mid-sync: start one and reload while it runs.
      void d.sync().catch(() => {}); // never answers: its page is about to go
      await sleep(rand() * 3);
      await d.reload();
    } else {
      await d.sync().catch(() => {});
    }
    if (rand() < 0.15) await sleep(rand() * 4);
  }
  // Peace: every device syncs until nothing moves. Journals left by
  // pushes that never finished are folded by whoever sees them old enough.
  for (const d of devices) {
    d.line.down = false;
    d.line.lossy = 0;
  }
  await sleep(60);
  for (let round = 0; round < 6; round++) {
    for (const d of devices) await d.sync();
    await sleep(30);
  }
  const report = { seed };
  try {
    for (const d of devices) {
      const s = d.engine.status();
      assert.equal(s.state, "idle", `${d.name} is ${s.state}: ${s.error ?? ""}`);
      assert.equal(s.pending, 0, `${d.name} has pending changes`);
      assert.equal(s.failed ?? 0, 0, `${d.name} set changes aside`);
    }
    for (const store of ["notes", "kv"]) {
      const cloudLive = canon(cloud.live("app", store));
      for (const d of devices) {
        const local = canon(await d.all(store));
        assert.equal(local, cloudLive, `${d.name}/${store} differs from the cloud (seed ${seed})`);
      }
    }
    for (const d of devices) {
      assert.equal(canon(await d.all("own")), canon(expected), `${d.name} lost a write nobody else touched (seed ${seed})`);
    }
    assert.equal(canon(cloud.live("app", "own")), canon(expected), `the cloud lost a write nobody else touched (seed ${seed})`);
    const left = [...cloud.objects.keys()].filter((p) => p.startsWith("db/@j/"));
    report.journalsLeft = left.length;
  } catch (e) {
    if (process.env.FUZZ_DEBUG) await dump(cloud, devices);
    throw e;
  } finally {
    for (const d of devices) {
      d.db.close();
      d.engine.dispose();
    }
  }
  return report;
}

/** What each side holds, for a failed run (FUZZ_DEBUG=1). */
async function dump(cloud, devices) {
  for (const store of ["notes", "kv", "own"]) {
    const recs = {};
    for (const [p, o] of cloud.objects) {
      if (!p.startsWith(`db/app/${store}/`)) continue;
      let sh;
      try {
        sh = JSON.parse(o.body);
      } catch {
        console.log("UNREADABLE", p);
        continue;
      }
      for (const [kid, rec] of Object.entries(sh.r)) recs[kid] = { ...rec, shard: p.split("/").pop(), cleared: sh.cleared };
    }
    const locals = [];
    for (const d of devices) locals.push(await d.all(store));
    const kids = new Set([...Object.keys(recs), ...locals.flatMap((l) => Object.keys(l))]);
    for (const kid of kids) {
      const c = recs[kid] && !recs[kid].d ? JSON.stringify(sortKeys(recs[kid].v)) : undefined;
      const ls = locals.map((l) => (l[kid] === undefined ? undefined : JSON.stringify(sortKeys(l[kid]))));
      if (ls.every((l) => l === c)) continue;
      console.log(`DIFF ${store} ${kid}\n  cloud: ${JSON.stringify(recs[kid])}`);
      for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        const sdb = await req(d.factory.open("__runapps_sync_state__"));
        const a = await req(sdb.transaction("applied").objectStore("applied").get(["app", store, kid]));
        sdb.close();
        console.log(`  ${d.name}: ${ls[i]}  applied=${JSON.stringify(a)}`);
      }
    }
  }
  console.log("journals:", [...cloud.objects.keys()].filter((p) => p.startsWith("db/@j/")));
}

const one = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : null;
const runs = Number(process.env.FUZZ_RUNS ?? 12);
const base = Number(process.env.FUZZ_BASE ?? 1000);
const seeds = one ?? Array.from({ length: runs }, (_, i) => base + i);

test("devices converge whatever the network and the reloads did", { timeout: 600_000 }, async () => {
  for (const seed of seeds) await run(seed);
});
