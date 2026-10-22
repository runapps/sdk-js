// client.me() and client.assets.verify(): the paths they call and how a
// gated or busy answer surfaces (APIError.code / retryAfter).

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunApps, APIError } from "../dist/index.js";

function clientAnswering(status, body, headers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  };
  return { client: new RunApps({ apiKey: "rk_test", baseURL: "https://gw.test", fetch }), calls };
}

test("me() reads the caller's features", async () => {
  const { client, calls } = clientAnswering(200, { id: "u1", name: "Ann", features: ["seedance_asset_verify"] });
  const me = await client.me();
  assert.deepEqual(me.features, ["seedance_asset_verify"]);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "https://gw.test/v1/me");
});

test("assets.verify posts the picture and returns its asset", async () => {
  const { client, calls } = clientAnswering(200, { status: "active", asset: "asset://asset-1", asset_id: "asset-1", faces: 1 });
  const r = await client.assets.verify("https://x/face.png");
  assert.equal(r.asset, "asset://asset-1");
  assert.equal(calls[0].url, "https://gw.test/v1/assets/verify");
  assert.deepEqual(JSON.parse(calls[0].body), { url: "https://x/face.png" });
});

test("a busy pool is an APIError with code and retryAfter", async () => {
  const { client } = clientAnswering(429, { error: "the Seedance asset pool is busy, retry later", code: "busy", retry_after: 20 }, { "Retry-After": "20" });
  await assert.rejects(client.assets.verify("https://x/face.png"), (e) => {
    assert.ok(e instanceof APIError);
    assert.equal(e.statusCode, 429);
    assert.equal(e.code, "busy");
    assert.equal(e.retryAfter, 20);
    return true;
  });
});

test("a user without the feature gets code feature_not_enabled", async () => {
  const { client } = clientAnswering(403, { error: "not enabled", code: "feature_not_enabled" });
  await assert.rejects(client.assets.verify("https://x/face.png"), (e) => e.code === "feature_not_enabled" && e.retryAfter === undefined);
});
