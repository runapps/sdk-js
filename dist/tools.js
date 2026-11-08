import { wrapEvents } from "./event-wrap.js";
const MEMORY_TTL_MS = 10 * 60_000;
const STORED_TTL_MS = 60 * 60_000;
const memo = new Map();
function storageKey(baseURL) {
    return `runapps_tools:${baseURL}`;
}
function readStored(baseURL) {
    try {
        const raw = globalThis.localStorage?.getItem(storageKey(baseURL));
        if (!raw)
            return undefined;
        const v = JSON.parse(raw);
        if (Date.now() - v.at > STORED_TTL_MS || !Array.isArray(v.tools))
            return undefined;
        return v.tools;
    }
    catch {
        return undefined;
    }
}
function writeStored(baseURL, tools) {
    try {
        globalThis.localStorage?.setItem(storageKey(baseURL), JSON.stringify({ at: Date.now(), tools }));
    }
    catch { /* private mode, quota: memory is enough */ }
}
export class ToolsService {
    transport;
    events;
    constructor(transport, events) {
        this.transport = transport;
        this.events = events;
    }
    /**
     * The tools the platform runs now (cached: 10 minutes in memory, an
     * hour in localStorage; `refresh: true` asks again). Needs no sign-in.
     */
    async list(opts = {}) {
        const key = this.transport.baseURL;
        const hit = memo.get(key);
        if (!opts.refresh) {
            if (hit?.tools && Date.now() - hit.at < MEMORY_TTL_MS)
                return hit.tools;
            if (hit?.pending)
                return hit.pending;
            const stored = readStored(key);
            if (stored) {
                memo.set(key, { at: Date.now(), tools: stored });
                return stored;
            }
        }
        const pending = this.transport
            .getPublicJSON("/v1/tools", opts.signal ? { signal: opts.signal } : undefined)
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
    async definitions(which = true, opts = {}) {
        const tools = await this.list(opts);
        const want = which === true ? null : new Set(which);
        return tools
            .filter((t) => !want || want.has(t.name))
            .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    /** Runs one tool. Throws an `APIError` when it fails (not charged) or the balance is short (402). */
    async call(name, args = {}, init) {
        const run = () => this.transport.postJSON(`/v1/tools/${encodeURIComponent(name)}`, args, init);
        if (!this.events)
            return run();
        return wrapEvents(this.events, { model: name, capability: "tool" }, run, (r) => ({ model: name, costUSD: r.usage?.total_cost }));
    }
    /**
     * Answers a model's calls of platform tools, in order: one tool message
     * per call (an error becomes `[error] …` for the model to read, as a
     * failed call costs nothing). `onToolCall` sees each start and end.
     */
    async runCalls(calls, opts = {}) {
        const out = [];
        for (const tc of calls) {
            const id = tc.id ?? "";
            const name = tc.function.name;
            let args = {};
            try {
                const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                    args = parsed;
            }
            catch { /* the platform says what is wrong */ }
            safely(opts.onToolCall, { id, name, args, status: "running" });
            try {
                const r = await this.call(name, args, opts.signal ? { signal: opts.signal } : undefined);
                out.push({ role: "tool", tool_call_id: id, content: r.content });
                safely(opts.onToolCall, { id, name, args, status: "done", content: r.content, data: r.data, cost: r.usage?.total_cost });
            }
            catch (err) {
                if (opts.signal?.aborted)
                    throw err;
                // The platform's own words, without the SDK's "runapps: 502 error:" prefix.
                const content = `[error] ${(err instanceof Error ? err.message : String(err)).replace(/^runapps: \d+ [\w-]+: /, "")}`;
                out.push({ role: "tool", tool_call_id: id, content });
                safely(opts.onToolCall, { id, name, args, status: "error", content });
            }
        }
        return out;
    }
}
function safely(fn, ev) {
    if (!fn)
        return;
    try {
        fn(ev);
    }
    catch (err) {
        console.warn("runapps: onToolCall threw", err);
    }
}
/** Search and read the web from code: `client.web.search(query)`, `client.web.fetch(url)`. */
export class WebService {
    tools;
    constructor(tools) {
        this.tools = tools;
    }
    /** Searches the web (charged per call). */
    async search(query, opts = {}) {
        const { signal, ...rest } = opts;
        const r = await this.tools.call("web_search", { query, ...rest }, signal ? { signal } : undefined);
        return r.data?.results ?? [];
    }
    /** Reads a page: its main content as text (`format: "html"` for the HTML as it is). */
    async fetch(url, opts = {}) {
        const args = { url };
        if (opts.format)
            args.format = opts.format;
        if (opts.maxChars)
            args.max_chars = opts.maxChars;
        const r = await this.tools.call("web_fetch", args, opts.signal ? { signal: opts.signal } : undefined);
        return r.data;
    }
}
//# sourceMappingURL=tools.js.map