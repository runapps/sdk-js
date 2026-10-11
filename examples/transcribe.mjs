// Speech to text, from a public URL or a local file.
//
//   RUNAPPS_API_KEY=rk_... node examples/transcribe.mjs https://example.com/talk.mp3
//   RUNAPPS_API_KEY=rk_... node examples/transcribe.mjs ./talk.mp3
//
// A URL is fetched by the model's provider, so there is no upload limit —
// use transcribeAsync() for recordings longer than a minute or two.
//
// Env: RUNAPPS_API_KEY (required), RUNAPPS_BASE_URL (default
// https://www.runapps.ai), RUNAPPS_STT_MODEL (default "Doubao ASR 2.0").

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { RunApps } from "@runappsai/sdk";

const source = process.argv[2];
if (!source) {
  console.error("usage: node transcribe.mjs <url | file>");
  process.exit(1);
}

const client = new RunApps({
  apiKey: process.env.RUNAPPS_API_KEY,
  ...(process.env.RUNAPPS_BASE_URL && { baseURL: process.env.RUNAPPS_BASE_URL }),
});
const model = process.env.RUNAPPS_STT_MODEL ?? "Doubao ASR 2.0";

const audio = /^https?:\/\//.test(source)
  ? { url: source }
  : { file: { data: readFileSync(source), filename: basename(source) } };

const result = await client.audio.transcribeAsync(model, {
  ...audio,
  response_format: "verbose_json",
  timestamp_granularities: ["segment"],
});
console.log(result.text);
for (const s of result.raw?.segments ?? []) {
  console.log(`  [${s.start.toFixed(2)}–${s.end.toFixed(2)}] ${s.text}`);
}
console.log("cost: $" + result.usage.total_cost);
