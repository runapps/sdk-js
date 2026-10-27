// App handoff (src/apps.ts): the wire format, the checks a receiving app
// relies on, and how an inbox entry reaches exactly one tab.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppsService,
  encodeHandoff,
  decodeHandoff,
  parseHandoffPayload,
  appSlugOf,
  appOriginFrom,
  isAppOrigin,
  isFilesURL,
} from "../dist/index.js";

const signed = "https://files.runapps.ai/f/AbC123_-xyz/clip.mp4";
const good = {
  v: 2,
  id: "0123456789abcdef01234567",
  from: "infinite-canvas",
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

test("a handoff with a bad version, id, slug, action or file is refused", () => {
  const bad = [
    { ...good, v: 1 },
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

test("file names are made safe", () => {
  const p = parseHandoffPayload({ ...good, files: [{ url: signed, name: "../../etc/passwd\u0000", type: "video/mp4" }] }, false);
  assert.equal(p.files[0].name, ".._.._etc_passwd_");
});

test("local links are accepted only on a local page", () => {
  const local = { ...good, files: [{ url: "http://localhost:8080/f/tok/clip.mp4", name: "clip.mp4" }] };
  assert.equal(parseHandoffPayload(local, false), null);
  assert.ok(parseHandoffPayload(local, true));
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

// ── The inbox, with the app open in several tabs ────────────────────────
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
  const svc = new AppsService({}, {}, "video-studio", () => true);
  svc.handlers.push(handler); // onReceive without the start-up sweep
  return svc;
}

// What the inbox page writes.
function arrive(id, payload = good) {
  localStorage.setItem("runapps_inbox:" + id, JSON.stringify({ payload: { ...payload, id }, received_at: Date.now() }));
}

const quiet = async (fn) => {
  const warn = console.warn; console.warn = () => {};
  try { await fn(); } finally { console.warn = warn; }
};

test("waiting() lists what arrived, without taking it", () => {
  sharedBrowser();
  const id = "dddddddddddddddddddddddd";
  arrive(id);
  const t = new AppsService({}, {}, "video-studio", () => true);
  assert.deepEqual(t.waiting().map((w) => [w.id, w.from, w.files.length]), [[id, "infinite-canvas", 1]]);
  assert.equal(t.waiting().length, 1);
});

test("with two tabs open, a handoff is taken once", async () => {
  sharedBrowser();
  const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
  let taken = 0;
  const slow = async () => { taken++; await new Promise((r) => setTimeout(r, 20)); };
  const a = tab(slow), b = tab(slow);
  arrive(id);
  await Promise.all([a.deliver(id), b.deliver(id)]); // both tabs hear of it
  assert.equal(taken, 1);
  assert.equal(localStorage.getItem("runapps_inbox:" + id), null);
});

test("a tab that cannot take it passes the handoff to the next", async () => {
  sharedBrowser();
  const id = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const seen = [];
  const busy = tab(async () => { seen.push("a"); throw new Error("no document open"); });
  const ready = tab(async (h) => { seen.push("b:" + h.from + ":" + h.files[0].name); });
  arrive(id);
  await quiet(() => Promise.all([busy.deliver(id), ready.deliver(id)]));
  assert.deepEqual(seen, ["a", "b:infinite-canvas:clip.mp4"]);
  assert.equal(ready.waiting().length, 0);
});

test("a handoff nobody can take stays for later; a broken one is dropped", async () => {
  sharedBrowser();
  const keep = "cccccccccccccccccccccccc";
  const broken = "eeeeeeeeeeeeeeeeeeeeeeee";
  const t = tab(async () => { throw new Error("not now"); });
  arrive(keep);
  arrive(broken, { ...good, files: [{ url: "https://evil.example/x", name: "x" }] });
  await quiet(() => Promise.all([t.deliver(keep), t.deliver(broken)]));
  assert.notEqual(localStorage.getItem("runapps_inbox:" + keep), null);
  assert.equal(localStorage.getItem("runapps_inbox:" + broken), null);
});

test("'later' keeps it, skips the other tabs now, and offers it at the next start", async () => {
  sharedBrowser();
  const id = "ffffffffffffffffffffffff";
  const seen = [];
  const a = tab(async () => { seen.push("a"); return "later"; });
  const b = tab(async () => { seen.push("b"); });
  arrive(id);
  await a.deliver(id);            // live arrival in tab a: put off
  await b.deliver(id);            // the storage event reaches tab b: not asked again
  assert.deepEqual(seen, ["a"]);
  assert.equal(b.waiting().length, 1);
  await b.deliver(id, true);      // tab b starting up: offered again, taken
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(b.waiting().length, 0);
});

test("'pass' leaves it for another tab without putting it off", async () => {
  sharedBrowser();
  const id = "gggggggggggggggggggggggg";
  const seen = [];
  const list = tab(async () => { seen.push("list"); return "pass"; });
  const editor = tab(async () => { seen.push("editor"); });
  arrive(id);
  await Promise.all([list.deliver(id), editor.deliver(id)]);
  assert.deepEqual(seen, ["list", "editor"]);
  assert.equal(editor.waiting().length, 0);
});

test("dismiss removes an entry", () => {
  sharedBrowser();
  const id = "hhhhhhhhhhhhhhhhhhhhhhhh";
  arrive(id);
  const t = new AppsService({}, {}, "video-studio", () => true);
  t.dismiss(id);
  assert.equal(t.waiting().length, 0);
});
