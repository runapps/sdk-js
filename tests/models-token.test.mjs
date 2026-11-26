// models.list() is public: it never fetches a token (a signed-out browser
// user is not sent to sign in just to read the catalogue), but a token the
// client already holds goes along, so the gateway can add the models an
// admin opened to that user only. Runs against the compiled dist/ build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunApps } from "../dist/index.js";

function capture() {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    return new Response(JSON.stringify({ object: "list", data: [{ id: "Mine", capability: "text" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { seen, fetch };
}

test("models.list sends a static key", async () => {
  const { seen, fetch } = capture();
  const client = new RunApps({ apiKey: "rk_test", baseURL: "https://gw.test", fetch });
  const list = await client.models.list({ capability: "text" });
  assert.equal(list[0].id, "Mine");
  assert.equal(seen[0].url, "https://gw.test/v1/models?capability=text");
  assert.equal(seen[0].auth, "Bearer rk_test");
});

test("models.list never calls a token resolver", async () => {
  const { seen, fetch } = capture();
  let asked = 0;
  const client = new RunApps({
    apiKeyResolver: () => {
      asked++;
      return "rrt_x";
    },
    baseURL: "https://gw.test",
    fetch,
  });
  await client.models.list();
  assert.equal(asked, 0);
  assert.equal(seen[0].auth, null);
});
