import { test } from "node:test";
import assert from "node:assert/strict";
import { RunApps } from "../dist/index.js";

const TOOLS = [
  { name: "web_fetch", description: "Read a page", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, price: 0.0005 },
  { name: "web_search", description: "Search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, price: 0.005 },
];

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const completion = (message, cost = 0.001) => ({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, total_cost: cost } });

/** A fake gateway: the tool list, tool calls, and chat replies in order. */
function gateway(replies, opts = {}) {
  const seen = { chats: [], tools: [], lists: 0 };
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/tools" && (!init || !init.method || init.method === "GET")) {
      seen.lists++;
      return json({ object: "list", data: TOOLS });
    }
    if (u.pathname.startsWith("/v1/tools/")) {
      const name = decodeURIComponent(u.pathname.slice("/v1/tools/".length));
      const args = JSON.parse(init.body);
      seen.tools.push({ name, args });
      if (opts.failTool === name) return json({ error: "fetching x: no such host" }, 502);
      return json({ name, content: `${name} result for ${JSON.stringify(args)}`, data: { ok: true }, usage: { total_cost: name === "web_search" ? 0.005 : 0.0005 } });
    }
    if (u.pathname === "/v1/chat/completions") {
      const body = JSON.parse(init.body);
      seen.chats.push(body);
      const r = replies.shift();
      if (body.stream) {
        const chunks = typeof r === "function" ? r() : r;
        const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return json(r);
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch, seen };
}

test("tools.list is cached; definitions are chat tools", async () => {
  const { fetch, seen } = gateway([]);
  const client = new RunApps({ apiKey: "k", baseURL: "https://t1.example", fetch });
  const a = await client.tools.list();
  const b = await client.tools.list();
  assert.equal(seen.lists, 1);
  assert.deepEqual(a, b);
  const defs = await client.tools.definitions(["web_search", "nope"]);
  assert.deepEqual(defs.map((d) => d.function.name), ["web_search"]);
  assert.equal(defs[0].type, "function");
});

test("web.search / web.fetch call the platform and return the data", async () => {
  const { fetch, seen } = gateway([]);
  const client = new RunApps({ apiKey: "k", baseURL: "https://t2.example", fetch });
  await client.web.fetch("https://go.dev", { maxChars: 100 });
  assert.deepEqual(seen.tools[0], { name: "web_fetch", args: { url: "https://go.dev", max_chars: 100 } });
});

test("chat.create with platformTools runs the calls, loops, and sums the cost", async () => {
  const { fetch, seen } = gateway([
    completion({ role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "web_search", arguments: '{"query":"go"}' } }] }),
    completion({ role: "assistant", content: "Go 1.26 is out." }),
  ]);
  const client = new RunApps({ apiKey: "k", baseURL: "https://t3.example", fetch });
  const events = [];
  const resp = await client.chat.create({
    model: "m",
    messages: [{ role: "user", content: "latest go?" }],
    tools: [{ type: "function", function: { name: "mine", parameters: { type: "object" } } }],
    platformTools: true,
    onToolCall: (e) => events.push(e.status),
  });
  assert.equal(resp.choices[0].message.content, "Go 1.26 is out.");
  assert.equal(seen.chats.length, 2);
  assert.equal(seen.chats[0].platformTools, undefined, "loop options never reach the gateway");
  assert.deepEqual(seen.chats[0].tools.map((t) => t.function.name), ["mine", "web_fetch", "web_search"]);
  assert.equal(seen.chats[1].messages.at(-1).role, "tool");
  assert.equal(seen.chats[1].messages.at(-1).tool_call_id, "t1");
  assert.deepEqual(events, ["running", "done"]);
  assert.deepEqual(resp.transcript.map((m) => m.role), ["assistant", "tool", "assistant"]);
  assert.ok(Math.abs(resp.usage.total_cost - 0.007) < 1e-9, String(resp.usage.total_cost));
  assert.deepEqual(resp.usage.tool_costs, [{ name: "web_search", count: 1, cost: 0.005 }]);
  assert.equal(resp.usage.total_tokens, 30);
});

test("chat.create stops on the caller's own tool and answers the platform calls beside it", async () => {
  const { fetch, seen } = gateway([
    completion({ role: "assistant", content: null, tool_calls: [
      { id: "a", type: "function", function: { name: "web_fetch", arguments: '{"url":"x"}' } },
      { id: "b", type: "function", function: { name: "mine", arguments: "{}" } },
    ] }),
  ], { failTool: "web_fetch" });
  const client = new RunApps({ apiKey: "k", baseURL: "https://t4.example", fetch });
  const resp = await client.chat.create({ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "mine" } }], platformTools: ["web_fetch"] });
  assert.equal(seen.chats.length, 1);
  assert.deepEqual(resp.transcript.map((m) => m.role), ["assistant", "tool"]);
  assert.match(resp.transcript[1].content, /^\[error\] fetching x/);
  assert.equal(resp.choices[0].message.tool_calls.length, 2);
});

test("chat.create's last round may not call tools", async () => {
  const call = () => completion({ role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "web_search", arguments: '{"query":"q"}' } }] });
  const { fetch, seen } = gateway([call(), call(), completion({ role: "assistant", content: "done" })]);
  const client = new RunApps({ apiKey: "k", baseURL: "https://t5.example", fetch });
  const resp = await client.chat.create({ model: "m", messages: [{ role: "user", content: "x" }], platformTools: true, maxToolRounds: 2 });
  assert.equal(seen.chats.length, 3);
  assert.equal(seen.chats[2].tool_choice, "none");
  assert.equal(resp.choices[0].message.content, "done");
});

test("chat.stream with platformTools hides the platform rounds' calls and streams every round's text", async () => {
  const chunk = (delta, finish = null, usage) => ({ id: "s", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
  const { fetch, seen } = gateway([
    [
      chunk({ role: "assistant", content: "Let me look. " }),
      chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "web_search", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":"go"}' } }] }),
      chunk({}, "tool_calls"),
      { id: "s", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { total_cost: 0.001 } },
    ],
    [
      chunk({ content: "Go 1.26." }),
      chunk({}, "stop"),
      { id: "s", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { total_cost: 0.002 } },
    ],
  ]);
  const client = new RunApps({ apiKey: "k", baseURL: "https://t6.example", fetch });
  let text = "";
  const finishes = [];
  let toolDeltas = 0;
  let final;
  for await (const c of client.chat.stream({ model: "m", messages: [{ role: "user", content: "x" }], platformTools: true })) {
    const ch = c.choices[0];
    if (ch) {
      text += ch.delta.content ?? "";
      if (ch.finish_reason) finishes.push(ch.finish_reason);
      if (ch.delta.tool_calls) toolDeltas++;
    }
    if (c.usage) final = c;
  }
  assert.equal(text, "Let me look. Go 1.26.");
  assert.deepEqual(finishes, ["stop"]);
  assert.equal(toolDeltas, 0);
  assert.equal(seen.tools[0].name, "web_search");
  assert.deepEqual(seen.tools[0].args, { query: "go" });
  assert.ok(Math.abs(final.usage.total_cost - 0.008) < 1e-9);
  assert.deepEqual(final.transcript.map((m) => m.role), ["assistant", "tool", "assistant"]);
  assert.equal(final.transcript[0].tool_calls[0].function.arguments, '{"query":"go"}');
});
