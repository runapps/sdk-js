// Streaming speech recognition from Node: send audio as it is "spoken"
// and print the text while it is still being said — partial text keeps
// updating, finished sentences settle with their timings.
//
//   ffmpeg -i talk.mp3 -ar 16000 -ac 1 -f s16le talk.pcm
//   RUNAPPS_API_KEY=rk_... node examples/realtime-transcribe.mjs talk.pcm
//   RUNAPPS_API_KEY=rk_... node examples/realtime-transcribe.mjs talk.pcm "RunApps, 豆包"   # hotwords
//
// This is for live audio (a microphone, a call). To turn a finished
// recording into text, client.audio.transcribe() is simpler — see
// transcribe.mjs.
//
// Needs Node 22+ (global WebSocket). On Node 18/20: `npm i ws` and pass
// `WebSocket` from it to connect().
//
// Env: RUNAPPS_API_KEY (required), RUNAPPS_BASE_URL (default
// https://www.runapps.ai), RUNAPPS_ASR_MODEL (default "Doubao ASR 2.0 Streaming").

import { readFileSync } from "node:fs";
import { RunApps } from "@runappsai/sdk";

const [input, hotwords] = process.argv.slice(2);
if (!input) {
  console.error('usage: node realtime-transcribe.mjs <16k-mono-s16le.pcm> ["hotword, hotword"]');
  process.exit(1);
}

const client = new RunApps({
  apiKey: process.env.RUNAPPS_API_KEY,
  ...(process.env.RUNAPPS_BASE_URL && { baseURL: process.env.RUNAPPS_BASE_URL }),
});

const session = await client.realtime.connect({
  model: process.env.RUNAPPS_ASR_MODEL ?? "Doubao ASR 2.0 Streaming",
  // Words to favour (names, jargon): an array, or a comma/newline-separated string.
  session: hotwords ? { hotwords } : {},
  maxCost: 0.05, // USD; this model bills per second of audio
});

// `transcript` is the sentence so far, revisions included — redraw the line
// with it. (`delta` is only the new text, for code that appends.)
const live = process.stdout.isTTY;
session.on("conversation.item.input_audio_transcription.delta", (e) => {
  if (live) process.stdout.write(`\r\x1b[2K… ${e.transcript}`);
});
session.on("conversation.item.input_audio_transcription.completed", (e) => {
  if (live) process.stdout.write("\r\x1b[2K");
  console.log(`[${secs(e.start_ms)}–${secs(e.end_ms)}] ${e.transcript}`);
});
session.on("error", (e) => console.error("\nerror:", e.error));
let ended = false; // e.g. 4402 when the session hits maxCost
void session.closed.then(() => (ended = true));

// Real-time pace: 100 ms (3200 bytes) every 100 ms, as a microphone would.
const audio = readFileSync(input);
for (let off = 0; off < audio.length && !ended; off += 3200) {
  session.appendAudio(audio.subarray(off, off + 3200));
  await new Promise((r) => setTimeout(r, 100));
}

// End of audio: the last sentence settles, then the session closes and
// reports what it cost.
const { code, reason, usage } = await session.close();
console.log(`closed ${code}${reason ? " " + reason : ""}: ${usage?.seconds ?? "?"} s of audio, $${usage?.total_cost ?? "?"}`);

function secs(ms) {
  return typeof ms === "number" ? (ms / 1000).toFixed(1) + "s" : "?";
}
