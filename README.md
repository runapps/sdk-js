# RunApps SDK for JavaScript / TypeScript

The client for building apps on [RunApps](https://www.runapps.ai): call any model (Claude, GPT, Gemini, DeepSeek, Qwen, MiniMax, GLM, Grok), generate images, audio and video, keep per-user files, and let the platform handle sign-in and billing. Zero runtime dependencies — native `fetch`, `FormData` and `ReadableStream` (browsers, Node 18+, Deno, Bun).

Two ways to use it:

- **In an app you publish on RunApps** — a static bundle served at `<slug>.runapps.dev`. Users sign in with their RunApps account and pay for their own usage; you never hold a key. This is what `authProvider: "runapps"` is for.
- **From your own code** — server, script or CLI — with a personal API key (`rk_…`).

## Install

```bash
npm install @runappsai/sdk
```

Or as a script tag:

```html
<script src="https://cdn.jsdelivr.net/npm/@runappsai/sdk/dist/sdk.umd.js"></script>
<script>
  const client = new RunApps({ authProvider: "runapps" });
</script>
```

## Building an app

### 1. Create the app, then develop against it

An app gets its slug the moment you create it on the dashboard (Creator → Publish) — no zip needed yet. Pass that slug as `project` and your dev server runs against the real platform:

```ts
import { RunApps } from "@runappsai/sdk";

const client = new RunApps({
  authProvider: "runapps",   // sign-in, token, refresh — all handled
  project: "my-tool",        // the draft's slug; unchanged after you upload
});

const resp = await client.chat.create({
  model: "Claude Sonnet 4.6",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);
```

- Sign-in works from `http://localhost:<any port>`; the first call redirects to the RunApps grant page and back.
- Calls are billed to the signed-in user — while developing, that is you.
- Files and private prompts already use the app's real namespace, so nothing moves when you upload.

When the app is ready, build it, zip it, and upload it to the same app. Set it private (reachable by link) or submit it for review to be listed in the library.

### 2. Sign-in details

```ts
await client.chat.create({ ... });   // redirects to the grant page on first use

client.signIn();                     // force the redirect
client.signOut();                    // clear the cached token (sticky across reloads)
client.user;                         // { id, name } | null
client.auth?.onTokenChange(t => {}); // subscribe to (re)acquisition
client.auth?.hasFreshToken();        // avoid showing a "sign in" button needlessly
```

`showIdentityBadge` (default `true`) draws a small activity badge; `badgePosition` places it.

`project` is optional on `*.runapps.dev` — the origin already says which app it is. It is required on localhost and when the client runs on a personal key (see below). Sign-in only works on the app's own `*.runapps.dev` address and on `http://localhost`. In Node, `authProvider: "runapps"` is a no-op; use `apiKey`.

### 3. Private prompts

Anything in your frontend can be read in the browser. Name your prompt files in a `bundle.json` at the root of your zip — `{"prompts": {"outline": "prompts/outline.md"}}` — or put them under `.runapps/prompts/<id>.md`. The platform never serves `bundle.json`, the files it names, or any dot folder; call the prompts by id:

```ts
await client.chat.create({
  model: "Claude Sonnet 4.6",
  messages: [{ role: "user", content: "A detective in a lighthouse." }],
  prompt: { id: "outline", vars: { genre: "mystery" } },   // {{genre}} in the file
});
```

The gateway prepends the prompt as the system message and asks the model to keep it confidential; a reply that repeats 30+ characters of it verbatim is withheld (`finish_reason: "content_filter"`). While developing locally, before a bundle exists, send the text inline as `prompt.template` — accepted only from the app's creator — and keep it out of production builds with `import.meta.env.DEV`.

### 4. Per-user files

Every app gets a file space per signed-in user, addressed by POSIX-style paths. `FileObject.url` is a stable public address you can drop into `<img src>`.

```ts
// Write. body: Blob | File | ArrayBuffer | Uint8Array | ReadableStream | string
const obj = await client.files.put("assets/logo.png", pngBlob, { contentType: "image/png" });
await client.files.putString("notes.md", "# hello");
await client.files.putFromURL("cache/cat.jpg", "https://example.com/cat.jpg"); // gateway fetches it

// Read.
const blob = await client.files.get("assets/logo.png");
const meta = await client.files.stat("assets/logo.png");   // size, etag, last_modified, url
await client.files.exists("assets/logo.png");

// List, with an optional shell glob (*, **, ?, [abc]) matched against the whole path.
const page = await client.files.list({ prefix: "assets/", glob: "**/*.png", limit: 100 });
// page.next_cursor → pass as cursor for the next page

// Mutate.
await client.files.move("draft.md", "published.md");
await client.files.copy("template.md", "instances/today.md");
await client.files.del("old.log");
await client.files.deleteMany({ prefix: "tmp/" });
await client.files.deleteMany({ glob: "**/*.tmp" });

// Several ops in one round trip; each result has its own ok/error.
await client.files.batch([
  { op: "put_url", path: "a.jpg", src_url: "https://example.com/a.jpg" },
  { op: "copy", from: "a.jpg", to: "b.jpg" },
  { op: "del", path: "a.jpg" },
]);
```

**Keeping app state in a file** — read, modify, write, without overwriting another tab's save. Every read carries the file's ETag; `ifMatch` makes the write fail (412) if the file changed since:

```ts
const { value, etag } = await client.files.readJSON<{ score: number }>("state.json");
const next = { ...(value ?? { score: 0 }), score: (value?.score ?? 0) + 1 };
try {
  await client.files.put("state.json", JSON.stringify(next), {
    contentType: "application/json",
    ...(etag ? { ifMatch: etag } : { ifNoneMatch: true }),   // first save: must not exist
  });
} catch (e) {
  if (e instanceof APIError && e.statusCode === 412) { /* re-read, merge, retry */ }
}
```

`files.read(path)` is `get` plus the ETag for non-JSON files. `ifNoneMatch: true` refuses to overwrite (409).

## From your own code

```ts
import { RunApps, APIError } from "@runappsai/sdk";

const client = new RunApps({ apiKey: "rk_…" });   // Dashboard → API Keys

const resp = await client.chat.create({
  model: "Gemini 3 Flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.usage.total_cost);   // USD
```

The base URL is `https://www.runapps.ai` in both modes; `baseURL` overrides it.

**Files with a personal key** — a personal key has no app of its own, so name the app: `new RunApps({ apiKey, project: "my-tool" })`. You get your own files in that app, the same ones the app sees for you, provided you have added the app or created it.

**Any OpenAI-compatible SDK works too.** Point it at the platform with your `rk_…` key:

```python
from openai import OpenAI
client = OpenAI(api_key="rk_...", base_url="https://www.runapps.ai/v1")
client.chat.completions.create(model="Claude Sonnet 4.6", messages=[{"role": "user", "content": "Hello!"}])
```

Browse `GET /v1/models` (no auth) for the live catalogue and per-model prices.

## Chat

OpenAI-compatible, streaming or not. The final streamed chunk carries `usage`.

```ts
for await (const chunk of client.chat.stream({ model: "Gemini 3 Flash", messages })) {
  for (const c of chunk.choices) process.stdout.write(c.delta.content ?? "");
  if (chunk.usage) console.log("\ncost", chunk.usage.total_cost);
}
```

**Images, video and audio in messages** — check the model first with `acceptsModality(model, "video")`; the gateway rejects unsupported parts with a 400 before billing:

```ts
import { userMessageParts, textPart, imagePart, videoPart, audioPart } from "@runappsai/sdk";

await client.chat.create({
  model: "Gemini 3 Vision",
  messages: [userMessageParts(textPart("Summarise this clip"), videoPart("https://example.com/clip.mp4"))],
});
```

**Your own tools** — pass `tools: [{ type: "function", function: { name, description, parameters } }]`, read `choices[0].message.tool_calls`, answer with `toolResultMessage(toolCallId, output)` on the next turn.

**Server tools** — the platform searches and reads the web for the model, looping until it answers; your code only sees the result. Combine freely with your own `tools`.

```ts
import { ServerTools } from "@runappsai/sdk";

const resp = await client.chat.create({
  model: "Claude Sonnet 4.6",
  messages: [{ role: "user", content: "What is the latest stable Go version?" }],
  server_tools: [ServerTools.WebSearch, ServerTools.WebFetch],
  max_server_iterations: 5,                 // default 5, max 10
});
for (const t of resp.usage.tool_costs ?? []) console.log(t.name, t.count, t.cost);
```

`WebSearch` and `TwitterSearch` are priced per call, `WebFetch` is free; `usage.total_cost` includes tools and tokens. With `stream: true` the tool rounds run silently and the final answer streams.

Message builders: `userMessage`, `systemMessage`, `assistantMessage`, `toolResultMessage`, `userMessageParts`, `textPart`, `imagePart`, `videoPart`, `audioPart`.

## Models

```ts
const all = await client.models.list();
const video = await client.models.list({ capability: "video_generation" });
```

Prices are in pips per million tokens (1 USD = 1,000,000 pips). Each model carries `capability_tags` (stable ids such as `t2v`, `i2v`, `voice_clone`, `timestamps` — filter with `hasCapabilityTag`), chat models carry `input_modalities` (`acceptsModality`), and every model exposes its input contract through `getOptionsSchema(model)`: accepted fields, bounds, enums, cross-field constraints, and a catalogue of voices or emotions. `validateRequest(schema, body)` returns every problem at once for a form to show.

## Image, audio, video, embeddings

```ts
// Image — data: URI (sync) or hosted blob URL (async); decodeMediaUrl() gives bytes.
const img = await client.image.generate("MiniMax Image-01", {
  prompt: "a developer at a laptop, anime style",
  resolution: "2K", aspect_ratio: "16:9",        // or size: "WxH"
  reference_image_urls: ["https://…"],
});
await client.image.edit("GPT Image", { image: { data: bytes, filename: "photo.png" }, prompt: "add a party hat" });
// generateAsync / submitGenerate + getAsyncStatus for jobs longer than ~100 s

// Speech.
const speech = await client.audio.speech("MiniMax Speech 2.6 HD", { input: "Hello", voice: "English_radiant_girl", emotion: "happy" });
const text = await client.audio.transcribe("OpenAI/Whisper", { file: { data: audioBytes, filename: "a.mp3" } });
// speechAsync / transcribeAsync for long jobs; voices and emotions are in getOptionsSchema(model).catalog

// Video — always async.
const task = await client.video.generate("MiniMax Hailuo 2.3", { prompt: "a gentle ocean wave", duration: 5 });
const status = await client.video.wait(task.id, { pollIntervalMs: 5000 });
if (status.status === "succeeded") await client.video.getContent(task.id);

// Embeddings.
const e = await client.embeddings.create("text-embedding-3-small", { input: ["alpha", "beta"] });
```

`VideoGenerateParams` covers keyframes (`first_frame_url` / `last_frame_url`), reference inputs, source video/image/audio drivers, `service_tier: "flex"`, and more; every `*_url` accepts `https://` or a `data:` URI (`encodeImageUrl(bytes)`).

## Errors and cancellation

```ts
try {
  await client.chat.create({ ... }, { signal: controller.signal });
} catch (e) {
  if (e instanceof APIError) console.error(e.statusCode, e.type, e.message);
  else throw e;   // network errors are the fetch rejection
}
```

Every call takes `{ signal }`. In browser-auth mode a 401 is retried once after refreshing the token.

## API reference

| Service | Methods |
|---|---|
| `client.chat` | `create`, `stream` |
| `client.models` | `list` |
| `client.files` | `put`, `putString`, `putFromURL`, `get`, `read`, `readJSON`, `stat`, `exists`, `list`, `del`, `deleteMany`, `move`, `copy`, `batch` |
| `client.image` | `generate`, `edit`, `generateAsync`, `submitGenerate`, `getAsyncStatus` |
| `client.audio` | `speech`, `speechAsync`, `transcribe`, `transcribeAsync` |
| `client.video` | `generate`, `getStatus`, `wait`, `getContent` |
| `client.embeddings` | `create` |

Browser auth: `client.signIn()`, `client.signOut()`, `client.user`, `client.auth`.

Helpers: `hasCapabilityTag`, `acceptsModality`, `getOptionsSchema`, `acceptsField`, `requiresField`, `allowedValuesFor`, `validateRequest`, `supportsVoiceClone`, `supportsInstructText`, `defaultVoice`, `encodeImageUrl`, `decodeMediaUrl`, the message builders, `ServerTools`.

## Compatibility

Browsers (any modern), Node 18+, Deno, Bun. Never ship an `rk_…` key to a browser — an app published on RunApps uses `authProvider: "runapps"` instead, and the user pays for their own usage.

## License

MIT
