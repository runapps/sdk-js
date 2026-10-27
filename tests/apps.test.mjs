// App handoff (src/apps.ts): the wire format and the checks a receiving
// app and the sender's result handling rely on.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
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
