import { test } from "node:test";
import assert from "node:assert/strict";
import { RunApps, parseJSONLoose } from "../dist/index.js";

test("parseJSONLoose — fences, surrounding prose, trailing commas, comments, curly quotes", () => {
  assert.deepEqual(parseJSONLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJSONLoose('Here you go:\n```json\n{"a": [1,2,],}\n```\nDone.'), { a: [1, 2] });
  assert.deepEqual(parseJSONLoose('{ // note\n "a": "x" /* c */ }'), { a: "x" });
  assert.deepEqual(parseJSONLoose("{“a”: “b”}"), { a: "b" });
  assert.deepEqual(parseJSONLoose("[1, 2, 3]"), [1, 2, 3]);
  assert.equal(parseJSONLoose("no json here"), undefined);
  assert.deepEqual(parseJSONLoose('{"url":"http://x/y","q":"a//b"}'), { url: "http://x/y", q: "a//b" });
});

test("chat.structured — sends json_schema and parses a fenced reply", async () => {
  let body;
  const client = new RunApps({
    apiKey: "k",
    fetch: async (_u, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "```json\n{\"city\":\"Paris\",}\n```" }, finish_reason: "stop" }], usage: { total_cost: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const { value } = await client.chat.structured({ model: "m", messages: [{ role: "user", content: "x" }] }, { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false });
  assert.deepEqual(value, { city: "Paris" });
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.stream, false);
});
