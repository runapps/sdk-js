// Realtime voice from Node: stream a recording to the model as if it were
// a microphone, print what it hears and says, and save its spoken reply.
//
//   ffmpeg -i question.mp3 -ar 16000 -ac 1 -f s16le question.pcm
//   RUNAPPS_API_KEY=rk_... node examples/realtime-file.mjs question.pcm reply.wav
//
// Needs Node 22+ (global WebSocket). On Node 18/20: `npm i ws` and pass
// `WebSocket` from it to connect().
//
// Env: RUNAPPS_API_KEY (required), RUNAPPS_BASE_URL (default
// https://www.runapps.ai), RUNAPPS_REALTIME_MODEL (default "Doubao Realtime Voice").

import { readFileSync, writeFileSync } from "node:fs";
import { RunApps, base64ToBytes } from "@runappsai/sdk";

const [input, output = "reply.wav"] = process.argv.slice(2);
if (!input) {
  console.error("usage: node realtime-file.mjs <16k-mono-s16le.pcm> [reply.wav]");
  process.exit(1);
}

const client = new RunApps({
  apiKey: process.env.RUNAPPS_API_KEY,
  ...(process.env.RUNAPPS_BASE_URL && { baseURL: process.env.RUNAPPS_BASE_URL }),
});

const session = await client.realtime.connect({
  model: process.env.RUNAPPS_REALTIME_MODEL ?? "Doubao Realtime Voice",
  session: {
    instructions: "你是一个简洁友好的语音助手。",
    // 24 kHz 16-bit PCM back, easy to wrap as WAV.
    audio: { output: { voice: "zh_female_vv_jupiter_bigtts", format: { type: "pcm_s16le", rate: 24000 } } },
  },
});
console.log("session", session.sessionId);

const reply = [];
let turnDone = false;
session.on("conversation.item.input_audio_transcription.completed", (e) => console.log("you said:", e.text));
session.on("response.output_text.done", (e) => console.log("model says:", e.text));
session.on("response.output_audio.delta", (e) => reply.push(base64ToBytes(e.delta)));
session.on("response.done", () => (turnDone = true));
session.on("error", (e) => console.error("error:", e.error));

// Real-time pace: 20 ms (640 bytes) every 20 ms, then silence until the
// model has answered — the model expects a continuous stream.
const audio = readFileSync(input);
const silence = new Uint8Array(640);
for (let off = 0; !turnDone; off += 640) {
  session.appendAudio(off < audio.length ? audio.subarray(off, off + 640) : silence);
  await new Promise((r) => setTimeout(r, 20));
  if (off > audio.length + 30 * 32000) break; // 30 s of silence and no answer: give up
}

const { usage } = await session.close();
console.log("cost: $" + (usage?.total_cost ?? "?"), usage);
writeFileSync(output, wav(Buffer.concat(reply), 24000));
console.log("saved", output);

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
