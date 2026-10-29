import type { RunApps } from "../client.js";
import type { ChatMessage, ContentPart } from "../chat.js";
import type { Unsubscribe } from "../events.js";
import type { AgentEventMap, AgentEventName, AgentOptions, AgentUI, AgentUsage, RunResult, SessionData, Tool } from "./types.js";
import { type Workspace } from "./workspace.js";
export type PromptContent = string | ContentPart[];
type Handler<K extends AgentEventName> = (event: AgentEventMap[K]) => void;
type AnyHandler = (name: AgentEventName, event: AgentEventMap[AgentEventName]) => void;
export declare class Agent {
    readonly id: string;
    readonly client: RunApps;
    readonly ui: AgentUI;
    readonly workspace: Workspace | null;
    readonly tools: Tool[];
    private readonly opts;
    private history;
    private committed;
    private droppedTurns;
    private _usage;
    private readonly handlers;
    private readonly anyHandlers;
    private queue;
    private current;
    private chain;
    private pendingSkills;
    private inputTokens;
    private lastBatches;
    private loopWarned;
    private readonly loaded;
    private createdAt;
    private readonly persist;
    constructor(client: RunApps, opts?: AgentOptions);
    private applySession;
    /** Resolves once a saved session (if any) has been loaded. */
    ready(): Promise<void>;
    private saveSession;
    on<K extends AgentEventName>(name: K, handler: Handler<K>): Unsubscribe;
    on(name: "*", handler: AnyHandler): Unsubscribe;
    private emit;
    /** The transcript (a copy), without the system prompt. */
    get messages(): ChatMessage[];
    get usage(): AgentUsage;
    get busy(): boolean;
    get model(): string | undefined;
    set model(name: string | undefined);
    /** A snapshot to save (`restore` continues it). Taken at the last complete turn. */
    export(): SessionData;
    /** Forgets the conversation (the workspace stays). */
    reset(): void;
    /**
     * Loads a skill for the next prompt: its instructions are placed before
     * the user's message, as if the user had asked for that skill.
     */
    useSkill(name: string): void;
    /**
     * Sends a user message and runs until the model answers. While a run is
     * active the message is queued as a follow-up (same as `followUp`).
     */
    prompt(content: PromptContent, init?: {
        signal?: AbortSignal;
    }): Promise<RunResult>;
    /** Adds guidance that the model sees after the current tool batch; queued when idle like `prompt`. */
    steer(content: PromptContent): Promise<RunResult> | void;
    /** Runs after the current run has finished. */
    followUp(content: PromptContent): Promise<RunResult>;
    /** Stops the current run (pending tool calls get a "skipped" result) and drops the queue. */
    abort(): Promise<void>;
    private enqueue;
    private userMessage;
    private start;
    private drainFollowUps;
    private run;
    /** The system prompt for the next request (what the model is told). */
    systemPrompt(): Promise<string>;
    /**
     * Summarises the older turns into a checkpoint now (the loop does this
     * by itself when the window is nearly full). Resolves true when a
     * summary replaced older turns.
     */
    compact(): Promise<boolean>;
    private compactWith;
    /** `/skill:name args` and `/template args` in a user message. */
    private expandSlashes;
    /** One model call with retries for transient failures. */
    private callModel;
    private runBatch;
    private runTool;
    private permitted;
    /** After an abort, every open tool call gets a result so the transcript stays valid. */
    private closeOpenToolCalls;
    private checkLoop;
    private balanceLimited;
    private addUsage;
    private contextTokens;
    private withSkillPrefaces;
    /** Tokens the next request would send (estimate), for status displays. */
    estimateContext(): number;
    /** The model's context window in tokens (from the catalogue). */
    contextWindow(): Promise<number>;
}
export {};
//# sourceMappingURL=agent.d.ts.map