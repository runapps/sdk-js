import type { ChatCompletionParams, ChatCompletionChunk, ChatMessage, ChatToolCall } from "../chat.js";
import type { Usage } from "../types.js";
export interface CollectedCompletion {
    message: ChatMessage & {
        role: "assistant";
        tool_calls?: ChatToolCall[];
    };
    finishReason: string;
    usage?: Usage;
    reasoning: string;
}
export interface CollectOptions {
    signal?: AbortSignal;
    onText?: (delta: string, text: string) => void;
    onReasoning?: (delta: string, text: string) => void;
    /** Hard cap on streamed characters (default 800 000). */
    maxChars?: number;
}
export type StreamFn = (params: ChatCompletionParams, init?: {
    signal?: AbortSignal;
}) => AsyncIterable<ChatCompletionChunk>;
export declare function collectCompletion(stream: StreamFn, params: ChatCompletionParams, opts?: CollectOptions): Promise<CollectedCompletion>;
//# sourceMappingURL=completion.d.ts.map