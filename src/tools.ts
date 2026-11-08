import type { Transport } from "./transport.js";
import type { SDKEvents } from "./events.js";
import { wrapEvents } from "./event-wrap.js";
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
  usage: { total_cost: number };
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

const MEMORY_TTL_MS = 10 * 60_000;
const STORED_TTL_MS = 60 * 60_000;
const memo = new Map<string, { at: number; tools?: PlatformTool[]; pending?: Promise<PlatformTool[]> }>();

function storageKey(baseURL: string): string {
  return `runapps_tools:${baseURL}`;
}

function readStored(baseURL: string): PlatformTool[] | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(baseURL));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { at: number; tools: PlatformTool[] };
    if (Date.now() - v.at > STORED_TTL_MS || !Array.isArray(v.tools)) return undefined;
    return v.tools;
  } catch {
    return undefined;
  }
}

function writeStored(baseURL: string, tools: PlatformTool[]): void {
  try {
    globalThis.localStorage?.setItem(storageKey(baseURL), JSON.stringify({ at: Date.now(), tools }));
  } catch { /* private mode, quota: memory is enough */ }
}

export class ToolsService {
  constructor(
    private readonly transport: Transport,
    private readonly events?: SDKEvents,
  ) {}

  /**
   * The tools the platform runs now (cached: 10 minutes in memory, an
   * hour in localStorage; `refresh: true` asks again). Needs no sign-in.
   */
  async list(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PlatformTool[]> {
    const key = this.transport.baseURL;
    const hit = memo.get(key);
    if (!opts.refresh) {
      if (hit?.tools && Date.now() - hit.at < MEMORY_TTL_MS) return hit.tools;
      if (hit?.pending) return hit.pending;
      const stored = readStored(key);
      if (stored) {
        memo.set(key, { at: Date.now(), tools: stored });
        return stored;
      }
    }
    const pending = this.transport
      .getPublicJSON<{ data: PlatformTool[] }>("/v1/tools", opts.signal ? { signal: opts.signal } : undefined)
      .then((r) => {
        const tools = Array.isArray(r.data) ? r.data : [];
        memo.set(key, { at: Date.now(), tools });
        writeStored(key, tools);
        return tools;
      })
      .catch((err) => {
        memo.delete(key);
        throw err;
      });
    memo.set(key, { at: Date.now(), pending, ...(hit?.tools ? { tools: hit.tools } : {}) });
    return pending;
  }

  /** The tools as chat `tools` entries; `which` picks them (default all). Names the platform does not offer are left out. */
  async definitions(which: PlatformToolsOption = true, opts: { signal?: AbortSignal } = {}): Promise<ChatTool[]> {
    const tools = await this.list(opts);
    const want = which === true ? null : new Set(which);
    return tools
      .filter((t) => !want || want.has(t.name))
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  /** Runs one tool. Throws an `APIError` when it fails (not charged) or the balance is short (402). */
  async call<D = unknown>(name: PlatformToolName, args: Record<string, unknown> = {}, init?: { signal?: AbortSignal }): Promise<PlatformToolResult<D>> {
    const run = () => this.transport.postJSON<PlatformToolResult<D>>(`/v1/tools/${encodeURIComponent(name)}`, args, init);
    if (!this.events) return run();
    return wrapEvents(this.events, { model: name, capability: "tool" }, run, (r) => ({ model: name, costUSD: r.usage?.total_cost }));
  }

  /**
   * Answers a model's calls of platform tools, in order: one tool message
   * per call (an error becomes `[error] …` for the model to read, as a
   * failed call costs nothing). `onToolCall` sees each start and end.
   */
  async runCalls(
    calls: ChatToolCall[],
    opts: { onToolCall?: (ev: PlatformToolCallEvent) => void; signal?: AbortSignal } = {},
  ): Promise<ChatMessage[]> {
    const out: ChatMessage[] = [];
    for (const tc of calls) {
      const id = tc.id ?? "";
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try {
        const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch { /* the platform says what is wrong */ }
      safely(opts.onToolCall, { id, name, args, status: "running" });
      try {
        const r = await this.call(name, args, opts.signal ? { signal: opts.signal } : undefined);
        out.push({ role: "tool", tool_call_id: id, content: r.content });
        safely(opts.onToolCall, { id, name, args, status: "done", content: r.content, data: r.data, cost: r.usage?.total_cost });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // The platform's own words, without the SDK's "runapps: 502 error:" prefix.
        const content = `[error] ${(err instanceof Error ? err.message : String(err)).replace(/^runapps: \d+ [\w-]+: /, "")}`;
        out.push({ role: "tool", tool_call_id: id, content });
        safely(opts.onToolCall, { id, name, args, status: "error", content });
      }
    }
    return out;
  }
}

function safely<E>(fn: ((ev: E) => void) | undefined, ev: E): void {
  if (!fn) return;
  try {
    fn(ev);
  } catch (err) {
    console.warn("runapps: onToolCall threw", err);
  }
}

/** Search and read the web from code: `client.web.search(query)`, `client.web.fetch(url)`. */
export class WebService {
  constructor(private readonly tools: ToolsService) {}

  /** Searches the web (charged per call). */
  async search(
    query: string,
    opts: { count?: number; freshness?: "day" | "week" | "month" | "year"; signal?: AbortSignal } = {},
  ): Promise<WebSearchResult[]> {
    const { signal, ...rest } = opts;
    const r = await this.tools.call<WebSearchData>("web_search", { query, ...rest }, signal ? { signal } : undefined);
    return r.data?.results ?? [];
  }

  /** Reads a page: its main content as text (`format: "html"` for the HTML as it is). */
  async fetch(
    url: string,
    opts: { format?: "text" | "html"; maxChars?: number; signal?: AbortSignal } = {},
  ): Promise<WebPage> {
    const args: Record<string, unknown> = { url };
    if (opts.format) args.format = opts.format;
    if (opts.maxChars) args.max_chars = opts.maxChars;
    const r = await this.tools.call<WebPage>("web_fetch", args, opts.signal ? { signal: opts.signal } : undefined);
    return r.data;
  }
}
