# RunApps — SDK and platform docs

[RunApps](https://www.runapps.ai) is a platform for AI web apps. A creator publishes a static frontend; it runs on its own address, `<slug>.runapps.dev`; users sign in with one RunApps account and pay only for the AI they use. This package is the client for building on it: call any model (Claude, GPT, Gemini, DeepSeek, Qwen, MiniMax, GLM, Grok), generate images, audio and video, keep per-user files, and let the platform handle sign-in and billing.

There are two ways to use it:

- **In an app you publish on RunApps.** Users sign in with their RunApps account and pay for their own usage. You never hold a key: create the client without one, `new RunApps()`, and it signs the user in.
- **From your own code.** A server, script or CLI uses a personal API key (`rk_…`), billed to you.

Both use the base URL `https://www.runapps.ai` and the same OpenAI-compatible API under `/v1`.

**Contents:** [Install](#install) · [Build an app](#build-an-app) · [Publish it](#publish-it) · [From your own code](#from-your-own-code) · [Chat](#chat) · [Files](#files) · [Models](#models) · [Image, audio, video, embeddings](#image-audio-video-embeddings) · [HTTP API](#http-api) · [Errors](#errors) · [Reference](#reference)

---

## Install

```bash
npm i @runappsai/sdk
```

Or load it with a script tag, which defines the global `RunApps`:

```html
<script src="https://www.runapps.ai/sdk/latest.js"></script>
<script>
  const client = new RunApps();   // no key: users sign in with RunApps
</script>
```

No runtime dependencies. Runs in browsers, Node 18+, Deno and Bun.

## Build an app

### 1. Create the app, then develop against it

Create the app on the dashboard, under **Creator → Publish**. It gets its slug at once, as a draft visible only to you, before you upload anything. Pass the slug as `project` and run your dev server as usual:

```ts
import { RunApps } from "@runappsai/sdk";

const client = new RunApps({
  project: "my-tool",   // the draft's slug; it stays the same after you upload
});

const resp = await client.chat.create({
  model: "Claude Sonnet 4.6",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);
```

- Sign-in works from `http://localhost` on any port. The first call sends you to RunApps to sign in and back.
- Calls are charged to the signed-in user, which is you while developing.
- Files and private prompts already use the app's real space, so nothing moves when you upload.

When the app is ready, build it, zip the output and upload it to the same app. See [Publish it](#publish-it).

### 2. Sign-in

```ts
await client.chat.create({ ... });   // sends the user to sign in on first use

client.signIn();                     // send them now
client.signOut();                    // forget the token, also across reloads
client.user;                         // { id, name } or null
client.auth?.onTokenChange(t => {}); // react to sign-in
client.auth?.hasFreshToken();        // avoid showing a "sign in" button needlessly
```

By default the first call that needs a token navigates the page to the sign-in
flow and back, which discards unsaved state in the page. An editor-style app
should ask for a popup instead:

```ts
const client = new RunApps({ signInMode: "popup" });
await client.signIn();               // resolves once the user has signed in; rejects if they close the popup
```

The popup lands back on your origin with the token and closes itself; the
page keeps everything it had and the pending call goes through. After
`signOut()` the next call that needs a token opens the popup again instead of
throwing. Call it from a click handler so the browser allows the popup; a
popup blocked for lack of a user gesture opens on the user's next click or
key press, and one blocked on a real gesture falls back to the redirect.

The SDK holds one token per user per app. It draws a small activity badge while it works; turn it off with `showIdentityBadge: false`, or move it with `badgePosition`.

`project` is optional on `*.runapps.dev`, where the address already says which app it is. It is required on localhost and when the client runs on a personal key. Sign-in only works on the app's own `*.runapps.dev` address and on `http://localhost`. With no key, a browser client signs the user in on its own; outside a browser there is no one to sign in, so pass `apiKey`.

### 3. Private prompts

Everything in a frontend can be read in the browser. To keep a prompt private, ship it in the bundle where the platform reads it but never serves it. Put a `bundle.json` at the root of the zip that names your prompt files:

```json
{
  "prompts": {
    "outline": "prompts/outline.md",
    "critic": "prompts/critic.md",
    "greeting": { "text": "You are the concierge of {{app}}. Be brief." }
  }
}
```

A short prompt can be written straight into `bundle.json` as `{ "text": "…" }` instead of a file. Neither `bundle.json` nor the files it names can be downloaded from your app's address. Files under `.private/prompts/<id>.md` also work without an entry, because dot folders are never served; `"prompts_dir": "ai/prompts"` in `bundle.json` names another folder for that, which is then withheld whole. Call a prompt by id and fill its `{{variables}}`:

```ts
await client.chat.create({
  model: "Claude Sonnet 4.6",
  messages: [{ role: "user", content: "A detective in a lighthouse." }],
  prompt: { id: "outline", vars: { genre: "mystery" } },   // {{genre}} in outline.md
});
```

The platform adds the prompt as the system message and tells the model to keep it confidential. A reply that repeats 30 or more consecutive characters of it is withheld, with `finish_reason: "content_filter"`.

Image, video and speech calls take the same reference in place of their text: the filled-in prompt becomes the `prompt` (or the spoken `input`), and only the id and the variables leave the browser. A prompt field can also be a list of references and plain texts, joined in order by a blank line, so a private style guide can precede the user's own words, or a persona and a rules prompt can stay two files:

```ts
await client.image.generate("MiniMax Image-01", {
  prompt: [{ id: "house-style" }, userText, { id: "no-text-in-image" }],
});
await client.chat.create({ model, prompt: [{ id: "persona" }, { id: "rules", vars }], messages });
```

```ts
await client.image.generate("MiniMax Image-01", {
  prompt: { id: "poster", vars: { subject: "a lighthouse at dusk" } },   // poster.md: "A {{subject}}, in the studio's house style: …"
});
await client.video.generate("MiniMax Hailuo 2.3", { prompt: { id: "trailer", vars: { scene } }, duration: 5 });
await client.audio.speech("MiniMax Speech 2.6 HD", { input: { id: "narration", vars: { name } }, voice: "English_radiant_girl" });
```

While developing locally, before a bundle exists, send the text inline as `prompt: { template: "…", vars }`. Only the app's creator may do this. Keep it out of production builds, for example behind `import.meta.env.DEV`.

## Publish it

Upload your build as a **zip** on the app's publish page:

- **Size.** Up to 50 MB.
- **Entry page.** The zip needs at least one HTML file. `index.html` is the default page, and you can pick another.
- **Asset paths.** Your app runs at the root of its own address, so absolute paths such as `/assets/app.js` work.
- **Client-side routing.** A request for a path without a file extension that doesn't exist, such as `/settings`, gets your entry page.
- **Hidden files.** Files and folders whose name starts with a dot, such as `.env` or `.git`, are never served.

You can upload a new zip at any time; it replaces the old one immediately.

| Visibility | Who can open it | Listed in the library |
|---|---|---|
| Draft | Only you | No |
| Private | Anyone with the link | No |
| Public | Everyone | Yes, after review |

Submitting an app as public sends it to review. If it is rejected, fix it and submit again.

### Earnings

Set a **creator fee** of 0% to 50% on the publish page. On every AI call a user makes in your app, they pay the fee on top of the model charge. The whole fee goes to your **earnings balance**, and your own use of your app carries no fee. You can transfer earnings to your main balance or withdraw them to PayPal, with a $10 minimum and 3 to 5 business days for payouts.

### What your users see

Users find public apps in the library and open them at `<slug>.runapps.dev`. They top up a US-dollar balance by card or PayPal, or Alipay and WeChat Pay in the Chinese interface, and each call is charged at the model's price plus your fee. Your app's page shows the fee before they open it. Users can set a daily budget, and the files your app saves for them appear on their Storage page. Removing your app from their account deletes those files.

## From your own code

Create a key on the dashboard's **API Keys** page.

```ts
import { RunApps } from "@runappsai/sdk";

const client = new RunApps({ apiKey: "rk_…" });

const resp = await client.chat.create({
  model: "Gemini 3 Flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.usage.total_cost);   // USD
```

Any OpenAI-compatible client works too:

```python
from openai import OpenAI

client = OpenAI(api_key="rk_...", base_url="https://www.runapps.ai/v1")
client.chat.completions.create(model="Claude Sonnet 4.6", messages=[{"role": "user", "content": "Hello!"}])
```

```bash
curl https://www.runapps.ai/v1/chat/completions \
  -H "Authorization: Bearer $RUNAPPS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "Claude Sonnet 4.6", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Never put an `rk_…` key in a frontend; an app on RunApps creates its client without a key. `baseURL` overrides the base URL in either mode.

## Chat

`POST /v1/chat/completions` follows the OpenAI format, streaming or not. If you leave out `model`, the user's default model is used, then the platform's. `usage.total_cost` is the charge in USD; when streaming, the last chunk carries `usage`.

```ts
for await (const chunk of client.chat.stream({ model: "Gemini 3 Flash", messages })) {
  for (const c of chunk.choices) process.stdout.write(c.delta.content ?? "");
  if (chunk.usage) console.log("\ncost", chunk.usage.total_cost);
}
```

**Images, video and audio in messages.** Check that the model accepts them with `acceptsModality(model, "video")`; unsupported parts are rejected with a 400 before anything is charged.

```ts
import { userMessageParts, textPart, videoPart } from "@runappsai/sdk";

await client.chat.create({
  model: "Gemini 3 Vision",
  messages: [userMessageParts(textPart("Summarise this clip"), videoPart("https://example.com/clip.mp4"))],
});
```

**Your own tools.** Pass `tools: [{ type: "function", function: { name, description, parameters } }]`, read `choices[0].message.tool_calls`, and answer with `toolResultMessage(toolCallId, output)` on the next turn.

**Structured outputs.** `response_format` makes the reply JSON that matches a schema; it works on Claude (sent as `output_config.format`) as well as OpenAI-style models. Add `strict: true` to a tool to guarantee its arguments match `parameters`.

```ts
const res = await client.chat.create({
  model: "Claude Sonnet 4.6",
  messages: [userMessage("Extract the contact: Ann Lee, ann@example.com")],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "contact",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" } },
        required: ["name", "email"],
        additionalProperties: false,
      },
    },
  },
});
const contact = JSON.parse(res.choices[0].message.content ?? "{}");
```

### Server tools

The platform can search and read the web for the model, looping until it answers. Your code only sees the final reply.

```ts
import { ServerTools } from "@runappsai/sdk";

const resp = await client.chat.create({
  model: "Claude Sonnet 4.6",
  messages: [{ role: "user", content: "What is the latest stable Go version?" }],
  server_tools: [ServerTools.WebSearch, ServerTools.WebFetch],
  max_server_iterations: 5,                 // default 5, at most 10
});
for (const t of resp.usage.tool_costs ?? []) console.log(t.name, t.count, t.cost);
```

| Tool | What it does | Price |
|---|---|---|
| `web_search` | Searches the web | Per call |
| `web_fetch` | Reads a page as text | Free |
| `twitter_search` | Searches posts on X | Per call |

The tokens of every round and each tool call are billed together, and `usage.total_cost` includes both. Server tools combine with your own `tools`; if the model calls one of yours, the loop stops and the call is returned to you. With `stream: true` the tool rounds run silently and the final answer streams.

## Files

Each app has a file space for each signed-in user. Paths look like POSIX paths, and every file has a public `url` you can use in `<img src>`.

File calls go to the files host, `https://files.runapps.ai/u/<hash>/…`, where `<hash>` stands for the signed-in user (the SDK asks the gateway for it once per sign-in). Every file URL is therefore unique to its user and its app, and file traffic stays off the main site. Responses are never cached, since files change. Pass `filesBase: false` to keep the classic `/v1/files` paths on the main base, or a URL to use another base.

```ts
// Write. body: Blob | File | ArrayBuffer | Uint8Array | ReadableStream | string
const obj = await client.files.put("assets/logo.png", pngBlob, { contentType: "image/png" });
await client.files.putString("notes.md", "# hello");
await client.files.putFromURL("cache/cat.jpg", "https://example.com/cat.jpg"); // the platform fetches it

// Read.
const blob = await client.files.get("assets/logo.png");

// A time-limited link that needs no token — for <img src>, <video src>, downloads.
// One hour by default, up to seven days; never cached, always the current bytes.
const src = await client.files.url("assets/logo.png");                 // https://files.runapps.ai/f/…/logo.png
const dl  = await client.files.url("export.csv", { expiresIn: 86400, download: true });
const many = await client.files.urls(["a.png", "b.png"]);              // { "a.png": "…", "b.png": "…" }
const meta = await client.files.stat("assets/logo.png");   // size, etag, last_modified, url
await client.files.exists("assets/logo.png");

// List, with an optional glob (*, **, ?, [abc]) matched against the whole path.
const page = await client.files.list({ prefix: "assets/", glob: "**/*.png", limit: 100 });
// page.next_cursor → pass as cursor for the next page

// Change.
await client.files.move("draft.md", "published.md");
await client.files.copy("template.md", "instances/today.md");
await client.files.del("old.log");
await client.files.deleteMany({ prefix: "tmp/" });

// Several operations in one round trip; each result has its own ok and error.
await client.files.batch([
  { op: "put_url", path: "a.jpg", src_url: "https://example.com/a.jpg" },
  { op: "copy", from: "a.jpg", to: "b.jpg" },
  { op: "del", path: "a.jpg" },
]);
```

**Saving app state safely.** Every read returns the file's ETag. Writing with `ifMatch` fails with 412 if another tab or device changed the file since you read it, so a save never silently overwrites someone else's:

```ts
import { APIError } from "@runappsai/sdk";

const { value, etag } = await client.files.readJSON<{ score: number }>("state.json");
const next = { score: (value?.score ?? 0) + 1 };
try {
  await client.files.put("state.json", JSON.stringify(next), {
    contentType: "application/json",
    ...(etag ? { ifMatch: etag } : { ifNoneMatch: true }),   // first save: must not exist yet
  });
} catch (e) {
  if (e instanceof APIError && e.statusCode === 412) { /* read again, merge, retry */ }
}
```

`files.read(path)` is `get` plus the ETag, for files that aren't JSON. `ifNoneMatch: true` refuses to overwrite an existing file (409).

**Files from your own code.** A personal key has no app of its own, so name the app: `new RunApps({ apiKey, project: "my-tool" })`. You get your own files in that app, the same ones the app sees for you. It must be an app you have added or created.

Paths are at most 900 bytes, and a single file is at most 200 MB.

## Sync

RunApps Sync keeps the data an app stores in IndexedDB on every device the user signs in on, with no code for it. The SDK observes the databases the app opens, pushes committed writes a few seconds later, pulls other devices' changes whenever the page is opened, focused or comes back online, and shows the state on the badge. It is **on by default** in an app on RunApps (browser sign-in mode) and off for personal keys and Node.

```ts
const client = new RunApps();                       // sync on: every database the app opens
new RunApps({ sync: false });                       // off
new RunApps({ sync: { databases: ["notes"], exclude: ["notes/thumbnails"] } });
```

The app keeps using IndexedDB as before, directly or through Dexie, idb, idb-keyval and the like. The first `indexedDB.open` of a database on a new device waits (up to 5 s) for the user's data to arrive, so the first read already sees it. When another device's changes are applied, or another tab of the same browser writes to the database (IndexedDB itself has no event for that), `db:change` names the store and keys so the app can re-read; `source` is `"remote"` or `"tab"`:

```ts
client.events.on("db:change", ({ db, store, keys, cleared }) => refresh(store));
client.sync.status();   // { state: "idle" | "syncing" | "offline" | "error" | "off", pending, lastSyncedAt }
await client.sync.now(); // push and pull right away
```

What syncs: every write that commits — `put`, `add`, `delete`, `clear`, cursor edits — with Dates, Maps, Sets, typed arrays and Blobs intact. Two devices editing one record keep both edits when they changed different fields of a plain object; otherwise the later write wins. Deleting a database drops its synced copy too. Data lives in the user's file space for the app under `db/`, so it counts as the user's storage.

Keep in mind:

- **Use your own keys.** `crypto.randomUUID()` or any key the app chooses. `autoIncrement` keys are assigned per device, so two devices creating records offline collide and the later one wins.
- **Leave out what is local.** Caches, decoded media and anything large or rebuildable: `exclude: ["app/cache"]` (a store) or `exclude: ["cache"]` (a whole database). Databases whose names start with `__runapps` are never synced.
- **Another user signing in** on the same browser starts from their own data; the previous user's synced stores are cleared locally.
- The badge shows the state: blue pulse while syncing, amber when offline or retrying, and the popover lists pending changes and the last sync time.

## Models

```ts
const all = await client.models.list();
const video = await client.models.list({ capability: "video_generation" });

// The platform's default for a capability: the model the admin starred,
// else the first. One model per capability has `is_default: true`.
const chat = await client.models.default();                  // capability "text"
const tts = await client.models.default("text_to_speech");
const pick = defaultModel(video, "video_generation");        // same, from a list you already have
```

`client.models.list()` and `GET /v1/models` need no key or sign-in, so an app can show its model choices before the user signs in. Leave `model` out of a request and the gateway uses the user's own preferred model, else this default; `is_default` tells an app which one that is, so it can preselect it. Prices are in pips, where 1 USD is 10,000 pips: token prices per million tokens, `fixed_cost` per image, second or call. A video model priced by resolution (Seedance) also lists `fixed_cost_by_resolution`, a second at each resolution; 1080p costs about 2.5× 720p. Each model carries `capability_tags`, such as `t2v`, `i2v`, `voice_clone` or `timestamps`; filter with `hasCapabilityTag`. Chat models list `input_modalities`; check with `acceptsModality`. Every model describes its accepted options through `getOptionsSchema(model)`: fields, bounds, enums, cross-field rules, and a catalogue of voices or emotions. `validateRequest(schema, body)` returns every problem at once for a form to show. Live prices are also on the [pricing page](https://www.runapps.ai/pricing).

## Image, audio, video, embeddings

```ts
// Image: a data: URI (sync) or a hosted URL (async); decodeMediaUrl() gives the bytes.
const img = await client.image.generate("MiniMax Image-01", {
  prompt: "a developer at a laptop, anime style",
  resolution: "2K", aspect_ratio: "16:9",        // or size: "WxH"
  reference_image_urls: ["https://…"],
});
await client.image.edit("GPT Image", { image: { data: bytes, filename: "photo.png" }, prompt: "add a party hat" });
// generateAsync, or submitGenerate + getAsyncStatus, for jobs longer than about 100 s

// Speech.
const speech = await client.audio.speech("MiniMax Speech 2.6 HD", { input: "Hello", voice: "English_radiant_girl", emotion: "happy" });
const text = await client.audio.transcribe("OpenAI/Whisper", { file: { data: audioBytes, filename: "a.mp3" } });
const fromUrl = await client.audio.transcribeAsync("Doubao ASR 2.0", { url: "https://…/talk.mp3" }); // no upload
// speechAsync / transcribeAsync for long jobs; voices and emotions are in getOptionsSchema(model).catalog

// Video: always async. quote() prices a call without running it (USD, what the user pays).
const q = await client.video.quote("Seedance 2.5", { prompt: "a gentle ocean wave", duration: 15, resolution: "720p" });
const task = await client.video.generate("MiniMax Hailuo 2.3", { prompt: "a gentle ocean wave", duration: 5 });
const status = await client.video.wait(task.id, { pollIntervalMs: 5000 });
if (status.status === "succeeded") await client.video.getContent(task.id);

// Embeddings.
const e = await client.embeddings.create("text-embedding-3-small", { input: ["alpha", "beta"] });
```

`client.video.quote`, `client.image.quote` and `client.audio.quoteSpeech` take the same arguments as the call and return `{ total_cost, note }`: what the signed-in user would be charged, fees included, without running it. Video is the one to quote: a 30 s 1080p Seedance clip costs dollars, and the price depends on resolution, duration and reference clips.

A finished video is kept for 2 hours: `status.expires_at` (Unix seconds) is when `getContent` and `video_url` stop working. If the app needs the video later, save it before then:

```ts
const { data, contentType } = await client.video.getContent(task.id);
const saved = await client.files.put(`videos/${task.id}.mp4`, data, { contentType }); // saved.url lasts
```

`VideoGenerateParams` covers keyframes (`first_frame_url`, `last_frame_url`), reference inputs, source video, image and audio drivers, `service_tier: "flex"`, and more. Every `*_url` accepts `https://` or a `data:` URI (`encodeImageUrl(bytes)`).

### Faces in Seedance references

Seedance refuses a reference picture with a realistic face. For users the platform has enabled it for, `client.assets.verify(url)` puts the picture into the platform's Seedance asset library (Volcengine reviews it in a few seconds) and returns an `asset://` URI that Seedance takes in the picture's place:

```ts
const me = await client.me();                       // { id, name, features }
if (me.features.includes("seedance_asset_verify")) {
  const v = await client.assets.verify(pictureUrl); // https:// or data: URI
  // { status: "active", asset: "asset://asset-…", faces: 1 }  or  { status: "no_face", faces: 0 }
  const ref = v.status === "active" ? v.asset : pictureUrl;
  await client.video.generate("Seedance 2.5", { prompt: "…", reference_image_urls: [ref] });
}
```

The library keeps the pictures used lately and drops the rest, so call `verify` again right before each Seedance call (a picture still held answers at once). Errors carry a `code`: `invalid_image` (under 300 px or over 6000 px a side, or width/height outside 0.4–2.5), `feature_not_enabled`, `rejected` (Volcengine's review refused it), `busy` (429; retry after `e.retryAfter` seconds).

## Realtime voice

A full-duplex voice conversation: stream the microphone up, get transcripts, text and the spoken reply back as they happen, and interrupt the model mid-sentence.

```ts
const session = await client.realtime.connect({
  model: "Doubao Realtime Voice",
  session: {
    instructions: "You are a friendly voice assistant.",
    audio: { output: { voice: "zh_female_vv_jupiter_bigtts", format: { type: "pcm_s16le", rate: 24000 } } },
  },
});
session.on("conversation.item.input_audio_transcription.completed", (e) => console.log("you:", e.transcript));
session.on("response.output_text.done", (e) => console.log("model:", e.text));
session.on("response.output_audio.delta", (e) => play(base64ToBytes(e.delta))); // 24 kHz PCM16

// 16 kHz mono PCM16, ~20 ms per call, at the pace it is captured.
// In a browser: session.appendAudio(pcm16FromFloat32(float32Samples, audioContext.sampleRate))
session.appendAudio(chunk);
session.say("Hi! What can I do for you?"); // have the model speak
session.cancelResponse();                   // interrupt it

const { usage } = await session.close();    // usage.total_cost, in USD
```

A session can't outspend the account: it ends with close code 4402 when its cost reaches the remaining balance (or today's budget). Pass `maxCost` (USD) to `connect()` for a lower cap; `session.closed` resolves with the code and the final `usage` either way.

Events follow the model's realtime protocol (`session.created`, `…input_audio_transcription.delta`, `response.output_audio.delta`, `response.done`, `error`, …); `session.on("*", …)` sees them all, `for await (const e of session)` iterates them, and `session.send(event)` sends any. The model expects a continuous stream: keep sending silence, or `mute()`, while the microphone is off. On Node < 22 pass `WebSocket` from the `ws` package to `connect()`. Runnable examples: [`examples/realtime-voice.html`](examples/realtime-voice.html) (microphone in the browser) and [`examples/realtime-file.mjs`](examples/realtime-file.mjs) (stream a recording from Node).

### Streaming speech recognition

The same session API does live speech-to-text with a transcription model such as `"Doubao ASR 2.0 Streaming"`: stream audio up and the text comes back while it is still being said. Billed per second of audio.

```ts
const session = await client.realtime.connect({
  model: "Doubao ASR 2.0 Streaming",
  session: { hotwords: ["RunApps", "豆包"] }, // optional: words to favour
});
// e.delta is only the new text (append it, as with OpenAI's Realtime API);
// e.transcript is the sentence so far, revisions included — show that.
session.on("conversation.item.input_audio_transcription.delta", (e) => showPartial(e.transcript));
// A finished sentence, with its position in the audio.
session.on("conversation.item.input_audio_transcription.completed", (e) => addLine(e.transcript, e.start_ms, e.end_ms));

session.appendAudio(chunk);                 // 16 kHz mono PCM16, at the pace it is captured
const { usage } = await session.close();    // end of audio: the last sentence settles first
```

Transcription events follow OpenAI's Realtime API: `delta` is only the newly recognised text, so OpenAI-style code that appends deltas works unchanged; `transcript` on each delta is the sentence so far (the recognizer may revise earlier words: `transcript` shows the revision, while `delta` only ever carries text past what earlier deltas delivered, so appended text keeps up but may hold a few stale characters), and `completed.transcript` is the final sentence (`text` holds the same, for older code). `session.created` reports `session.mode === "transcription"` for these models. For a finished recording, `client.audio.transcribe()` is simpler. Runnable examples: [`examples/realtime-transcribe.html`](examples/realtime-transcribe.html) (live captions from the microphone) and [`examples/realtime-transcribe.mjs`](examples/realtime-transcribe.mjs) (stream a recording from Node).

Without the SDK, open a WebSocket to `wss://www.runapps.ai/v1/realtime?model=<name>[&max_cost=<USD>]` with `Authorization: Bearer <key>`, or from a browser with the subprotocols `["realtime", "runapps-key.<key>"]`. The last frame before the server closes is `{"type":"gateway.usage","usage":{…,"total_cost":…}}`.

## HTTP API

Base URL `https://www.runapps.ai`. Send `Authorization: Bearer <key or app token>`.

| Request | Does |
|---|---|
| `POST /v1/chat/completions` | Chat, OpenAI format |
| `GET /v1/models` | Model catalogue and prices (no key needed) |
| `POST /v1/images/generations` | Generate images |
| `POST /v1/images/edits` | Edit an image |
| `POST /v1/audio/speech` | Text to speech |
| `POST /v1/audio/transcriptions` | Speech to text (a `file`, or a public `url`) |
| `GET /v1/realtime` (WebSocket) | Realtime voice session, or streaming speech recognition |
| `GET /v1/audio/voices` | Voices for a speech model |
| `POST /v1/videos/generations` | Start a video job |
| `GET /v1/videos/generations/<id>` | Job status |
| `GET /v1/videos/<id>/content` | The finished video |
| `POST /v1/embeddings` | Embeddings |
| `/v1/async/…` | Async versions of the image and audio calls: submit, then poll |

### Files over HTTP

With an app token the routes are under `/v1/files`. With a personal key, put the app in the path: `/v1/p/<slug>/files`.

| Request | Does |
|---|---|
| `GET /v1/files?prefix=&glob=&limit=&cursor=` | List files. `limit` defaults to 100, at most 1000. |
| `GET /v1/files/<path>` | Read a file. Returns `ETag`; sends 304 for a matching `If-None-Match`. |
| `HEAD /v1/files/<path>` | Metadata only. |
| `PUT /v1/files/<path>` | Write the request body. Honours `Content-Type`, `If-Match: <etag>` and `If-None-Match: *`. |
| `DELETE /v1/files/<path>` | Delete a file. |
| `POST /v1/files/move` | `{"from", "to"}` |
| `POST /v1/files/copy` | `{"from", "to"}` |
| `POST /v1/files/delete` | `{"prefix"}` or `{"glob"}` deletes many. |
| `POST /v1/files/put-url` | `{"path", "src_url"}`: the platform downloads the URL into the file. |
| `POST /v1/files/batch` | `{"ops": [...]}`: up to 64 operations, `put_url`, `del`, `move`, `copy`, `exists`, `stat`. |

A file object has `path`, `size`, `content_type`, `etag`, `last_modified` and `url`.

### Sign-in without the SDK

Send the user to:

```
https://www.runapps.ai/api/sdk/grant?origin=<your origin>&redirect_to=<url to return to>&token_name=runapps_token[&project_id=<slug>]
```

The origin must be your app's own `https://<slug>.runapps.dev` or `http://localhost` on any port, and `redirect_to` must be on that origin. After signing in, the user comes back to `redirect_to` with `#runapps_token=<token>` in the URL fragment. Send it as `Authorization: Bearer <token>` on `/v1` calls. The token belongs to that user in that app. On localhost, pass your app's slug as `project_id`.

## Errors

| Status | Meaning |
|---|---|
| 400 | Bad request, such as an input the model doesn't accept. Nothing is charged. |
| 401 | Missing or invalid key or token. In browser sign-in mode the SDK refreshes the token and retries once. |
| 402 | The balance is too low, or today's budget is reached. |
| 409 | `If-None-Match: *` and the file already exists. |
| 412 | `If-Match` and the file changed since you read it. |
| 429 | Too many requests at once. Retry shortly. |

```ts
try {
  await client.chat.create({ ... }, { signal: controller.signal });
} catch (e) {
  if (e instanceof APIError) console.error(e.statusCode, e.type, e.code, e.message);
  else throw e;   // network errors are the fetch rejection
}
```

Every call takes `{ signal }` for cancellation.

## Reference

| Service | Methods |
|---|---|
| `client.chat` | `create`, `stream` |
| `client.models` | `list` |
| `client.files` | `put`, `putString`, `putFromURL`, `get`, `read`, `readJSON`, `stat`, `exists`, `list`, `del`, `deleteMany`, `move`, `copy`, `batch` |
| `client.image` | `generate`, `edit`, `generateAsync`, `submitGenerate`, `getAsyncStatus` |
| `client.audio` | `speech`, `speechAsync`, `transcribe`, `transcribeAsync` |
| `client.realtime` | `connect` → session: `on`, `send`, `appendAudio`, `commitAudio`, `mute`, `unmute`, `say`, `cancelResponse`, `update`, `sendFunctionResult`, `close`, `closed` |
| `client.video` | `generate`, `getStatus`, `wait`, `getContent` |
| `client.embeddings` | `create` |

Browser sign-in: `client.signIn()`, `client.signOut()`, `client.user`, `client.auth`.

Sync: `client.sync.status()`, `now()`, `pause()`, `resume()`; option `sync`; events `sync:state`, `db:change`.

Helpers: `hasCapabilityTag`, `acceptsModality`, `getOptionsSchema`, `acceptsField`, `requiresField`, `allowedValuesFor`, `validateRequest`, `supportsVoiceClone`, `supportsInstructText`, `defaultVoice`, `encodeImageUrl`, `decodeMediaUrl`, `pcm16FromFloat32`, `float32FromPCM16`, `bytesToBase64`, `base64ToBytes`, `ServerTools`, and the message builders `userMessage`, `systemMessage`, `assistantMessage`, `toolResultMessage`, `userMessageParts`, `textPart`, `imagePart`, `videoPart`, `audioPart`.

### Addresses

| Address | What it serves |
|---|---|
| `www.runapps.ai` | The website, dashboard, sign-in and the API (`/v1`) |
| `<slug>.runapps.dev` | Each app |
| `files.runapps.ai` | Public file links |

## License

MIT
