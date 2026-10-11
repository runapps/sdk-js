import { type SDKEvents } from "./events.js";
import type { Transport } from "./transport.js";
/** One protocol event. `type` names it; the rest depends on the event. */
export interface RealtimeEvent {
    type: string;
    [key: string]: unknown;
}
/** What a realtime session cost, from the closing `gateway.usage` event. */
export interface RealtimeUsage {
    input_tokens?: number;
    output_tokens?: number;
    /** Session length in seconds. */
    seconds?: number;
    /** USD. */
    total_cost?: number;
}
/** How a session ended. */
export interface RealtimeCloseInfo {
    /** WebSocket close code: 1000 when the session completed; 4000+N for an
     *  upstream HTTP error N (e.g. 4429); 4408 idle or over-long session. */
    code: number;
    reason: string;
    /** Null when the session ended before the cost could be reported. */
    usage: RealtimeUsage | null;
}
/** The subset of the WHATWG WebSocket the SDK uses (also what `ws` provides). */
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (ev: any) => void): void;
}
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike;
export interface RealtimeConnectOptions {
    /** Realtime model name (e.g. "Doubao Realtime Voice"); omit for the platform default. */
    model?: string;
    /**
     * Session settings sent in the opening `session.create`, e.g.
     * `{ instructions: "...", audio: { output: { voice: "zh_female_vv_jupiter_bigtts" } } }`.
     */
    session?: Record<string, unknown>;
    /** Model-specific extension block (Doubao: `{ asr, tts, dialog }`). */
    extension?: Record<string, unknown>;
    /** Extra query parameters for the handshake. */
    query?: Record<string, string>;
    /**
     * WebSocket implementation. Defaults to the global `WebSocket` (browsers,
     * Node 22+, Deno, Bun); on older Node pass the `ws` package's export.
     */
    WebSocket?: WebSocketConstructor;
    /** Give up if the session isn't open within this long (default 15 s). */
    timeoutMs?: number;
    signal?: AbortSignal;
}
type Handler = (event: RealtimeEvent) => void;
/**
 * A live realtime session. Listen with `on(type, handler)` (or iterate
 * it with `for await`), talk with `appendAudio()` / `say()`, and end it
 * with `close()`.
 */
export declare class RealtimeSession {
    private readonly ws;
    /** The upstream session id (from `session.created`); pass it as
     *  `session.id` to a later session to continue the conversation. */
    sessionId: string;
    /** Settles when the socket closes, however that happens. */
    readonly closed: Promise<RealtimeCloseInfo>;
    private readonly handlers;
    private usage;
    private resolveClosed;
    private isClosed;
    private queue;
    private waiters;
    private iterating;
    /** @internal */
    constructor(ws: WebSocketLike);
    /**
     * Subscribe to events of one type, or `"*"` for all of them. Returns
     * the unsubscribe function.
     */
    on(type: string, handler: Handler): () => void;
    /** Send a raw protocol event. */
    send(event: RealtimeEvent): void;
    /**
     * Stream a chunk of microphone audio: 16-bit little-endian PCM, 16 kHz
     * mono (`pcm16FromFloat32` converts Web Audio samples). Send ~20 ms
     * (640 bytes) at a time, as it is captured.
     */
    appendAudio(pcm16: Int16Array | Uint8Array | ArrayBuffer): void;
    /** Tell the model the user has finished speaking (skips end-of-speech detection). */
    commitAudio(): void;
    /** The microphone is off: stops the model waiting on audio. */
    mute(): void;
    /** The microphone is back on. */
    unmute(): void;
    /** Have the model speak `text` (a greeting, or a scripted line). */
    say(text: string): void;
    /** Interrupt the model's current reply. */
    cancelResponse(): void;
    /** Change session settings mid-session (instructions, voice, tools, …). */
    update(session: Record<string, unknown>): void;
    /** Answer a `response.function_call_arguments.done` tool call. */
    sendFunctionResult(callId: string, output: string): void;
    /**
     * End the session: asks the model to close, waits for the server to
     * hang up (so the closing `gateway.usage` arrives), and resolves with
     * how it ended, including the cost.
     */
    close(): Promise<RealtimeCloseInfo>;
    /** Iterate events until the session closes. */
    [Symbol.asyncIterator](): AsyncIterator<RealtimeEvent>;
    private dispatch;
}
export declare class RealtimeService {
    private readonly transport;
    private readonly events;
    constructor(transport: Transport, events: SDKEvents);
    /**
     * Open a realtime voice session. Resolves once the model has accepted
     * it (`session.created`); rejects if the connection fails first.
     */
    connect(options?: RealtimeConnectOptions): Promise<RealtimeSession>;
}
/**
 * Convert Web Audio samples (Float32, -1…1) at `sampleRate` to 16-bit PCM
 * at `targetRate` (16 kHz, what realtime input expects), resampling
 * linearly when the rates differ.
 */
export declare function pcm16FromFloat32(samples: Float32Array, sampleRate: number, targetRate?: number): Int16Array;
/** Convert 16-bit little-endian PCM bytes (e.g. a decoded audio delta) to Float32 samples for Web Audio. */
export declare function float32FromPCM16(bytes: Uint8Array): Float32Array;
/** Base64-encode bytes (audio for `input_audio_buffer.append`). */
export declare function bytesToBase64(bytes: Uint8Array): string;
/** Decode base64 (e.g. `response.output_audio.delta`'s `delta`) to bytes. */
export declare function base64ToBytes(b64: string): Uint8Array;
export {};
//# sourceMappingURL=realtime.d.ts.map