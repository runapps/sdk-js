import type { Transport } from "./transport.js";
import type { Usage } from "./types.js";
import type { SDKEvents } from "./events.js";
import { wrapEvents, wrapStream } from "./event-wrap.js";
import { APIError } from "./errors.js";
import type { ToolsService, PlatformToolsOption, PlatformToolCallEvent } from "./tools.js";

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

/** Thinking levels, lightest to deepest; `"none"` answers without thinking. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatCompletionParams {
  /** Catalogue name; left out, the gateway runs the user's preferred
   *  model, else the platform default (`is_default` in the catalogue). */
  model?: string;
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
   * Platform tools run in your page (`true`: all of them, or names such
   * as `["web_search", "web_fetch"]`): their descriptions (`GET /v1/tools`,
   * cached) are added to `tools`, and whatever the model calls of them is
   * run (`client.tools.runCalls`) and fed back, round after round, until
   * it answers or calls one of your own tools. You see each call in
   * `onToolCall`; the completion's `transcript` holds every message the
   * rounds added. Not sent to the gateway.
   */
  platformTools?: PlatformToolsOption;
  /** Each platform tool call as it starts and ends (with `platformTools`). */
  onToolCall?: (ev: PlatformToolCallEvent) => void;
  /** Most rounds of platform tool calls before the model must answer (default 8). */
  maxToolRounds?: number;
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
   * The one thinking switch, for every model that can think: `"none"`
   * answers without thinking, `"minimal"` … `"max"` thinks that hard, and
   * leaving it out takes the model's default. A level a model doesn't
   * offer becomes its nearest one; each model lists its levels and
   * default in `options.inputs.reasoning_effort` (models.list()), and
   * models that think carry the `reasoning` tag. The reasoning arrives as
   * `reasoning_content` and counts toward `max_tokens`, so leave room.
   */
  reasoning_effort?: ReasoningEffort;
  /**
   * @deprecated Use `reasoning_effort` (`"none"` to turn thinking off).
   * Still passed to the upstream as is.
   */
  thinking?: { type: "enabled" | "disabled" | (string & {}); [extra: string]: unknown };
  /**
   * @deprecated Use `reasoning_effort` (`"none"` off, `"high"` on).
   * Still passed to the upstream as is.
   */
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
  /**
   * With `platformTools`: every message the call added to the
   * conversation — each round's assistant reply with its tool calls and
   * the platform tools' results, ending with the last reply. Append these
   * to your history rather than the last message alone. When the last
   * reply also calls your own tools, its platform calls are already
   * answered here; answer yours after them.
   */
  transcript?: ChatMessage[];
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
  /** With `platformTools`, on the last chunk: see `ChatCompletion.transcript`. */
  transcript?: ChatMessage[];
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
    private readonly tools?: ToolsService,
  ) {}

  /**
   * Create a chat completion (non-streaming).
   *
   * Streaming is forced off — pass `stream()` instead for incremental output.
   * With `platformTools`, the platform tool rounds run first (see there).
   */
  async create(
    params: ChatCompletionParams,
    init?: { signal?: AbortSignal },
  ): Promise<ChatCompletion> {
    if (params.platformTools) return this.createWithTools(params, init);
    return this.createOnce(stripLoopOptions(params), init);
  }

  private async createOnce(
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
        model: r.model,
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
    if (params.platformTools) {
      yield* this.streamWithTools(params, init);
      return;
    }
    yield* this.streamOnce(stripLoopOptions(params), init);
  }

  private async *streamOnce(
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
        model: chunk.model,
        deltaText: chunk.choices?.[0]?.delta?.content ?? "",
        completionTokens: chunk.usage?.completion_tokens,
        costUSD: chunk.usage?.total_cost,
        finishReason: chunk.choices?.[0]?.finish_reason ?? undefined,
      }),
    );
  }

  /** The tools offered and the loop's settings, for `platformTools`. */
  private async toolSetup(params: ChatCompletionParams, signal?: AbortSignal) {
    if (!this.tools) throw new Error("runapps: platformTools needs a client with tools");
    const own = new Set((params.tools ?? []).map((t) => t.function.name));
    const offered = (await this.tools.definitions(params.platformTools ?? true, signal ? { signal } : {})).filter((d) => !own.has(d.function.name));
    return {
      offered,
      names: new Set(offered.map((d) => d.function.name)),
      rounds: Math.max(0, params.maxToolRounds ?? DEFAULT_TOOL_ROUNDS),
      base: stripLoopOptions(params),
    };
  }

  /** One round's request: the platform tools beside the caller's, none called on the last round. */
  private roundParams(base: ChatCompletionParams, offered: ChatTool[], messages: ChatMessage[], last: boolean): ChatCompletionParams {
    const p: ChatCompletionParams = { ...base, messages, tools: [...(base.tools ?? []), ...offered] };
    if (!p.tools!.length) delete p.tools;
    // The tools stay defined (earlier rounds' calls refer to them); the model may not call one now.
    if (last && p.tools) p.tool_choice = "none";
    return p;
  }

  private async createWithTools(params: ChatCompletionParams, init?: { signal?: AbortSignal }): Promise<ChatCompletion> {
    const { offered, names, rounds, base } = await this.toolSetup(params, init?.signal);
    const messages = [...base.messages];
    const transcript: ChatMessage[] = [];
    const total = new UsageSum();
    for (let round = 0; ; round++) {
      const completion = await this.createOnce(this.roundParams(base, offered, messages, round >= rounds), init);
      total.add(completion.usage);
      const msg = completion.choices[0]?.message;
      const reply = msg ? assistantTurn(msg) : null;
      if (reply) transcript.push(reply);
      const calls = msg?.tool_calls ?? [];
      const platform = calls.filter((c) => names.has(c.function.name));
      if (!platform.length || round >= rounds) {
        return { ...completion, usage: total.usage(), transcript };
      }
      messages.push(reply!);
      const results = await this.tools!.runCalls(platform, { onToolCall: total.counting(params.onToolCall), signal: init?.signal });
      messages.push(...results);
      transcript.push(...results);
      // The model called the caller's tools too: theirs to answer now.
      if (platform.length < calls.length) return { ...completion, usage: total.usage(), transcript };
    }
  }

  private async *streamWithTools(params: ChatCompletionParams, init?: { signal?: AbortSignal }): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const { offered, names, rounds, base } = await this.toolSetup(params, init?.signal);
    const messages = [...base.messages];
    const transcript: ChatMessage[] = [];
    const total = new UsageSum();
    let last: ChatCompletionChunk | undefined;
    for (let round = 0; ; round++) {
      // The round's reply as it streams: text, reasoning, and its tool calls by index.
      let content = "";
      let reasoning = "";
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of this.streamOnce(this.roundParams(base, offered, messages, round >= rounds), init)) {
        last = chunk;
        if (chunk.usage) total.add(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue; // the usage chunk: the total goes out once, at the end
        const d = choice.delta ?? {};
        content += d.content ?? "";
        reasoning += d.reasoning_content ?? d.reasoning ?? "";
        let ownDeltas = d.tool_calls;
        if (d.tool_calls?.length) {
          ownDeltas = [];
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0;
            const acc = calls.get(i) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            calls.set(i, acc);
            if (!names.has(acc.name)) ownDeltas.push(tc);
          }
        }
        const platformOnly = [...calls.values()].every((c) => names.has(c.name));
        const finish = choice.finish_reason;
        // A round that ends in platform calls only is not the end: hold its finish back.
        const hideFinish = !!finish && calls.size > 0 && platformOnly && round < rounds;
        if (!d.content && !d.reasoning_content && !d.reasoning && !(ownDeltas?.length) && !(finish && !hideFinish) && !d.role) continue;
        const delta: ChatChunkDelta = { ...d };
        if (ownDeltas?.length) delta.tool_calls = ownDeltas;
        else delete delta.tool_calls;
        yield { ...chunk, usage: undefined, choices: [{ ...choice, delta, finish_reason: hideFinish ? null : finish }] };
      }
      const all: ChatToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } }));
      const reply: ChatMessage = { role: "assistant", content: content || null };
      if (all.length) reply.tool_calls = all;
      if (reasoning) reply.reasoning_content = reasoning;
      transcript.push(reply);
      const platform = all.filter((c) => names.has(c.function.name));
      if (!platform.length || round >= rounds) break;
      messages.push(reply);
      const results = await this.tools!.runCalls(platform, { onToolCall: total.counting(params.onToolCall), signal: init?.signal });
      messages.push(...results);
      transcript.push(...results);
      if (platform.length < all.length) break;
    }
    yield {
      id: last?.id ?? "",
      object: "chat.completion.chunk",
      created: last?.created ?? Math.floor(Date.now() / 1000),
      model: last?.model ?? params.model ?? "",
      choices: [],
      usage: total.usage(),
      transcript,
    };
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

const DEFAULT_TOOL_ROUNDS = 8;

/** The SDK-side loop options, which the gateway must not see. */
function stripLoopOptions(params: ChatCompletionParams): ChatCompletionParams {
  const { platformTools: _p, onToolCall: _o, maxToolRounds: _m, ...rest } = params;
  return rest as ChatCompletionParams;
}

/** A reply as the next request's assistant message. */
function assistantTurn(msg: ChatChoiceMessage): ChatMessage {
  const out: ChatMessage = { role: "assistant", content: msg.content ?? null };
  if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments ?? "" } }));
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (reasoning) out.reasoning_content = reasoning;
  return out;
}

/** Usage summed over the rounds, plus what the platform tools cost. */
class UsageSum {
  private u: Usage = { total_cost: 0 };
  private tools = new Map<string, { count: number; cost: number }>();
  /** The platform tools' cost, which no round's `total_cost` includes. */
  private extra = 0;
  add(u: Usage | undefined): void {
    if (!u) return;
    this.u.total_cost += u.total_cost ?? 0;
    for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
      if (typeof u[k] === "number") this.u[k] = (this.u[k] ?? 0) + u[k]!;
    }
    // The gateway's own server_tools, already in its total_cost.
    for (const t of u.tool_costs ?? []) this.bump(t.name, t.count, t.cost);
  }
  /** Wraps onToolCall so each finished call's cost is counted. */
  counting(fn?: (ev: PlatformToolCallEvent) => void): (ev: PlatformToolCallEvent) => void {
    return (ev) => {
      if (ev.status === "done") {
        this.bump(ev.name, 1, ev.cost ?? 0);
        this.extra += ev.cost ?? 0;
      }
      fn?.(ev);
    };
  }
  private bump(name: string, count: number, cost: number): void {
    const t = this.tools.get(name) ?? { count: 0, cost: 0 };
    t.count += count;
    t.cost += cost;
    this.tools.set(name, t);
  }
  usage(): Usage {
    const out: Usage = { ...this.u, total_cost: this.u.total_cost + this.extra };
    if (this.tools.size) out.tool_costs = [...this.tools.entries()].map(([name, t]) => ({ name, count: t.count, cost: t.cost }));
    return out;
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
