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
    constructor(transport, events) {
        this.transport = transport;
        this.events = events;
    }
    /**
     * Create a chat completion (non-streaming).
     *
     * Streaming is forced off — pass `stream()` instead for incremental output.
     */
    async create(params, init) {
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