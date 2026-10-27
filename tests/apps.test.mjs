// App handoff (src/apps.ts): the wire format and the checks a receiving
// app and the sender's result handling rely on.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppsService,
  encodeHandoff,
  decodeHandoff,
  parseHandoffPayload,
  parseResultPayload,
  appSlugOf,
  appOriginFrom,
  isAppOrigin,
  isFilesURL,
} from "../dist/index.js";

const signed = "https://files.runapps.ai/f/AbC123_-xyz/clip.mp4";
const good = {
  v: 1,
  id: "0123456789abcdef01234567",
  from: "infinite-canvas",
  reply_to: "https://infinite-canvas.runapps.dev",
  action: "edit",
  files: [{ url: signed, name: "clip.mp4", type: "video/mp4", size: 1234 }],
};

test("encode/decode round-trips JSON with non-ASCII text, URL-safe", () => {
  const obj = { ...good, files: [{ ...good.files[0], name: "片段 一.mp4" }] };
  const s = encodeHandoff(obj);
  assert.match(s, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeHandoff(s), obj);
});

test("a well-formed handoff is accepted as sent", () => {
  assert.deepEqual(parseHandoffPayload(good, false), good);
});

test("a handoff with a bad id, slug, action or file is refused", () => {
  const bad = [
    { ...good, v: 2 },
    { ...good, id: "short" },
    { ...good, id: "has space in it!" },
    { ...good, from: "Not_A_Slug" },
    { ...good, action: "delete" },
    { ...good, files: [] },
    { ...good, files: [{ url: "https://evil.example/x.mp4", name: "x" }] },
    { ...good, files: [{ url: "javascript:alert(1)", name: "x" }] },
    { ...good, files: Array.from({ length: 21 }, () => good.files[0]) },
  ];
  for (const p of bad) assert.equal(parseHandoffPayload(p, false), null, JSON.stringify(p));
});

test("reply_to must be the sender's own app origin", () => {
  for (const reply_to of [
    "https://evil.example",
    "https://other-app.runapps.dev",          // not the sender
    "http://infinite-canvas.runapps.dev",     // not https
    "https://infinite-canvas.runapps.dev/x",  // not an origin
  ]) {
    const p = parseHandoffPayload({ ...good, reply_to }, false);
    assert.ok(p, reply_to);
    assert.equal(p.reply_to, undefined, reply_to);
  }
});

test("file names are made safe", () => {
  const p = parseHandoffPayload({ ...good, files: [{ url: signed, name: "../../etc/passwd\u0000", type: "video/mp4" }] }, false);
  assert.equal(p.files[0].name, ".._.._etc_passwd_");
});

test("local links are accepted only on a local page", () => {
  const local = { ...good, reply_to: "http://infinite-canvas.localhost:8080", files: [{ url: "http://localhost:8080/f/tok/clip.mp4", name: "clip.mp4" }] };
  assert.equal(parseHandoffPayload(local, false), null);
  const p = parseHandoffPayload(local, true);
  assert.ok(p);
  assert.equal(p.reply_to, "http://infinite-canvas.localhost:8080");
});

test("results are checked like handoffs", () => {
  const r = { v: 1, id: good.id, from: "video-studio", files: good.files };
  assert.deepEqual(parseResultPayload(r, false), r);
  assert.equal(parseResultPayload({ ...r, files: [{ url: "https://evil.example/a", name: "a" }] }, false), null);
  assert.equal(parseResultPayload({ ...r, id: "x" }, false), null);
});

test("app hosts and origins", () => {
  assert.equal(appSlugOf("video-studio.runapps.dev"), "video-studio");
  assert.equal(appSlugOf("video-studio.localhost"), "video-studio");
  assert.equal(appSlugOf("www.runapps.ai"), "");
  assert.equal(appSlugOf("localhost"), "");
  assert.equal(appOriginFrom("https://infinite-canvas.runapps.dev", "video-studio"), "https://video-studio.runapps.dev");
  assert.equal(appOriginFrom("http://infinite-canvas.localhost:8080", "video-studio"), "http://video-studio.localhost:8080");
  assert.equal(isAppOrigin("https://a-b.runapps.dev"), true);
  assert.equal(isAppOrigin("https://a.b.runapps.dev"), false);
  assert.equal(isFilesURL("https://files.runapps.ai/s/abc.png", false), true);
  assert.equal(isFilesURL("https://files.runapps.ai/u/abc/files/x", false), false);
});

// ── Several tabs of the sending app ─────────────────────────────────────
// The tabs share localStorage and Web Locks; each has its own service.
function sharedBrowser() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const queues = new Map();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(name, cb) {
          const prev = queues.get(name) ?? Promise.resolve();
          const run = prev.then(() => cb());
          queues.set(name, run.catch(() => {}));
          return run;
        },
      },
    },
  });
  globalThis.window = { addEventListener() {} };
  return store;
}

function tab(handler) {
  const svc = new AppsService({}, {}, "infinite-canvas", () => true, null);
  svc.onResult(handler);
  return svc;
}

function storeResult(id) {
  localStorage.setItem("runapps_handoff:" + id, JSON.stringify({ to: "video-studio", action: "edit", context: { node: "n1" }, at: Date.now() }));
  localStorage.setItem("runapps_handoff_result:" + id, JSON.stringify({ v: 1, id, from: "video-studio", files: [{ url: signed, name: "e.mp4", type: "video/mp4" }], received_at: Date.now() }));
}

test("with two tabs open, a result is applied once", async () => {
  sharedBrowser();
  const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
  let applied = 0;
  const slow = async () => { applied++; await new Promise((r) => setTimeout(r, 20)); };
  const a = tab(slow), b = tab(slow);
  storeResult(id);
  await Promise.all([a.deliver(id), b.deliver(id)]); // the storage event reaches both
  assert.equal(applied, 1);
  assert.equal(localStorage.getItem("runapps_handoff_result:" + id), null);
  assert.equal(a.isPending(id), false);
});

test("a tab that cannot apply it passes the result to the next", async () => {
  sharedBrowser();
  const id = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const seen = [];
  const wrongProject = tab(async () => { seen.push("a"); throw new Error("project not open"); });
  const rightProject = tab(async (r) => { seen.push("b:" + r.context.node); });
  storeResult(id);
  const warn = console.warn; console.warn = () => {};
  try {
    await Promise.all([wrongProject.deliver(id), rightProject.deliver(id)]);
  } finally { console.warn = warn; }
  assert.deepEqual(seen, ["a", "b:n1"]);
  assert.equal(rightProject.isPending(id), false);
});

test("a result nobody can apply stays for later", async () => {
  sharedBrowser();
  const id = "cccccccccccccccccccccccc";
  const t = tab(async () => { throw new Error("not now"); });
  storeResult(id);
  const warn = console.warn; console.warn = () => {};
  try { await t.deliver(id); } finally { console.warn = warn; }
  assert.equal(t.isPending(id), true);
  assert.notEqual(localStorage.getItem("runapps_handoff_result:" + id), null);
});
