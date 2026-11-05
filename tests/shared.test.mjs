// The public folder must be readable before anyone has signed in: reads
// carry no credentials and never touch the token resolver.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunApps } from "../dist/index.js";

function client(calls, respond = () => new Response("{}", { status: 200 }), resolver) {
  return new RunApps({
    apiKeyResolver: resolver ?? (() => { throw new Error("a public read asked for a token"); }),
    baseURL: "https://www.runapps.ai",
    project: "canvas",
    filesBase: false,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init);
    },
  });
}

test("reads go out with no credentials and no sign-in", async () => {
  const calls = [];
  const c = client(calls, () => new Response('[{"id":1}]', { status: 200 }));
  assert.deepEqual(await c.shared.json("templates/index.json"), [{ id: 1 }]);
  assert.equal(calls[0].url, "https://www.runapps.ai/v1/apps/canvas/public/templates/index.json");
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[0].init.cache, undefined, "left to the HTTP cache, which revalidates by ETag");
});

test("paths are encoded segment by segment", () => {
  const c = client([]);
  assert.equal(c.shared.url("/a b/c#d.png"), "https://www.runapps.ai/v1/apps/canvas/public/a%20b/c%23d.png");
});

test("of() reads another app's folder", () => {
  const c = client([]);
  assert.equal(c.shared.of("skill-hub").url("x.zip"), "https://www.runapps.ai/v1/apps/skill-hub/public/x.zip");
});

test("list passes its options", async () => {
  const calls = [];
  const c = client(calls, () => new Response('{"files":[]}', { status: 200 }));
  assert.deepEqual(await c.shared.list({ prefix: "templates/", limit: 5 }), { files: [] });
  assert.equal(calls[0].url, "https://www.runapps.ai/v1/apps/canvas/public?prefix=templates%2F&limit=5");
});

test("a missing file is an error, not an empty body", async () => {
  const c = client([], () => new Response('{"error":"not found"}', { status: 404 }));
  await assert.rejects(() => c.shared.get("nope"), (e) => e.statusCode === 404);
});

test("publishing writes under _public/ with the caller's token", async () => {
  const calls = [];
  const c = client(calls, () => new Response('{"path":"_public/a.json","size":2,"url":"u"}', { status: 200 }), () => "rrt_x");
  await c.shared.put("a.json", "{}", { ifMatch: "E1" });
  const put = calls.find((x) => x.init.method === "PUT");
  assert.equal(put.url, "https://www.runapps.ai/v1/p/canvas/files/_public/a.json");
  assert.equal(put.init.headers.Authorization, "Bearer rrt_x");
  assert.equal(put.init.headers["If-Match"], '"E1"');
});

test("copy asks the platform to fetch the public URL", async () => {
  const calls = [];
  const c = client(calls, () => new Response('{"path":"my/a.png","size":1,"url":"u"}', { status: 200 }), () => "rrt_x");
  await c.shared.copy("a.png", "my/a.png");
  const post = calls.find((x) => x.url.endsWith("/put-url"));
  assert.deepEqual(JSON.parse(post.init.body), {
    path: "my/a.png",
    src_url: "https://www.runapps.ai/v1/apps/canvas/public/a.png",
  });
});

test("canPublish reads is_creator for this app", async () => {
  const calls = [];
  const c = client(calls, () => new Response('{"is_creator":true}', { status: 200 }), () => "rrt_x");
  assert.equal(await c.shared.canPublish(), true);
  assert.equal(calls[0].url, "https://www.runapps.ai/v1/me?app=canvas");
});
