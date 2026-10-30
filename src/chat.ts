import type { Transport } from "./transport.js";
import type { Usage } from "./types.js";
import type { SDKEvents } from "./events.js";
import { wrapEvents, wrapStream } from "./event-wrap.js";
import { APIError } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Request types                                                       */
/* ------------------------------------------------------------------ */

/**
 * A single message in a chat conversation. Content is a string for plain
 * text, or an array of `ContentPart` for multi-modal messages.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  /**
   * The reasoning a thinking model returned with this assistant turn.
   * Send it back on assistant turns that made tool calls: DeepSeek in
   * thinking mode requires it for every later request in the
   * conversation. Elsewhere it is ignored.
   */
  reasoning_content?: string;
}

/** One block inside a multi-modal message content array.
 *
 * Multi-modal LLMs see content as a heterogeneous list — some mix
 * text + images (gpt-4o, claude), some accept video frames or raw
 * audio (Gemini 2.x). The shape mirrors OpenAI's chat completions
 * schema and is forwarded verbatim to the gateway; unsupported
 * variants are rejected server-side with a clear error rather than
 * silently ignored. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } };

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /**
     * Guarantee arguments that validate against `parameters` (strict tool
     * use). The schema should list `required` fields and close every
     * object with `additionalProperties: false`.
     */
    strict?: boolean;
  };
}

/**
 * Constrains the reply. `json_schema` makes the reply a JSON document
 * matching `schema` (structured outputs: on Claude it becomes
 * `output_config.format`, and objects that leave `additionalProperties`
 * unset are closed for you); `json_object` asks for any JSON object.
 */
export type ChatResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        description?: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

export interface StreamOptions {
  include_usage: boolean;
}

/**
 * Names of platform-executed tools the SDK can ask the gateway to run on
 * its behalf during a chat completion.  When you set `server_tools` on a
 * `ChatCompletionParams`, the gateway resolves each name to its tool
 * schema, sends both server tools and your own `tools` (if any) to the
 * model, then handles any server-tool calls itself — looping with the
 * model until it produces a final answer.  Your code only sees the final
 * response; you don't have to implement web search yourself.
 *
 * The whitelist is intentionally narrow.  For image, audio, file, and
 * vision generation the SDK already exposes dedicated endpoints
 * (`client.image.*`, `client.audio.*`, etc.) that callers should hit
 * directly instead of paying for an LLM-in-the-middle.  Search-class
 * tools live here because they need the model in the loop — "search →
 * read result → fetch → answer" can't be expressed as a single call.
 */
export type ServerToolName = "web_search" | "web_fetch" | "twitter_search";

/**
 * One of the app's private prompts, kept out of the browser. The
 * gateway reads `<id>.md` from the app's bundle (`bundle.json` or
 * `.private/prompts/`), fills `{{var}}` placeholders from `vars`, and
 * uses the result: as the system message for chat, or as the whole
 * text for image, video and speech calls, where it takes the place of
 * `prompt` / `input`. `template` sends the text inline instead — for a
 * creator's local dev server, before a bundle exists; the gateway
 * accepts it only from the app's creator.
 */
export interface PromptRef {
  id?: string;
  vars?: Record<string, unknown>;
  template?: string;
}

/**
 * What a prompt field takes: one reference, or a list of references and
 * plain texts joined in order by a blank line — a private style guide
 * followed by the user's own words, or a persona and a rules prompt kept
 * as two files. At most 16 parts.
 */
export type PromptInput = PromptRef | Array<PromptRef | string>;

/** Typed constants for {@link ServerToolName} so you get autocomplete. */
export const ServerTools = {
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  TwitterSearch: "twitter_search",
} as const;

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  n?: number;
  tools?: ChatTool[];
  tool_choice?: unknown;
  /** Structured outputs — see {@link ChatResponseFormat}. */
  response_format?: ChatResponseFormat;
  user?: string;
  metadata?: Record<string, unknown>;
  stream?: boolean;
  stream_options?: StreamOptions;
  /**
   * Names of platform-executed tools — the gateway will run these for
   * you and loop with the model until it produces a final answer.  Mix
   * freely with your own `tools`: the model can call either; the
   * platform handles the server ones, your code handles the rest.
   */
  server_tools?: ServerToolName[];
  /**
   * Maximum number of LLM round-trips the server-tool loop will make
   * (default 5, hard cap 10).  Only meaningful when `server_tools` is
   * set.  Tune up for chains like "search → fetch → answer", down for
   * tighter cost guarantees.
   */
  max_server_iterations?: number;
  /**
   * One of the app's private prompts, kept out of the browser: the
   * gateway reads `bundle.json (or .private/prompts/)<id>.md` from the app's bundle, fills
   * `{{var}}` placeholders from `vars`, and prepends it as the system
   * message. `template` sends the text inline instead — for a creator's
   * local dev server, before a bundle exists; the gateway accepts it
   * only from the app's creator.
   */
  prompt?: PromptInput;
  /**
   * Thinking switch of models that have one. DeepSeek: send
   * `{ type: "enabled" }` to reason before answering (off by default on
   * RunApps). The reasoning arrives as `reasoning_content` and counts
   * toward `max_tokens`, so leave room for it.
   */
  thinking?: { type: "enabled" | "disabled" | (string & {}); [extra: string]: unknown };
  /**
   * How hard a thinking model reasons. DeepSeek takes `low`, `high`
   * (default) or `max`; other models take their own subset.
   */
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | (string & {});
  /** Thinking switch of the Qwen models (QwenPlus): `true` to reason first. */
  enable_thinking?: boolean;
  /** Pass-through for provider-specific knobs. */
  [extra: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Response types                                                      */
/* ------------------------------------------------------------------ */

export interface ChatToolCall {
  index?: number;
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatChoiceMessage {
  role: string;
  content: string | null;
  tool_calls?: ChatToolCall[];
  /** Reasoning a thinking model produced before the answer (DeepSeek-style). */
  reasoning_content?: string;
  reasoning?: string;
}

export interface ChatChoice {
  index: number;
  message: ChatChoiceMessage;
  finish_reason: string;
}

export interface ChatCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: Usage;
}

export interface ChatChunkDelta {
  role?: string;
  content?: string;
  tool_calls?: ChatToolCall[];
  /** Reasoning text some models stream before the answer (DeepSeek-style). */
  reasoning_content?: string;
  reasoning?: string;
}

export interface ChatChunkChoice {
  index: number;
  delta: ChatChunkDelta;
  finish_reason?: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: Usage;
}

/* ------------------------------------------------------------------ */
/* Convenience builders                                                */
/* ------------------------------------------------------------------ */

export const userMessage = (content: string): ChatMessage =>
  ({ role: "user", content });

export const systemMessage = (content: string): ChatMessage =>
  ({ role: "system", content });

export const assistantMessage = (content: string): ChatMessage =>
  ({ role: "assistant", content });

export const toolResultMessage = (toolCallId: string, content: string): ChatMessage =>
  ({ role: "tool", tool_call_id: toolCallId, content });

export const userMessageParts = (...parts: ContentPart[]): ChatMessage =>
  ({ role: "user", content: parts });

export const textPart = (text: string): ContentPart => ({ type: "text", text });

export const imagePart = (
  url: string,
  detail?: "auto" | "low" | "high",
): ContentPart => ({
  type: "image_url",
  image_url: detail ? { url, detail } : { url },
});

/**
 * Video content part. Only supported by chat models whose
 * input_modalities includes `"video"` (currently Gemini 3.x). Other
 * models 400 at the gateway. URL may be http(s) or a
 * `data:video/mp4;base64,...` inline upload.
 */
export const videoPart = (url: string): ContentPart => ({
  type: "video_url",
  video_url: { url },
});

/**
 * Audio content part. Only supported by chat models whose
 * input_modalities includes `"audio"` (currently Gemini 3.x). Other
 * models 400 at the gateway. URL may be http(s) or a
 * `data:audio/wav;base64,...` inline upload.
 */
export const audioPart = (url: string): ContentPart => ({
  type: "audio_url",
  audio_url: { url },
});

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class ChatService {
  constructor(
    private readonly transport: Transport,
    private readonly events: SDKEvents,
  ) {}

  /**
   * Create a chat completion (non-streaming).
   *
   * Streaming is forced off — pass `stream()` instead for incremental output.
   */
  async create(
    params: ChatCompletionParams,
    init?: { signal?: AbortSignal },
  ): Promise<ChatCompletion> {
    const body = { ...params, stream: false };
    return wrapEvents(
      this.events,
      { model: params.model, capability: "text" },
      () =>
        this.transport.postJSON<ChatCompletion>(
          "/v1/chat/completions",
          body,
          init,
        ),
      (r) => ({
        totalTokens: r.usage?.completion_tokens,
        costUSD: r.usage?.total_cost,
        finishReason: r.choices?.[0]?.finish_reason,
      }),
    );
  }

  /**
   * Create a streaming chat completion. Returns an async iterator over
   * `ChatCompletionChunk`. The final chunk carries `usage` (token / cost
   * totals) — `stream_options.include_usage` is set automatically.
   *
   * ```ts
   * let cost = 0;
   * for await (const chunk of client.chat.stream({ ... })) {
   *   for (const c of chunk.choices) process.stdout.write(c.delta.content ?? "");
   *   if (chunk.usage) cost = chunk.usage.total_cost;
   * }
   * ```
   *
   * Also fires `request:streamDelta` on `client.events` for each chunk
   * that carried text — drives the badge's tokens/sec rate display.
   */
  async *stream(
    params: ChatCompletionParams,
    init?: { signal?: AbortSignal },
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const body = {
      ...params,
      stream: true,
      stream_options: params.stream_options ?? { include_usage: true },
    };
    const sourceGen = async function* (this: ChatService) {
      const resp = await this.transport.postJSONStream(
        "/v1/chat/completions",
        body,
        init,
      );
      if (!resp.body) {
        throw new Error("runapps: streaming response had no body");
      }
      yield* parseSSE<ChatCompletionChunk>(resp.body, init?.signal);
    }.bind(this);
    yield* wrapStream(
      this.events,
      { model: params.model, capability: "text" },
      sourceGen,
      (chunk) => ({
        deltaText: chunk.choices?.[0]?.delta?.content ?? "",
        completionTokens: chunk.usage?.completion_tokens,
        costUSD: chunk.usage?.total_cost,
        finishReason: chunk.choices?.[0]?.finish_reason ?? undefined,
      }),
    );
  }

  /**
   * A completion whose answer is a JSON value matching `schema`: asks for
   * it with `response_format: json_schema` and parses the reply, also
   * when a model wraps it in a code fence or adds a trailing comma.
   * Returns the parsed value with the completion it came from.
   */
  async structured<T = unknown>(
    params: ChatCompletionParams,
    schema: Record<string, unknown>,
    init?: { signal?: AbortSignal; name?: string },
  ): Promise<{ value: T; completion: ChatCompletion }> {
    const completion = await this.create(
      {
        ...params,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: { name: init?.name ?? "result", schema, strict: true },
        },
      },
      init,
    );
    const text = completion.choices[0]?.message.content ?? "";
    const value = parseJSONLoose<T>(typeof text === "string" ? text : "");
    if (value === undefined) {
      throw new Error(`runapps: the model's reply is not JSON: ${String(text).slice(0, 200)}`);
    }
    return { value, completion };
  }
}

/**
 * Parses JSON the way models write it: tolerates a ```json fence, text
 * around the value, // and /* comments, trailing commas and curly quotes.
 * Returns undefined when nothing parses.
 */
export function parseJSONLoose<T = unknown>(text: string): T | undefined {
  if (typeof text !== "string") return undefined;
  const attempts: string[] = [];
  const trimmed = text.trim();
  attempts.push(trimmed);
  const fence = /```(?:json|JSON|javascript|js)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) attempts.push(fence[1].trim());
  // The outermost {...} or [...] in the text.
  const first = trimmed.search(/[[{]/);
  if (first >= 0) {
    const open = trimmed[first];
    const close = open === "{" ? "}" : "]";
    const last = trimmed.lastIndexOf(close);
    if (last > first) attempts.push(trimmed.slice(first, last + 1));
  }
  for (const a of attempts) {
    for (const candidate of [a, repairJSON(a)]) {
      try {
        return JSON.parse(candidate) as T;
      } catch { /* next */ }
    }
  }
  return undefined;
}

function repairJSON(s: string): string {
  let out = "";
  let inStr = false;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === "\\" ) { out += c + (s[i + 1] ?? ""); i++; continue; }
      if (c === quote) { inStr = false; out += '"'; continue; }
      if (c === '"') { out += '\\"'; continue; }
      out += c;
      continue;
    }
    if (c === '"' || c === "\u201c" || c === "\u201d") { inStr = true; quote = c === '"' ? '"' : (c === "\u201c" ? "\u201d" : "\u201c"); out += '"'; continue; }
    if (c === "'" ) { inStr = true; quote = "'"; out += '"'; continue; }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && s[i + 1] === "*") { const end = s.indexOf("*/", i + 2); i = end < 0 ? s.length : end + 1; continue; }
    out += c;
  }
  // Trailing commas before } or ].
  return out.replace(/,\s*([}\]])/g, "$1");
}

/* ------------------------------------------------------------------ */
/* SSE parsing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Decode an `text/event-stream` body into a stream of parsed JSON chunks.
 * Stops at the `[DONE]` sentinel. Lines that don't start with `data: ` are
 * ignored (keep-alive comments, etc.).
 */
async function* parseSSE<T>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let finished = false;
  // fetch rejects the body on abort in browsers and Node, but not every
  // fetch replacement does; racing each read against the signal makes
  // abort reliable regardless.
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    while (true) {
      const { value, done } = signal ? await Promise.race([reader.read(), aborted]) : await reader.read();
      if (done) { finished = true; break; }
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") { finished = true; return; }
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          throw new Error(
            `runapps: decode stream chunk: ${(e as Error).message}`,
          );
        }
        // The gateway reports mid-stream failures as an SSE error event
        // (`data: {"error":{...}}`) followed by [DONE]. Such an event has no
        // "choices", so without this it would surface as an empty chunk and
        // the stream would end looking merely empty.
        const err = (parsed as { error?: { code?: number; type?: string; message?: string } })
          .error;
        if (err) {
          throw new APIError(
            err.code ?? 0,
            err.type ?? "upstream_error",
            err.message ?? data,
          );
        }
        yield parsed as T;
      }
    }
  } finally {
    // A consumer that stops early (break, throw, abort) must close the
    // request, or the gateway keeps streaming — and billing — into a
    // buffer nobody reads.
    if (!finished) {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    reader.releaseLock();
  }
}
