import { newRequestId } from "./events.js";
const OPEN = 1;
const CLOSE_TIMEOUT_MS = 10_000;
/**
 * A live realtime session. Listen with `on(type, handler)` (or iterate
 * it with `for await`), talk with `appendAudio()` / `say()`, and end it
 * with `close()`.
 */
export class RealtimeSession {
    ws;
    /** The upstream session id (from `session.created`); pass it as
     *  `session.id` to a later session to continue the conversation. */
    sessionId = "";
    /** Settles when the socket closes, however that happens. */
    closed;
    handlers = new Map();
    usage = null;
    resolveClosed;
    isClosed = false;
    queue = [];
    waiters = [];
    iterating = false;
    /** @internal */
    constructor(ws) {
        this.ws = ws;
        this.closed = new Promise((resolve) => {
            this.resolveClosed = resolve;
        });
        ws.addEventListener("message", (ev) => {
            if (typeof ev.data !== "string")
                return;
            let event;
            try {
                event = JSON.parse(ev.data);
            }
            catch {
                return;
            }
            if (!event || typeof event.type !== "string")
                return;
            if (event.type === "session.created") {
                const id = event.session?.id;
                if (typeof id === "string")
                    this.sessionId = id;
            }
            else if (event.type === "gateway.usage") {
                this.usage = event.usage ?? null;
            }
            this.dispatch(event);
        });
        ws.addEventListener("close", (ev) => {
            if (this.isClosed)
                return;
            this.isClosed = true;
            for (const w of this.waiters.splice(0))
                w({ value: undefined, done: true });
            this.resolveClosed({ code: ev.code ?? 1006, reason: ev.reason ?? "", usage: this.usage });
        });
    }
    /**
     * Subscribe to events of one type, or `"*"` for all of them. Returns
     * the unsubscribe function.
     */
    on(type, handler) {
        let set = this.handlers.get(type);
        if (!set) {
            set = new Set();
            this.handlers.set(type, set);
        }
        set.add(handler);
        return () => set.delete(handler);
    }
    /** Send a raw protocol event. */
    send(event) {
        if (this.ws.readyState !== OPEN)
            throw new Error("runapps: realtime session is closed");
        this.ws.send(JSON.stringify(event));
    }
    /**
     * Stream a chunk of microphone audio: 16-bit little-endian PCM, 16 kHz
     * mono (`pcm16FromFloat32` converts Web Audio samples). Send ~20 ms
     * (640 bytes) at a time, as it is captured.
     */
    appendAudio(pcm16) {
        this.send({ type: "input_audio_buffer.append", audio: bytesToBase64(asBytes(pcm16)) });
    }
    /** Tell the model the user has finished speaking (skips end-of-speech detection). */
    commitAudio() {
        this.send({ type: "input_audio_buffer.commit" });
    }
    /** The microphone is off: stops the model waiting on audio. */
    mute() {
        this.send({ type: "input_audio_mute.commit" });
    }
    /** The microphone is back on. */
    unmute() {
        this.send({ type: "input_audio_unmute.commit" });
    }
    /** Have the model speak `text` (a greeting, or a scripted line). */
    say(text) {
        this.send({ type: "speech_text_buffer.commit", text });
    }
    /** Interrupt the model's current reply. */
    cancelResponse() {
        this.send({ type: "response.cancel" });
    }
    /** Change session settings mid-session (instructions, voice, tools, …). */
    update(session) {
        this.send({ type: "session.update", session });
    }
    /** Answer a `response.function_call_arguments.done` tool call. */
    sendFunctionResult(callId, output) {
        this.send({
            type: "conversation.item.create",
            items: [{ call_id: callId, role: "tool", content: [{ type: "input_text", text: output }] }],
        });
    }
    /**
     * End the session: asks the model to close, waits for the server to
     * hang up (so the closing `gateway.usage` arrives), and resolves with
     * how it ended, including the cost.
     */
    async close() {
        if (!this.isClosed && this.ws.readyState === OPEN) {
            try {
                this.send({ type: "session.close" });
            }
            catch {
                // already closing
            }
            const timer = setTimeout(() => this.ws.close(1000, "client timeout"), CLOSE_TIMEOUT_MS);
            try {
                return await this.closed;
            }
            finally {
                clearTimeout(timer);
            }
        }
        if (!this.isClosed)
            this.ws.close(1000);
        return this.closed;
    }
    /** Iterate events until the session closes. */
    [Symbol.asyncIterator]() {
        this.iterating = true;
        return {
            next: () => {
                const event = this.queue.shift();
                if (event)
                    return Promise.resolve({ value: event, done: false });
                if (this.isClosed)
                    return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => this.waiters.push(resolve));
            },
            return: () => {
                this.iterating = false;
                this.queue = [];
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }
    dispatch(event) {
        for (const type of [event.type, "*"]) {
            const set = this.handlers.get(type);
            if (!set)
                continue;
            for (const h of [...set]) {
                try {
                    h(event);
                }
                catch (err) {
                    // A broken handler must not stop the others or the session.
                    setTimeout(() => {
                        throw err;
                    });
                }
            }
        }
        if (this.iterating) {
            const w = this.waiters.shift();
            if (w)
                w({ value: event, done: false });
            else
                this.queue.push(event);
        }
    }
}
export class RealtimeService {
    transport;
    events;
    constructor(transport, events) {
        this.transport = transport;
        this.events = events;
    }
    /**
     * Open a realtime voice session. Resolves once the model has accepted
     * it (`session.created`); rejects if the connection fails first.
     */
    async connect(options = {}) {
        const WS = options.WebSocket ?? globalThis.WebSocket;
        if (!WS) {
            throw new Error("runapps: no WebSocket available — pass `WebSocket` (e.g. from the `ws` package) on Node < 22");
        }
        const token = await this.transport.bearerToken();
        const ws = new WS(realtimeURL(this.transport.baseURL, options), ["realtime", "runapps-key." + token]);
        const session = new RealtimeSession(ws);
        const model = options.model ?? "";
        const id = newRequestId();
        const startedAt = Date.now();
        this.events.emit("request:start", { id, model, capability: "realtime", startedAt, streaming: true });
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    fail(new Error("runapps: realtime session did not open in time"));
                    ws.close(1000, "open timeout");
                }, options.timeoutMs ?? 15_000);
                const onAbort = () => {
                    fail(new Error("runapps: realtime connect aborted"));
                    ws.close(1000, "aborted");
                };
                options.signal?.addEventListener("abort", onAbort, { once: true });
                let settled = false;
                function fail(err) {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    options.signal?.removeEventListener("abort", onAbort);
                    reject(err);
                }
                const offCreated = session.on("session.created", () => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    options.signal?.removeEventListener("abort", onAbort);
                    offCreated();
                    offError();
                    resolve();
                });
                // An error before the session opens is fatal to connect().
                const offError = session.on("error", (ev) => {
                    const e = (ev.error ?? {});
                    fail(new Error(`runapps: realtime error: ${e.message ?? JSON.stringify(ev)}`));
                });
                ws.addEventListener("open", () => {
                    ws.send(JSON.stringify(openingEvent(options)));
                });
                void session.closed.then((info) => {
                    // A refused handshake (bad key, unknown model, low balance) reaches
                    // a WebSocket client only as 1006 — the HTTP status is hidden.
                    const hint = info.code === 1006 ? " — check the API key, the model name and the account balance" : "";
                    fail(new Error(`runapps: realtime connection closed (${info.code}${info.reason ? " " + info.reason : ""})${hint}`));
                });
            });
        }
        catch (err) {
            try {
                ws.close(1000, "connect failed");
            }
            catch {
                // already closed
            }
            this.events.emit("request:error", {
                id,
                model,
                capability: "realtime",
                latencyMs: Date.now() - startedAt,
                error: err,
            });
            throw err;
        }
        void session.closed.then((info) => {
            this.events.emit("request:end", {
                id,
                model,
                capability: "realtime",
                latencyMs: Date.now() - startedAt,
                totalTokens: info.usage?.output_tokens ?? 0,
                ...(info.usage?.total_cost !== undefined && { costUSD: info.usage.total_cost }),
            });
        });
        return session;
    }
}
function openingEvent(options) {
    const event = { type: "session.create", session: options.session ?? {} };
    if (options.extension)
        event.extension = options.extension;
    return event;
}
function realtimeURL(baseURL, options) {
    const u = new URL(baseURL.replace(/\/+$/, "") + "/v1/realtime");
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    for (const [k, v] of Object.entries(options.query ?? {}))
        u.searchParams.set(k, v);
    if (options.model)
        u.searchParams.set("model", options.model);
    if (options.maxCost !== undefined && options.maxCost > 0)
        u.searchParams.set("max_cost", String(options.maxCost));
    return u.toString();
}
/* ------------------------------------------------------------------ */
/* PCM helpers                                                         */
/* ------------------------------------------------------------------ */
/**
 * Convert Web Audio samples (Float32, -1…1) at `sampleRate` to 16-bit PCM
 * at `targetRate` (16 kHz, what realtime input expects), resampling
 * linearly when the rates differ.
 */
export function pcm16FromFloat32(samples, sampleRate, targetRate = 16000) {
    const ratio = sampleRate / targetRate;
    const n = ratio === 1 ? samples.length : Math.floor(samples.length / ratio);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
        let s;
        if (ratio === 1) {
            s = samples[i];
        }
        else {
            const pos = i * ratio;
            const j = Math.floor(pos);
            const frac = pos - j;
            const a = samples[j];
            const b = samples[Math.min(j + 1, samples.length - 1)];
            s = a + (b - a) * frac;
        }
        s = Math.max(-1, Math.min(1, s));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}
/** Convert 16-bit little-endian PCM bytes (e.g. a decoded audio delta) to Float32 samples for Web Audio. */
export function float32FromPCM16(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.byteLength >> 1);
    for (let i = 0; i < out.length; i++)
        out[i] = view.getInt16(i * 2, true) / 0x8000;
    return out;
}
/** Base64-encode bytes (audio for `input_audio_buffer.append`). */
export function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}
/** Decode base64 (e.g. `response.output_audio.delta`'s `delta`) to bytes. */
export function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
function asBytes(v) {
    if (v instanceof Uint8Array)
        return v;
    if (v instanceof ArrayBuffer)
        return new Uint8Array(v);
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}
//# sourceMappingURL=realtime.js.map