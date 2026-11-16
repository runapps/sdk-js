// Streaming text-to-speech from Node: ask a chat model a question and speak
// its reply while it is still being written — the first words are audible
// before the model has finished. The audio is saved as a WAV file.
//
//   RUNAPPS_API_KEY=rk_... node examples/realtime-tts.mjs "讲一个关于猫的小故事" story.wav
//
// Needs Node 22+ (global WebSocket). On Node 18/20: `npm i ws` and pass
// `WebSocket` from it to connect().
//
// Env: RUNAPPS_API_KEY (required), RUNAPPS_BASE_URL (default
// https://www.runapps.ai), RUNAPPS_CHAT_MODEL (default "DeepSeek"),
// RUNAPPS_TTS_MODEL (default "Doubao TTS 2.0 Streaming").

import { writeFileSync } from "node:fs";
import { RunApps, base64ToBytes } from "@runappsai/sdk";

const [question = "用三句话介绍一下你自己。", output = "reply.wav"] = process.argv.slice(2);

const client = new RunApps({
  apiKey: process.env.RUNAPPS_API_KEY,
  ...(process.env.RUNAPPS_BASE_URL && { baseURL: process.env.RUNAPPS_BASE_URL }),
});

const tts = await client.realtime.connect({
  model: process.env.RUNAPPS_TTS_MODEL ?? "Doubao TTS 2.0 Streaming",
  session: { voice: "zh_female_vv_uranus_bigtts" },
  maxCost: 0.1,
});

const started = Date.now();
const audio = [];
tts.on("response.output_audio.delta", (e) => {
  if (!audio.length) console.log(`first audio after ${Date.now() - started} ms`);
  audio.push(base64ToBytes(e.delta)); // 24 kHz 16-bit mono PCM
});
tts.on("response.output_audio_transcript.delta", (e) => console.log("speaking:", e.delta));
tts.on("error", (e) => console.error("error:", e.error));

// The chat stream goes straight in: speak() reads each chunk's
// delta.content as it arrives.
const reply = await tts.speak(
  client.chat.stream({
    model: process.env.RUNAPPS_CHAT_MODEL ?? "DeepSeek",
    messages: [
      { role: "system", content: "回答会被朗读出来：口语化，不用列表和表格。" },
      { role: "user", content: question },
    ],
    reasoning_effort: "none",
  }),
);
console.log(`reply ${reply.status}: ${reply.usage?.characters} characters`);

const { code, usage } = await tts.close();
console.log(`closed ${code}, speech cost: $${usage?.total_cost ?? "?"}`);
writeFileSync(output, wav(Buffer.concat(audio), 24000));
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
