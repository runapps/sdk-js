// Agent: the model ↔ tool loop. One `prompt()` is a run; a run is turns
// of one model call each followed by that call's tool batch, until the
// model answers without tools (or the run is stopped). Everything the
// app shows comes through `on()` events; what the app owns (dialogs,
// files, skills, tools) comes in through the options.
import { APIError } from "../errors.js";
import { collectCompletion } from "./completion.js";
import { buildSystemPrompt, estimateTokens, fitBudget } from "./context.js";
import { fileTools } from "./file-tools.js";
import { validateSchema } from "./json-schema.js";
import { sandboxTool } from "./sandbox.js";
import { normalizeResult, textOf, toChatTool } from "./tool.js";
import { askUserTool, domUI } from "./ui.js";
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_INPUT_TOKENS = 128_000;
const BUDGET_SHARE = 0.8;
const MAX_RETRIES = 3;
const LOOP_WARN = 3;
const LOOP_STOP = 6;
export class Agent {
    id;
    client;
    ui;
    workspace;
    tools;
    opts;
    history = [];
    committed = 0;
    droppedTurns = 0;
    _usage = { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 };
    handlers = new Map();
    anyHandlers = new Set();
    queue = [];
    current = null;
    chain = Promise.resolve();
    pendingSkills = [];
    inputTokens = null;
    lastBatches = [];
    loopWarned = false;
    constructor(client, opts = {}) {
        this.client = client;
        this.opts = opts;
        this.id = opts.id || `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        this.ui = opts.ui ?? domUI();
        this.workspace = opts.workspace ?? null;
        const tools = [...(opts.tools ?? [])];
        if (this.workspace && opts.fileTools !== false) {
            const want = Array.isArray(opts.fileTools) ? new Set(opts.fileTools) : null;
            tools.push(...fileTools(this.workspace).filter((t) => !want || want.has(t.name)));
        }
        if (opts.askUser !== false)
            tools.push(askUserTool());
        if (opts.sandbox !== false)
            tools.push(sandboxTool(this.workspace, typeof opts.sandbox === "object" ? opts.sandbox : {}));
        const seen = new Set();
        for (const t of tools) {
            if (seen.has(t.name))
                throw new Error(`runapps agent: two tools are named "${t.name}"`);
            seen.add(t.name);
        }
        this.tools = tools;
        if (opts.serverTools?.length && (opts.tools?.length || this.workspace || opts.sandbox !== false || opts.askUser !== false)) {
            throw new Error("runapps agent: serverTools work only for an agent with no tools of its own (tools: [], workspace: null, sandbox: false, askUser: false) — the gateway runs that loop");
        }
        if (opts.restore) {
            if (opts.restore.v !== 1)
                throw new Error("runapps agent: unknown session format");
            this.history = opts.restore.messages.slice();
            this.committed = this.history.length;
            this.droppedTurns = opts.restore.droppedTurns ?? 0;
            this._usage = { ...opts.restore.usage };
        }
    }
    on(name, handler) {
        if (name === "*") {
            this.anyHandlers.add(handler);
            return () => { this.anyHandlers.delete(handler); };
        }
        let set = this.handlers.get(name);
        if (!set) {
            set = new Set();
            this.handlers.set(name, set);
        }
        set.add(handler);
        return () => { this.handlers.get(name)?.delete(handler); };
    }
    emit(name, event) {
        for (const h of this.handlers.get(name) ?? []) {
            try {
                h(event);
            }
            catch (err) {
                console.error("[runapps agent] listener for", name, "threw:", err);
            }
        }
        for (const h of this.anyHandlers) {
            try {
                h(name, event);
            }
            catch (err) {
                console.error("[runapps agent] listener threw:", err);
            }
        }
    }
    /* ---------------- state ---------------- */
    /** The transcript (a copy), without the system prompt. */
    get messages() {
        return this.history.slice();
    }
    get usage() {
        return { ...this._usage };
    }
    get busy() {
        return this.current !== null;
    }
    get model() {
        return this.opts.model;
    }
    set model(name) {
        this.opts.model = name;
        this.inputTokens = null;
    }
    /** A snapshot to save (`restore` continues it). Taken at the last complete turn. */
    export() {
        return {
            v: 1,
            model: this.opts.model,
            messages: this.history.slice(0, this.committed),
            usage: { ...this._usage },
            droppedTurns: this.droppedTurns,
            savedAt: Date.now(),
        };
    }
    /** Forgets the conversation (the workspace stays). */
    reset() {
        if (this.current)
            throw new Error("runapps agent: cannot reset while a run is active; abort() first");
        this.history = [];
        this.committed = 0;
        this.droppedTurns = 0;
        this.lastBatches = [];
        this.loopWarned = false;
    }
    /**
     * Loads a skill for the next prompt: its instructions are placed before
     * the user's message, as if the user had asked for that skill.
     */
    useSkill(name) {
        if (!this.workspace)
            throw new Error("runapps agent: useSkill needs a workspace");
        this.pendingSkills.push(name);
    }
    /* ---------------- input ---------------- */
    /**
     * Sends a user message and runs until the model answers. While a run is
     * active the message is queued as a follow-up (same as `followUp`).
     */
    prompt(content, init = {}) {
        const message = this.userMessage(content);
        if (this.current)
            return this.enqueue("followUp", message);
        return this.start(message, init.signal);
    }
    /** Adds guidance that the model sees after the current tool batch; queued when idle like `prompt`. */
    steer(content) {
        const message = this.userMessage(content);
        if (!this.current)
            return this.start(message);
        this.queue.push({ kind: "steer", message });
        this.emit("queued", { kind: "steer", message });
    }
    /** Runs after the current run has finished. */
    followUp(content) {
        const message = this.userMessage(content);
        if (!this.current)
            return this.start(message);
        return this.enqueue("followUp", message);
    }
    /** Stops the current run (pending tool calls get a "skipped" result) and drops the queue. */
    async abort() {
        this.queue = [];
        const cur = this.current;
        if (!cur)
            return;
        cur.controller.abort();
        await cur.promise.catch(() => undefined);
    }
    enqueue(kind, message) {
        return new Promise((resolve) => {
            this.queue.push({ kind, message, resolve });
            this.emit("queued", { kind, message });
        });
    }
    userMessage(content) {
        const parts = typeof content === "string" ? [{ type: "text", text: content }] : content.slice();
        return { role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts };
    }
    start(message, signal) {
        const controller = new AbortController();
        if (signal) {
            if (signal.aborted)
                controller.abort();
            else
                signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        const promise = this.chain.then(() => this.run(message, controller)).finally(() => {
            if (this.current?.controller === controller)
                this.current = null;
            this.drainFollowUps();
        });
        this.current = { controller, promise };
        this.chain = promise.catch(() => undefined);
        return promise;
    }
    drainFollowUps() {
        const next = this.queue.find((q) => q.kind === "followUp");
        if (!next)
            return;
        this.queue = this.queue.filter((q) => q !== next);
        this.start(next.message).then((r) => next.resolve?.(r), () => undefined);
    }
    /* ---------------- the loop ---------------- */
    async run(message, controller) {
        const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const signal = controller.signal;
        const usageBefore = { ...this._usage };
        let reason = "done";
        let error;
        let lastText = "";
        let truncatedRounds = 0;
        const prefaced = await this.withSkillPrefaces(message);
        this.history.push(prefaced);
        this.emit("run_start", { runId, message: prefaced });
        const maxTurns = this.opts.maxTurns ?? DEFAULT_MAX_TURNS;
        const maxTokens = this.opts.maxTokens ?? DEFAULT_MAX_TOKENS;
        const budget = Math.floor((await this.contextTokens()) * BUDGET_SHARE);
        try {
            for (let turn = 1;; turn++) {
                if (signal.aborted) {
                    reason = "aborted";
                    break;
                }
                if (turn > maxTurns) {
                    reason = "max_turns";
                    break;
                }
                this.emit("turn_start", { runId, turn });
                // Steering arrives between tool batches.
                for (const q of this.queue.filter((q) => q.kind === "steer"))
                    this.history.push(q.message);
                this.queue = this.queue.filter((q) => q.kind !== "steer");
                const system = buildSystemPrompt({
                    appName: this.opts.appName,
                    instructions: typeof this.opts.instructions === "function" ? this.opts.instructions() : this.opts.instructions,
                    tools: this.tools,
                    workspaceDescription: this.workspace ? this.workspace.describe() : undefined,
                    skills: this.workspace ? await this.workspace.skills() : [],
                    hasSandbox: this.tools.some((t) => t.name === "run_js"),
                    hasAskUser: this.tools.some((t) => t.name === "ask_user"),
                    droppedTurns: this.droppedTurns,
                });
                const fit = fitBudget(this.history, { budget, keepTurns: this.opts.keepTurns ?? 4, system });
                if (fit.droppedTurns || fit.elidedResults) {
                    this.history = fit.messages;
                    this.droppedTurns += fit.droppedTurns;
                    this.emit("compaction", { runId, droppedTurns: fit.droppedTurns, elidedResults: fit.elidedResults });
                }
                const params = {
                    ...(this.opts.extra ?? {}),
                    model: this.opts.model ?? "",
                    messages: [{ role: "system", content: system }, ...this.history],
                    max_tokens: maxTokens,
                };
                if (!params.model)
                    delete params.model;
                if (this.tools.length)
                    params.tools = this.tools.map((t) => toChatTool(t));
                if (this.opts.serverTools?.length)
                    params.server_tools = this.opts.serverTools;
                if (this.opts.prompt)
                    params.prompt = this.opts.prompt;
                if (this.opts.temperature !== undefined)
                    params.temperature = this.opts.temperature;
                if (this.opts.top_p !== undefined)
                    params.top_p = this.opts.top_p;
                const completion = await this.callModel(params, runId, signal);
                if (completion.usage)
                    this.addUsage(completion.usage);
                const assistant = { role: "assistant", content: completion.message.content };
                if (completion.message.tool_calls?.length)
                    assistant.tool_calls = completion.message.tool_calls;
                this.history.push(assistant);
                if (typeof assistant.content === "string" && assistant.content)
                    lastText = assistant.content;
                const truncated = completion.finishReason === "length";
                this.emit("message_end", { runId, message: assistant, truncated });
                this.emit("turn_end", { runId, turn, usage: completion.usage });
                const calls = assistant.tool_calls ?? [];
                if (!calls.length) {
                    this.committed = this.history.length;
                    if (truncated && this.balanceLimited(completion.usage, maxTokens)) {
                        reason = "error";
                        error = new APIError(402, "insufficient_balance", "runapps agent: the reply was cut short because the balance could not cover a full answer; top up to continue");
                    }
                    break;
                }
                const results = await this.runBatch(calls, runId, signal, truncated);
                this.committed = this.history.length;
                if (signal.aborted) {
                    reason = "aborted";
                    break;
                }
                if (truncated) {
                    truncatedRounds++;
                    if (this.balanceLimited(completion.usage, maxTokens)) {
                        reason = "error";
                        error = new APIError(402, "insufficient_balance", "runapps agent: the reply was cut short because the balance could not cover a full answer; top up to continue");
                        break;
                    }
                    if (truncatedRounds >= 2) {
                        reason = "error";
                        error = new Error("runapps agent: the model's tool calls were cut off by the output limit twice in a row");
                        break;
                    }
                }
                const guard = this.checkLoop(results);
                if (guard === "stop") {
                    reason = "error";
                    error = new Error("runapps agent: stopped after repeating the same tool calls without progress");
                    break;
                }
                if (guard === "warn") {
                    this.history.push({
                        role: "user",
                        content: "[environment] The last rounds repeated the same tool calls with the same results. Do not repeat them; either take a different approach or explain the blocker and finish.",
                    });
                }
            }
        }
        catch (err) {
            if (signal.aborted)
                reason = "aborted";
            else {
                reason = "error";
                error = err instanceof Error ? err : new Error(String(err));
            }
        }
        if (reason === "aborted")
            this.closeOpenToolCalls();
        this.committed = this.history.length;
        this.lastBatches = [];
        this.loopWarned = false;
        const result = {
            runId,
            reason,
            text: lastText,
            usage: this.usage,
            ...(error ? { error } : {}),
        };
        void usageBefore;
        this.emit("run_end", result);
        return result;
    }
    /** One model call with retries for transient failures. */
    async callModel(params, runId, signal) {
        let text = "";
        let reasoning = "";
        let streamed = false;
        for (let attempt = 1;; attempt++) {
            text = "";
            reasoning = "";
            try {
                return await collectCompletion((p, init) => this.client.chat.stream(p, init), params, {
                    signal,
                    onText: (delta, all) => {
                        streamed = true;
                        text = all;
                        this.emit("text_delta", { runId, delta, text: all });
                    },
                    onReasoning: (delta, all) => {
                        streamed = true;
                        reasoning = all;
                        this.emit("reasoning_delta", { runId, delta, text: all });
                    },
                });
            }
            catch (err) {
                if (signal.aborted)
                    throw err;
                if (attempt >= MAX_RETRIES || !isTransient(err))
                    throw err;
                const wait = retryDelay(err, attempt);
                if (streamed)
                    this.emit("message_reset", { runId, reason: err.message });
                streamed = false;
                await sleep(wait, signal);
            }
        }
    }
    async runBatch(calls, runId, signal, truncated) {
        const run = (call) => this.runTool(call, runId, signal, truncated);
        const outcomes = this.opts.parallelTools
            ? await Promise.all(calls.map((c) => run(c)))
            : await (async () => {
                const out = [];
                for (const c of calls)
                    out.push(await run(c));
                return out;
            })();
        for (const o of outcomes)
            this.history.push(o.message);
        return outcomes.map((o) => o.fingerprint);
    }
    async runTool(call, runId, signal, truncated) {
        const id = call.id ?? "";
        const name = call.function.name;
        const started = Date.now();
        const finish = (status, content, details) => {
            const result = textOf(content);
            this.emit("tool_end", { runId, id, name, status, result, details, durationMs: Date.now() - started });
            return { message: { role: "tool", tool_call_id: id, content }, fingerprint: `${name}|${call.function.arguments}|${status}|${result.slice(0, 2000)}` };
        };
        if (signal.aborted)
            return finish("skipped", "Skipped: the user stopped the run.");
        const tool = this.tools.find((t) => t.name === name);
        let args;
        try {
            args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
        }
        catch {
            this.emit("tool_start", { runId, id, name, args: call.function.arguments });
            return finish("error", truncated
                ? "Error: the arguments were cut off because the reply hit the output limit. Make smaller calls (for example, write the file in parts)."
                : "Error: the arguments are not valid JSON.");
        }
        this.emit("tool_start", { runId, id, name, args });
        if (!tool)
            return finish("error", `Error: there is no tool named "${name}". Available tools: ${this.tools.map((t) => t.name).join(", ")}.`);
        if (args === null || typeof args !== "object" || Array.isArray(args))
            return finish("error", "Error: the arguments must be a JSON object.");
        const problems = validateSchema(tool.parameters, args);
        if (problems.length)
            return finish("error", `Error: invalid arguments for ${name}:\n- ${problems.join("\n- ")}\nFix the call and try again.`);
        // Gate: hook, permissions, the tool's own confirm.
        try {
            const hook = await this.opts.onToolCall?.({ id, name, args, tool });
            if (hook && hook.block)
                return finish("blocked", `${hook.reason ?? "This action was not allowed."} Do not retry it another way; say what you would have done.`);
            const allowed = await this.permitted(tool, args);
            if (!allowed)
                return finish("declined", "The user declined this action. Do not retry it another way; say what you would have done.");
        }
        catch (err) {
            if (signal.aborted)
                return finish("skipped", "Skipped: the user stopped the run.");
            return finish("error", `Error: ${err.message}`);
        }
        if (signal.aborted)
            return finish("skipped", "Skipped: the user stopped the run.");
        try {
            const value = await tool.execute(args, {
                signal,
                ui: this.ui,
                workspace: this.workspace,
                agent: this,
                callId: id,
                update: (content) => this.emit("tool_update", { runId, id, name, content }),
            });
            if (signal.aborted)
                return finish("skipped", "Skipped: the user stopped the run.");
            const norm = normalizeResult(value, tool.maxResultChars);
            return finish("ok", norm.content, norm.details);
        }
        catch (err) {
            if (signal.aborted)
                return finish("skipped", "Skipped: the user stopped the run.");
            const msg = err instanceof Error ? err.message : String(err);
            return finish("error", msg.startsWith("Error:") ? msg : `Error: ${msg}`);
        }
    }
    async permitted(tool, args) {
        const p = this.opts.permissions ?? "ask";
        if (typeof p === "function")
            return p({ name: tool.name, args, tool });
        if (p === "auto")
            return true;
        let question = false;
        if (tool.confirm)
            question = await tool.confirm(args);
        else if (tool.destructive)
            question = `Allow ${tool.name}?`;
        if (question === false)
            return true;
        return this.ui.confirm(question, undefined, { danger: !!tool.destructive });
    }
    /** After an abort, every open tool call gets a result so the transcript stays valid. */
    closeOpenToolCalls() {
        const last = this.history[this.history.length - 1];
        if (!last)
            return;
        let i = this.history.length - 1;
        while (i >= 0 && this.history[i].role === "tool")
            i--;
        const assistant = this.history[i];
        if (!assistant || assistant.role !== "assistant" || !assistant.tool_calls?.length)
            return;
        const answered = new Set(this.history.slice(i + 1).map((m) => m.tool_call_id));
        for (const c of assistant.tool_calls) {
            if (c.id && !answered.has(c.id))
                this.history.push({ role: "tool", tool_call_id: c.id, content: "Skipped: the user stopped the run." });
        }
    }
    checkLoop(fingerprints) {
        const key = fingerprints.slice().sort().join("\n");
        this.lastBatches.push(key);
        if (this.lastBatches.length > LOOP_STOP)
            this.lastBatches.shift();
        const same = (n) => this.lastBatches.length >= n && this.lastBatches.slice(-n).every((k) => k === key);
        if (same(LOOP_STOP))
            return "stop";
        if (same(LOOP_WARN) && !this.loopWarned) {
            this.loopWarned = true;
            return "warn";
        }
        return "ok";
    }
    balanceLimited(usage, maxTokens) {
        // The gateway lowers max_tokens to what the balance covers (never
        // below 1024); a reply cut well short of what we asked for says so.
        const out = usage?.completion_tokens;
        return typeof out === "number" && out > 0 && out < maxTokens * 0.9;
    }
    addUsage(u) {
        this._usage.total_cost = round(this._usage.total_cost + (u.total_cost ?? 0));
        this._usage.prompt_tokens += u.prompt_tokens ?? 0;
        this._usage.completion_tokens += u.completion_tokens ?? 0;
        this._usage.calls++;
    }
    contextTokens() {
        if (typeof this.opts.maxInputTokens === "number")
            return Promise.resolve(this.opts.maxInputTokens);
        if (!this.inputTokens) {
            this.inputTokens = (async () => {
                try {
                    const models = await this.client.models.list();
                    const want = this.opts.model?.toLowerCase();
                    const m = want ? models.find((x) => x.id.toLowerCase() === want) : models.find((x) => x.is_default && (x.capability === "text"));
                    const n = m?.max_input_tokens;
                    return typeof n === "number" && n > 0 ? n : DEFAULT_INPUT_TOKENS;
                }
                catch {
                    return DEFAULT_INPUT_TOKENS;
                }
            })();
        }
        return this.inputTokens;
    }
    async withSkillPrefaces(message) {
        if (!this.pendingSkills.length || !this.workspace)
            return message;
        const names = this.pendingSkills.splice(0);
        const parts = [];
        for (const name of names) {
            const { skill, body } = await this.workspace.skillBody(name);
            parts.push({ type: "text", text: `[The user invoked the skill "${skill.name}" (${skill.path}). Follow these instructions for the request below.]\n\n${body}` });
        }
        const own = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
        return { role: "user", content: [...parts, ...own] };
    }
    /** Tokens the next request would send (estimate), for status displays. */
    estimateContext() {
        return estimateTokens(this.history);
    }
}
/* ------------------------------------------------------------------ */
function isTransient(err) {
    if (err instanceof APIError)
        return err.statusCode === 408 || err.statusCode === 429 || err.statusCode >= 500 || err.statusCode === 0;
    if (err instanceof Error)
        return /network|fetch failed|ECONNRESET|socket|stream ended before/i.test(err.message) || err.name === "TypeError";
    return false;
}
function retryDelay(err, attempt) {
    const ra = err instanceof APIError ? err.retryAfter : undefined;
    if (typeof ra === "number" && ra > 0)
        return Math.min(30_000, ra * 1000);
    return Math.min(8000, 800 * 2 ** (attempt - 1)) + Math.random() * 300;
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
    });
}
function round(n) {
    return Math.round(n * 1e6) / 1e6;
}
//# sourceMappingURL=agent.js.map