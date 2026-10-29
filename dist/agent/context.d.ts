import type { ChatMessage } from "../chat.js";
import type { Skill, Tool } from "./types.js";
export interface SystemPromptInput {
    appName?: string;
    instructions?: string;
    tools: Tool[];
    workspaceDescription?: string;
    skills: Skill[];
    hasSandbox: boolean;
    hasAskUser: boolean;
    /** The workspace has write_file/edit_file (memory notes can be kept). */
    canWrite: boolean;
    /** `/AGENTS.md` from the workspace, when present. */
    agentsMd?: string;
    /** `/memory/notes.md` from the workspace, when present. */
    memory?: string;
    droppedTurns: number;
    now?: Date;
}
export declare function buildSystemPrompt(input: SystemPromptInput): string;
/** The gateway's own estimate: a token per 3 bytes, 1600 per image. */
export declare function estimateTokens(messages: ChatMessage[], system?: string): number;
export interface FitResult {
    messages: ChatMessage[];
    droppedTurns: number;
    elidedResults: number;
}
/**
 * Groups the transcript into turns (each starting at a user message) and
 * trims it to `budget` tokens: first the tool results of turns older than
 * the last `keepTurns` are elided, then the oldest turns are dropped
 * whole. The last turn is never dropped.
 */
export declare function fitBudget(messages: ChatMessage[], opts: {
    budget: number;
    keepTurns: number;
    system?: string;
    elideAbove?: number;
}): FitResult;
/** Splits at each user message that is not a tool result. */
export declare function groupTurns(messages: ChatMessage[]): ChatMessage[][];
//# sourceMappingURL=context.d.ts.map