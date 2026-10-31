// A call that leaves `model` out lets the gateway choose; the badge used
// to print "undefined" for it. Now the start event says "default model"
// and the end event carries the catalogue name the response reports.
// Runs against the COMPILED dist/ build, like events.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunJobs } from "../dist/index.js";

function sseFetch(lines) {
  return async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(new TextEncoder().encode(l));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
}

function jsonFetch(body) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function record(client) {
  const events = [];
  for (const k of ["request:start", "request:end", "request:error"]) {
    client.events.on(k, (e) => events.push([k, e.model]));
  }
  return events;
}

test("chat.create without model — events name the model the response reports", async () => {
  const client = new RunJobs({
    apiKey: "gw-test",
    fetch: jsonFetch({
      id: "c1", object: "chat.completion", created: 0, model: "DeepSeek",
      choices: [{ index: 0, message: { role: "assistant", content: "2" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, total_cost: 0.0001 },
    }),
  });
  const events = record(client);
  await client.chat.create({ messages: [{ role: "user", content: "1+1=?" }] });
  assert.deepEqual(events, [
    ["request:start", "default model"],
    ["request:end", "DeepSeek"],
  ]);
});

test("chat.stream without model — the end event takes the chunks' model", async () => {
  const client = new RunJobs({
    apiKey: "gw-test",
    fetch: sseFetch([
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"DeepSeek","choices":[{"index":0,"delta":{"content":"2"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"DeepSeek","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"total_cost":0.0001}}\n\n',
      "data: [DONE]\n\n",
    ]),
  });
  const events = record(client);
  for await (const _ of client.chat.stream({ messages: [{ role: "user", content: "1+1=?" }] })) {
    // drain
  }
  assert.deepEqual(events, [
    ["request:start", "default model"],
    ["request:end", "DeepSeek"],
  ]);
});

test("chat.create with a model — events keep the name the caller used", async () => {
  const client = new RunJobs({
    apiKey: "gw-test",
    fetch: jsonFetch({
      id: "c1", object: "chat.completion", created: 0, model: "deepseek-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "2" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, total_cost: 0.0001 },
    }),
  });
  const events = record(client);
  await client.chat.create({ model: "DeepSeek", messages: [{ role: "user", content: "1+1=?" }] });
  assert.deepEqual(events, [
    ["request:start", "DeepSeek"],
    ["request:end", "DeepSeek"],
  ]);
});
