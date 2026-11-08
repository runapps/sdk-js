import { wrapEvents, wrapStream } from "./event-wrap.js";
import { APIError } from "./errors.js";
/** Typed constants for {@link ServerToolName} so you get autocomplete. */
export const ServerTools = {
    WebSearch: "web_search",
    WebFetch: "web_fetch",
    TwitterSearch: "twitter_search",
};
/* ------------------------------------------------------------------ */
/* Convenience builders                                                */
/* ------------------------------------------------------------------ */
export const userMessage = (content) => ({ role: "user", content });
export const systemMessage = (content) => ({ role: "system", content });
export const assistantMessage = (content) => ({ role: "assistant", content });
export const toolResultMessage = (toolCallId, content) => ({ role: "tool", tool_call_id: toolCallId, content });
export const userMessageParts = (...parts) => ({ role: "user", content: parts });
export const textPart = (text) => ({ type: "text", text });
export const imagePart = (url, detail) => ({
    type: "image_url",
    image_url: detail ? { url, detail } : { url },
});
/**
 * Video content part. Only supported by chat models whose
 * input_modalities includes `"video"` (currently Gemini 3.x). Other
 * models 400 at the gateway. URL may be http(s) or a
 * `data:video/mp4;base64,...` inline upload.
 */
export const videoPart = (url) => ({
    type: "video_url",
    video_url: { url },
});
/**
 * Audio content part. Only supported by chat models whose
 * input_modalities includes `"audio"` (currently Gemini 3.x). Other
 * models 400 at the gateway. URL may be http(s) or a
 * `data:audio/wav;base64,...` inline upload.
 */
export const audioPart = (url) => ({
    type: "audio_url",
    audio_url: { url },
});
/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */
export class ChatService {
    transport;
    events;
    tools;
    constructor(transport, events, tools) {
        this.transport = transport;
        this.events = events;
        this.tools = tools;
    }
    /**
     * Create a chat completion (non-streaming).
     *
     * Streaming is forced off — pass `stream()` instead for incremental output.
     * With `platformTools`, the platform tool rounds run first (see there).
     */
    async create(params, init) {
        if (params.platformTools)
            return this.createWithTools(params, init);
        return this.createOnce(stripLoopOptions(params), init);
    }
    async createOnce(params, init) {
        const body = { ...params, stream: false };
        return wrapEvents(this.events, { model: params.model, capability: "text" }, () => this.transport.postJSON("/v1/chat/completions", body, init), (r) => ({
            model: r.model,
            totalTokens: r.usage?.completion_tokens,
            costUSD: r.usage?.total_cost,
            finishReason: r.choices?.[0]?.finish_reason,
        }));
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
    async *stream(params, init) {
        if (params.platformTools) {
            yield* this.streamWithTools(params, init);
            return;
        }
        yield* this.streamOnce(stripLoopOptions(params), init);
    }
    async *streamOnce(params, init) {
        const body = {
            ...params,
            stream: true,
            stream_options: params.stream_options ?? { include_usage: true },
        };
        const sourceGen = async function* () {
            const resp = await this.transport.postJSONStream("/v1/chat/completions", body, init);
            if (!resp.body) {
                throw new Error("runapps: streaming response had no body");
            }
            yield* parseSSE(resp.body, init?.signal);
        }.bind(this);
        yield* wrapStream(this.events, { model: params.model, capability: "text" }, sourceGen, (chunk) => ({
            model: chunk.model,
            deltaText: chunk.choices?.[0]?.delta?.content ?? "",
            completionTokens: chunk.usage?.completion_tokens,
            costUSD: chunk.usage?.total_cost,
            finishReason: chunk.choices?.[0]?.finish_reason ?? undefined,
        }));
    }
    /** The tools offered and the loop's settings, for `platformTools`. */
    async toolSetup(params, signal) {
        if (!this.tools)
            throw new Error("runapps: platformTools needs a client with tools");
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
    roundParams(base, offered, messages, last) {
        const p = { ...base, messages, tools: [...(base.tools ?? []), ...offered] };
        if (!p.tools.length)
            delete p.tools;
        // The tools stay defined (earlier rounds' calls refer to them); the model may not call one now.
        if (last && p.tools)
            p.tool_choice = "none";
        return p;
    }
    async createWithTools(params, init) {
        const { offered, names, rounds, base } = await this.toolSetup(params, init?.signal);
        const messages = [...base.messages];
        const transcript = [];
        const total = new UsageSum();
        for (let round = 0;; round++) {
            const completion = await this.createOnce(this.roundParams(base, offered, messages, round >= rounds), init);
            total.add(completion.usage);
            const msg = completion.choices[0]?.message;
            const reply = msg ? assistantTurn(msg) : null;
            if (reply)
                transcript.push(reply);
            const calls = msg?.tool_calls ?? [];
            const platform = calls.filter((c) => names.has(c.function.name));
            if (!platform.length || round >= rounds) {
                return { ...completion, usage: total.usage(), transcript };
            }
            messages.push(reply);
            const results = await this.tools.runCalls(platform, { onToolCall: total.counting(params.onToolCall), signal: init?.signal });
            messages.push(...results);
            transcript.push(...results);
            // The model called the caller's tools too: theirs to answer now.
            if (platform.length < calls.length)
                return { ...completion, usage: total.usage(), transcript };
        }
    }
    async *streamWithTools(params, init) {
        const { offered, names, rounds, base } = await this.toolSetup(params, init?.signal);
        const messages = [...base.messages];
        const transcript = [];
        const total = new UsageSum();
        let last;
        for (let round = 0;; round++) {
            // The round's reply as it streams: text, reasoning, and its tool calls by index.
            let content = "";
            let reasoning = "";
            const calls = new Map();
            for await (const chunk of this.streamOnce(this.roundParams(base, offered, messages, round >= rounds), init)) {
                last = chunk;
                if (chunk.usage)
                    total.add(chunk.usage);
                const choice = chunk.choices?.[0];
                if (!choice)
                    continue; // the usage chunk: the total goes out once, at the end
                const d = choice.delta ?? {};
                content += d.content ?? "";
                reasoning += d.reasoning_content ?? d.reasoning ?? "";
                let ownDeltas = d.tool_calls;
                if (d.tool_calls?.length) {
                    ownDeltas = [];
                    for (const tc of d.tool_calls) {
                        const i = tc.index ?? 0;
                        const acc = calls.get(i) ?? { id: "", name: "", args: "" };
                        if (tc.id)
                            acc.id = tc.id;
                        if (tc.function?.name)
                            acc.name += tc.function.name;
                        if (tc.function?.arguments)
                            acc.args += tc.function.arguments;
                        calls.set(i, acc);
                        if (!names.has(acc.name))
                            ownDeltas.push(tc);
                    }
                }
                const platformOnly = [...calls.values()].every((c) => names.has(c.name));
                const finish = choice.finish_reason;
                // A round that ends in platform calls only is not the end: hold its finish back.
                const hideFinish = !!finish && calls.size > 0 && platformOnly && round < rounds;
                if (!d.content && !d.reasoning_content && !d.reasoning && !(ownDeltas?.length) && !(finish && !hideFinish) && !d.role)
                    continue;
                const delta = { ...d };
                if (ownDeltas?.length)
                    delta.tool_calls = ownDeltas;
                else
                    delete delta.tool_calls;
                yield { ...chunk, usage: undefined, choices: [{ ...choice, delta, finish_reason: hideFinish ? null : finish }] };
            }
            const all = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } }));
            const reply = { role: "assistant", content: content || null };
            if (all.length)
                reply.tool_calls = all;
            if (reasoning)
                reply.reasoning_content = reasoning;
            transcript.push(reply);
            const platform = all.filter((c) => names.has(c.function.name));
            if (!platform.length || round >= rounds)
                break;
            messages.push(reply);
            const results = await this.tools.runCalls(platform, { onToolCall: total.counting(params.onToolCall), signal: init?.signal });
            messages.push(...results);
            transcript.push(...results);
            if (platform.length < all.length)
                break;
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
    async structured(params, schema, init) {
        const completion = await this.create({
            ...params,
            stream: false,
            response_format: {
                type: "json_schema",
                json_schema: { name: init?.name ?? "result", schema, strict: true },
            },
        }, init);
        const text = completion.choices[0]?.message.content ?? "";
        const value = parseJSONLoose(typeof text === "string" ? text : "");
        if (value === undefined) {
            throw new Error(`runapps: the model's reply is not JSON: ${String(text).slice(0, 200)}`);
        }
        return { value, completion };
    }
}
const DEFAULT_TOOL_ROUNDS = 8;
/** The SDK-side loop options, which the gateway must not see. */
function stripLoopOptions(params) {
    const { platformTools: _p, onToolCall: _o, maxToolRounds: _m, ...rest } = params;
    return rest;
}
/** A reply as the next request's assistant message. */
function assistantTurn(msg) {
    const out = { role: "assistant", content: msg.content ?? null };
    if (msg.tool_calls?.length)
        out.tool_calls = msg.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments ?? "" } }));
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (reasoning)
        out.reasoning_content = reasoning;
    return out;
}
/** Usage summed over the rounds, plus what the platform tools cost. */
class UsageSum {
    u = { total_cost: 0 };
    tools = new Map();
    /** The platform tools' cost, which no round's `total_cost` includes. */
    extra = 0;
    add(u) {
        if (!u)
            return;
        this.u.total_cost += u.total_cost ?? 0;
        for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
            if (typeof u[k] === "number")
                this.u[k] = (this.u[k] ?? 0) + u[k];
        }
        // The gateway's own server_tools, already in its total_cost.
        for (const t of u.tool_costs ?? [])
            this.bump(t.name, t.count, t.cost);
    }
    /** Wraps onToolCall so each finished call's cost is counted. */
    counting(fn) {
        return (ev) => {
            if (ev.status === "done") {
                this.bump(ev.name, 1, ev.cost ?? 0);
                this.extra += ev.cost ?? 0;
            }
            fn?.(ev);
        };
    }
    bump(name, count, cost) {
        const t = this.tools.get(name) ?? { count: 0, cost: 0 };
        t.count += count;
        t.cost += cost;
        this.tools.set(name, t);
    }
    usage() {
        const out = { ...this.u, total_cost: this.u.total_cost + this.extra };
        if (this.tools.size)
            out.tool_costs = [...this.tools.entries()].map(([name, t]) => ({ name, count: t.count, cost: t.cost }));
        return out;
    }
}
/**
 * Parses JSON the way models write it: tolerates a ```json fence, text
 * around the value, // and /* comments, trailing commas and curly quotes.
 * Returns undefined when nothing parses.
 */
export function parseJSONLoose(text) {
    if (typeof text !== "string")
        return undefined;
    const attempts = [];
    const trimmed = text.trim();
    attempts.push(trimmed);
    const fence = /```(?:json|JSON|javascript|js)?\s*\n?([\s\S]*?)```/.exec(trimmed);
    if (fence?.[1])
        attempts.push(fence[1].trim());
    // The outermost {...} or [...] in the text.
    const first = trimmed.search(/[[{]/);
    if (first >= 0) {
        const open = trimmed[first];
        const close = open === "{" ? "}" : "]";
        const last = trimmed.lastIndexOf(close);
        if (last > first)
            attempts.push(trimmed.slice(first, last + 1));
    }
    for (const a of attempts) {
        for (const candidate of [a, repairJSON(a)]) {
            try {
                return JSON.parse(candidate);
            }
            catch { /* next */ }
        }
    }
    return undefined;
}
function repairJSON(s) {
    let out = "";
    let inStr = false;
    let quote = "";
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (c === "\\") {
                out += c + (s[i + 1] ?? "");
                i++;
                continue;
            }
            if (c === quote) {
                inStr = false;
                out += '"';
                continue;
            }
            if (c === '"') {
                out += '\\"';
                continue;
            }
            out += c;
            continue;
        }
        if (c === '"' || c === "\u201c" || c === "\u201d") {
            inStr = true;
            quote = c === '"' ? '"' : (c === "\u201c" ? "\u201d" : "\u201c");
            out += '"';
            continue;
        }
        if (c === "'") {
            inStr = true;
            quote = "'";
            out += '"';
            continue;
        }
        if (c === "/" && s[i + 1] === "/") {
            while (i < s.length && s[i] !== "\n")
                i++;
            continue;
        }
        if (c === "/" && s[i + 1] === "*") {
            const end = s.indexOf("*/", i + 2);
            i = end < 0 ? s.length : end + 1;
            continue;
        }
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
async function* parseSSE(body, signal) {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    let finished = false;
    // fetch rejects the body on abort in browsers and Node, but not every
    // fetch replacement does; racing each read against the signal makes
    // abort reliable regardless.
    const aborted = new Promise((_, reject) => {
        if (!signal)
            return;
        const fail = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted)
            fail();
        else
            signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => undefined);
    try {
        while (true) {
            const { value, done } = signal ? await Promise.race([reader.read(), aborted]) : await reader.read();
            if (done) {
                finished = true;
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, nl).replace(/\r$/, "");
                buffer = buffer.slice(nl + 1);
                if (!line.startsWith("data: "))
                    continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                    finished = true;
                    return;
                }
                if (!data)
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(data);
                }
                catch (e) {
                    throw new Error(`runapps: decode stream chunk: ${e.message}`);
                }
                // The gateway reports mid-stream failures as an SSE error event
                // (`data: {"error":{...}}`) followed by [DONE]. Such an event has no
                // "choices", so without this it would surface as an empty chunk and
                // the stream would end looking merely empty.
                const err = parsed
                    .error;
                if (err) {
                    throw new APIError(err.code ?? 0, err.type ?? "upstream_error", err.message ?? data);
                }
                yield parsed;
            }
        }
    }
    finally {
        // A consumer that stops early (break, throw, abort) must close the
        // request, or the gateway keeps streaming — and billing — into a
        // buffer nobody reads.
        if (!finished) {
            try {
                await reader.cancel();
            }
            catch { /* already closed */ }
        }
        reader.releaseLock();
    }
}
//# sourceMappingURL=chat.js.map