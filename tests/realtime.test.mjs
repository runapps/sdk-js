// Realtime voice sessions (client.realtime) against a scripted fake
// WebSocket, plus transcription by URL.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunApps, pcm16FromFloat32, float32FromPCM16, bytesToBase64, base64ToBytes } from "../dist/index.js";

// FakeWebSocket records what the SDK sends and lets the test play the
// server. `script(ws, event)` answers each parsed client event.
function fakeWebSocket(script) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.sent = [];
      this.listeners = {};
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.emit("open", {});
      }, 0);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type, ev) {
      for (const fn of this.listeners[type] ?? []) fn(ev);
    }
    send(data) {
      const event = JSON.parse(data);
      this.sent.push(event);
      script?.(this, event);
    }
    serverSend(event) {
      this.emit("message", { data: JSON.stringify(event) });
    }
    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.emit("close", { code, reason }), 0);
    }
  }
  return { FakeWebSocket, sockets };
}

// A server that opens the session, answers say() with a turn, and on
// session.close reports usage then hangs up.
const doubaoLike = (ws, event) => {
  switch (event.type) {
    case "session.create":
      ws.serverSend({ type: "session.created", session: { id: "sess-42" } });
      break;
    case "speech_text_buffer.commit":
      ws.serverSend({ type: "response.output_text.done", text: event.text });
      ws.serverSend({ type: "response.output_audio.delta", delta: "AAABAA==" });
      ws.serverSend({ type: "response.done", response: { usage: { output_tokens: 30 } } });
      break;
    case "session.close":
      ws.serverSend({ type: "session.closed" });
      ws.serverSend({ type: "gateway.usage", usage: { input_tokens: 0, output_tokens: 30, seconds: 2.5, total_cost: 0.0027 } });
      ws.close(1000, "session completed");
      break;
  }
};

test("realtime.connect authenticates by subprotocol and opens with session.create", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocket(doubaoLike);
  const client = new RunApps({ apiKey: "rk_test123" });
  const session = await client.realtime.connect({
    model: "Doubao Realtime Voice",
    session: { instructions: "be brief", audio: { output: { voice: "v1" } } },
    extension: { dialog: { extra: { strict_audit: false } } },
    query: { lang: "zh" },
    maxCost: 0.5,
    WebSocket: FakeWebSocket,
  });
  const ws = sockets[0];
  const url = new URL(ws.url);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.host, "www.runapps.ai");
  assert.equal(url.pathname, "/v1/realtime");
  assert.equal(url.searchParams.get("model"), "Doubao Realtime Voice");
  assert.equal(url.searchParams.get("lang"), "zh");
  assert.equal(url.searchParams.get("max_cost"), "0.5");
  assert.deepEqual(ws.protocols, ["realtime", "runapps-key.rk_test123"]);
  assert.equal(ws.sent[0].type, "session.create");
  assert.equal(ws.sent[0].session.instructions, "be brief");
  assert.equal(ws.sent[0].extension.dialog.extra.strict_audit, false);
  assert.equal(session.sessionId, "sess-42");
  await session.close();
});

test("a session streams events to handlers and close() resolves with the cost", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocket(doubaoLike);
  const client = new RunApps({ apiKey: "rk_test123", baseURL: "http://localhost:8080" });
  const ended = [];
  client.events.on("request:end", (e) => ended.push(e));
  const session = await client.realtime.connect({ WebSocket: FakeWebSocket });
  assert.ok(sockets[0].url.startsWith("ws://localhost:8080/v1/realtime"));

  const texts = [];
  const audio = [];
  const all = [];
  session.on("response.output_text.done", (e) => texts.push(e.text));
  session.on("response.output_audio.delta", (e) => audio.push(base64ToBytes(e.delta)));
  session.on("*", (e) => all.push(e.type));
  session.say("你好");

  const info = await session.close();
  assert.deepEqual(texts, ["你好"]);
  assert.deepEqual([...audio[0]], [0, 0, 1, 0]);
  assert.ok(all.includes("response.done"));
  assert.equal(info.code, 1000);
  assert.equal(info.usage.total_cost, 0.0027);
  assert.equal(sockets[0].sent.at(-1).type, "session.close");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ended.length, 1);
  assert.equal(ended[0].capability, "realtime");
  assert.equal(ended[0].costUSD, 0.0027);
});

test("appendAudio sends base64 PCM16 and the session is async-iterable", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocket(doubaoLike);
  const client = new RunApps({ apiKey: "rk_x" });
  const session = await client.realtime.connect({ WebSocket: FakeWebSocket });
  session.appendAudio(new Int16Array([1, -1]));
  const sent = sockets[0].sent.at(-1);
  assert.equal(sent.type, "input_audio_buffer.append");
  assert.deepEqual([...base64ToBytes(sent.audio)], [1, 0, 0xff, 0xff]);

  const seen = [];
  const loop = (async () => {
    for await (const ev of session) seen.push(ev.type);
  })();
  session.say("hi");
  await session.close();
  await loop;
  assert.deepEqual(seen.slice(0, 3), ["response.output_text.done", "response.output_audio.delta", "response.done"]);
  assert.ok(seen.includes("gateway.usage"));
});

test("connect rejects when the socket closes before the session opens", async () => {
  const { FakeWebSocket } = fakeWebSocket((ws, event) => {
    if (event.type === "session.create") ws.close(4401, "invalid API key");
  });
  const client = new RunApps({ apiKey: "rk_bad" });
  const errors = [];
  client.events.on("request:error", (e) => errors.push(e));
  await assert.rejects(client.realtime.connect({ WebSocket: FakeWebSocket }), /closed \(4401 invalid API key\)/);
  assert.equal(errors.length, 1);
});

test("connect rejects on an error event before session.created", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocket((ws, event) => {
    if (event.type === "session.create") {
      ws.serverSend({ type: "error", error: { code: "upstream_connect_failed", message: "could not reach Volcengine" } });
    }
  });
  const client = new RunApps({ apiKey: "rk_x" });
  await assert.rejects(client.realtime.connect({ WebSocket: FakeWebSocket }), /could not reach Volcengine/);
  assert.equal(sockets[0].readyState, 3, "the failed socket is closed");
});

test("PCM helpers convert and resample", () => {
  const pcm = pcm16FromFloat32(new Float32Array([0, 1, -1, 0.5]), 16000);
  assert.deepEqual([...pcm], [0, 32767, -32768, 16383]);
  const down = pcm16FromFloat32(new Float32Array(480), 48000);
  assert.equal(down.length, 160, "48 kHz → 16 kHz keeps a third of the samples");
  const back = float32FromPCM16(new Uint8Array([0, 0x80, 0xff, 0x7f]));
  assert.equal(back[0], -1);
  assert.ok(Math.abs(back[1] - 1) < 1e-4);
  assert.equal(bytesToBase64(new Uint8Array([104, 105])), "aGk=");
});

test("transcribe accepts a url instead of a file", async () => {
  let form;
  const client = new RunApps({
    apiKey: "rk_x",
    fetch: async (_url, init) => {
      form = init.body;
      return new Response(JSON.stringify({ text: "你好", usage: { total_cost: 0.0007 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const r = await client.audio.transcribe("Doubao ASR 2.0", { url: "https://cdn.example.com/a.mp3", language: "zh-CN" });
  assert.equal(r.text, "你好");
  assert.equal(form.get("url"), "https://cdn.example.com/a.mp3");
  assert.equal(form.get("file"), null);
  assert.equal(form.get("language"), "zh-CN");
  await assert.rejects(client.audio.transcribe("m", {}), /needs `file` or `url`/);
});

test("a session cut by its spending cap closes with 4402 and still reports the cost", async () => {
  const { FakeWebSocket } = fakeWebSocket((ws, event) => {
    if (event.type === "session.create") ws.serverSend({ type: "session.created", session: { id: "s" } });
    if (event.type === "speech_text_buffer.commit") {
      ws.serverSend({ type: "gateway.usage", usage: { total_cost: 0.1 } });
      ws.close(4402, "spending cap reached");
    }
  });
  const client = new RunApps({ apiKey: "rk_x" });
  const session = await client.realtime.connect({ WebSocket: FakeWebSocket, maxCost: 0.1 });
  session.say("hi");
  const info = await session.closed;
  assert.equal(info.code, 4402);
  assert.equal(info.reason, "spending cap reached");
  assert.equal(info.usage.total_cost, 0.1);
});

// A streaming TTS server like the gateway's volc_tts plugin: text pieces
// join the open response; each commit ends one, and committed responses
// play one after another; response.cancel stops the open one and drops
// the queue.
function ttsLike() {
  let n = 0;
  let cur = null; // {id, text, committed}
  const queue = [];
  const finish = (ws, status) => {
    ws.serverSend({ type: "response.output_audio.delta", response_id: cur.id, delta: "AAABAA==" });
    ws.serverSend({ type: "response.output_audio_transcript.delta", response_id: cur.id, delta: cur.text });
    ws.serverSend({ type: "response.done", response: { id: cur.id, status, usage: { characters: [...cur.text].length } } });
    cur = null;
    const next = queue.shift();
    if (next) open(ws, next);
  };
  const open = (ws, r) => {
    cur = r;
    ws.serverSend({ type: "response.created", response: { id: r.id } });
    if (r.committed) setTimeout(() => cur === r && finish(ws, "completed"), 5);
  };
  return (ws, event) => {
    switch (event.type) {
      case "session.create":
        ws.serverSend({ type: "session.created", session: { id: "tts-1", mode: "tts", voice: "v" } });
        break;
      case "input_text.append": {
        const last = queue[queue.length - 1];
        if (last && !last.committed) last.text += event.text;
        else if (cur && !cur.committed) cur.text += event.text;
        else if (cur) queue.push({ id: `r${++n}`, text: event.text, committed: false });
        else open(ws, { id: `r${++n}`, text: event.text, committed: false });
        break;
      }
      case "input_text.commit": {
        const last = queue[queue.length - 1];
        if (last) last.committed = true;
        else if (cur && !cur.committed) {
          cur.committed = true;
          const r = cur;
          setTimeout(() => cur === r && finish(ws, "completed"), 5);
        }
        break;
      }
      case "response.cancel":
        queue.length = 0;
        if (cur) finish(ws, "cancelled");
        break;
      case "session.close":
        ws.serverSend({ type: "session.closed" });
        ws.serverSend({ type: "gateway.usage", usage: { input_tokens: 9, output_tokens: 0, total_cost: 0.0005 } });
        ws.close(1000, "session completed");
        break;
    }
  };
}

async function* chatChunks(pieces, gapMs = 1) {
  for (const p of pieces) {
    await new Promise((r) => setTimeout(r, gapMs));
    yield { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: p } }] };
  }
  yield { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { total_tokens: 3 } };
}

test("speak() streams text pieces, commits, and resolves with the response", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocket(ttsLike());
  const client = new RunApps({ apiKey: "rk_test123" });
  const tts = await client.realtime.connect({ model: "Doubao TTS 2.0 Streaming", session: { voice: "v" }, WebSocket: FakeWebSocket });
  const ws = sockets[0];
  const spoken = [];
  tts.on("response.output_audio_transcript.delta", (e) => spoken.push(e.delta));

  const a = await tts.speak("你好。");
  assert.deepEqual(a, { id: "r1", status: "completed", usage: { characters: 3 } });

  // A chat stream, read as it arrives; reasoning-only and usage chunks say nothing.
  const b = await tts.speak(chatChunks(["今天", "天气", "", "不错。"]));
  assert.equal(b.status, "completed");
  assert.equal(b.usage.characters, 7);
  assert.deepEqual(spoken, ["你好。", "今天天气不错。"]);
  const appends = ws.sent.filter((e) => e.type === "input_text.append").map((e) => e.text);
  assert.deepEqual(appends, ["你好。", "今天", "天气", "不错。"]);
  assert.equal(ws.sent.filter((e) => e.type === "input_text.commit").length, 2);

  // Nothing to say: no response, no commit.
  assert.deepEqual(await tts.speak(""), { id: "", status: "completed", usage: { characters: 0 } });
  assert.equal(ws.sent.filter((e) => e.type === "input_text.commit").length, 2);

  const { usage } = await tts.close();
  assert.equal(usage.total_cost, 0.0005);
});

test("speak() calls queue in order, one response each", async () => {
  const { FakeWebSocket } = fakeWebSocket(ttsLike());
  const client = new RunApps({ apiKey: "rk_test123" });
  const tts = await client.realtime.connect({ model: "Doubao TTS 2.0 Streaming", WebSocket: FakeWebSocket });
  const spoken = [];
  tts.on("response.output_audio_transcript.delta", (e) => spoken.push(e.delta));
  const results = await Promise.all([tts.speak("一。"), tts.speak("二二。"), tts.speak("三三三。")]);
  assert.deepEqual(
    results.map((r) => [r.id, r.status, r.usage.characters]),
    [
      ["r1", "completed", 2],
      ["r2", "completed", 3],
      ["r3", "completed", 4],
    ],
  );
  assert.deepEqual(spoken, ["一。", "二二。", "三三三。"]);
  await tts.close();
});

test("cancelResponse() stops the open speech, drops the queued ones, and stops reading the source", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocket(ttsLike());
  const client = new RunApps({ apiKey: "rk_test123" });
  const tts = await client.realtime.connect({ model: "Doubao TTS 2.0 Streaming", WebSocket: FakeWebSocket });
  const ws = sockets[0];
  let read = 0;
  async function* slow() {
    for (const p of ["第一", "句", "话", "还", "没", "完"]) {
      read++;
      await new Promise((r) => setTimeout(r, 5));
      yield p;
    }
  }
  const first = tts.speak(slow());
  await new Promise((r) => setTimeout(r, 12));
  tts.cancelResponse();
  const r = await first;
  assert.equal(r.status, "cancelled");
  assert.ok(read < 6, `stopped reading the source (read ${read})`);
  assert.equal(ws.sent.filter((e) => e.type === "input_text.commit").length, 0, "a cancelled speech isn't committed");

  // Queued behind an open response, then cancelled with it.
  const open = tts.speak("一。");
  const queued = tts.speak("二。");
  tts.cancelResponse();
  assert.equal((await open).status, "cancelled");
  assert.deepEqual(await queued, { id: "", status: "cancelled", usage: { characters: 0 } });

  // The session carries on.
  assert.equal((await tts.speak("好的。")).status, "completed");
  await tts.close();
});

test("speak() rejects if the session closes first", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocket(ttsLike());
  const client = new RunApps({ apiKey: "rk_test123" });
  const tts = await client.realtime.connect({ model: "Doubao TTS 2.0 Streaming", WebSocket: FakeWebSocket });
  const pending = tts.speak(chatChunks(["很长", "的话"], 20));
  await new Promise((r) => setTimeout(r, 25));
  sockets[0].close(4402, "spending cap reached");
  await assert.rejects(pending, /closed \(4402\)/);
});
