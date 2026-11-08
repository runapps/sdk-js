import type { Transport } from "./transport.js";
import type { SDKEvents } from "./events.js";
import type { ChatMessage, ChatTool, ChatToolCall } from "./chat.js";
/**
 * Platform tools: tools the platform runs and bills — web search, reading
 * a web page, searching X. Call one from code (`client.tools.call`,
 * `client.web.search`, `client.web.fetch`), or let a model call them:
 * `chat.create({ platformTools: true })` adds their descriptions to the
 * request and runs what the model calls, round after round, in your page,
 * so you see every call (`onToolCall`) and they mix freely with your own
 * `tools`. The list comes from the platform (`GET /v1/tools`) and is
 * cached, so a tool the platform adds needs no new SDK.
 */
/** Names of the platform's tools today; the list itself is `tools.list()`. */
export type PlatformToolName = "web_search" | "web_fetch" | "twitter_search" | (string & {});
export interface PlatformTool {
    name: PlatformToolName;
    /** What the model is told. */
    description: string;
    /** JSON Schema of the arguments. */
    parameters: Record<string, unknown>;
    /** USD per call, before the app creator's fee; 0 = free. */
    price: number;
}
/** One call's answer: `content` for a model (a tool message), `data` for code. */
export interface PlatformToolResult<D = unknown> {
    name: string;
    content: string;
    data: D;
    /** What the user was charged, the creator's fee included. */
    usage: {
        total_cost: number;
    };
}
export interface WebSearchResult {
    title: string;
    url: string;
    /** The snippet. */
    description: string;
    /** How old the page is, as the search engine says it ("2 days ago"). */
    age?: string;
}
export interface WebSearchData {
    query: string;
    results: WebSearchResult[];
}
export interface WebPage {
    /** The URL after redirects. */
    url: string;
    status: number;
    content_type: string;
    title?: string;
    byline?: string;
    site_name?: string;
    /** RFC 3339, when the page says. */
    published?: string;
    /** The main content as text, links kept as "text ( url )"; the HTML with `format: "html"`. */
    text: string;
    /** Cut at `maxChars`. */
    truncated: boolean;
}
/** A platform tool call made for a model, as it starts and as it ends. */
export interface PlatformToolCallEvent {
    /** The model's `tool_call_id`. */
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: "running" | "done" | "error";
    /** The text the model gets (done / error). */
    content?: string;
    /** The structured result (done). */
    data?: unknown;
    /** USD charged (done). */
    cost?: number;
}
/** Which platform tools to offer a model: `true` = all of them. */
export type PlatformToolsOption = true | PlatformToolName[];
export declare class ToolsService {
    private readonly transport;
    private readonly events?;
    constructor(transport: Transport, events?: SDKEvents | undefined);
    /**
     * The tools the platform runs now (cached: 10 minutes in memory, an
     * hour in localStorage; `refresh: true` asks again). Needs no sign-in.
     */
    list(opts?: {
        refresh?: boolean;
        signal?: AbortSignal;
    }): Promise<PlatformTool[]>;
    /** The tools as chat `tools` entries; `which` picks them (default all). Names the platform does not offer are left out. */
    definitions(which?: PlatformToolsOption, opts?: {
        signal?: AbortSignal;
    }): Promise<ChatTool[]>;
    /** Runs one tool. Throws an `APIError` when it fails (not charged) or the balance is short (402). */
    call<D = unknown>(name: PlatformToolName, args?: Record<string, unknown>, init?: {
        signal?: AbortSignal;
    }): Promise<PlatformToolResult<D>>;
    /**
     * Answers a model's calls of platform tools, in order: one tool message
     * per call (an error becomes `[error] …` for the model to read, as a
     * failed call costs nothing). `onToolCall` sees each start and end.
     */
    runCalls(calls: ChatToolCall[], opts?: {
        onToolCall?: (ev: PlatformToolCallEvent) => void;
        signal?: AbortSignal;
    }): Promise<ChatMessage[]>;
}
/** Search and read the web from code: `client.web.search(query)`, `client.web.fetch(url)`. */
export declare class WebService {
    private readonly tools;
    constructor(tools: ToolsService);
    /** Searches the web (charged per call). */
    search(query: string, opts?: {
        count?: number;
        freshness?: "day" | "week" | "month" | "year";
        signal?: AbortSignal;
    }): Promise<WebSearchResult[]>;
    /** Reads a page: its main content as text (`format: "html"` for the HTML as it is). */
    fetch(url: string, opts?: {
        format?: "text" | "html";
        maxChars?: number;
        signal?: AbortSignal;
    }): Promise<WebPage>;
}
//# sourceMappingURL=tools.d.ts.map