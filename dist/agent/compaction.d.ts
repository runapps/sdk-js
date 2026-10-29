import type { ChatMessage } from "../chat.js";
export interface CompactionSettings {
    /** Compact when the context is within this many tokens of the window (default 16 384, at most 20 % of the window). */
    reserveTokens: number;
    /** Keep about this many tokens of recent turns verbatim (default 20 000, at most 40 % of the window). */
    keepRecentTokens: number;
}
export declare const DEFAULT_COMPACTION: CompactionSettings;
export declare const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export declare const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
export declare const SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
export declare const SUMMARIZATION_PROMPT = "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\nUse this EXACT format:\n\n## Goal\n[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned by user]\n- [Or \"(none)\" if none were mentioned]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Current work]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [Ordered list of what should happen next]\n\n## Critical Context\n- [Any data, examples, or references needed to continue]\n- [Or \"(none)\" if not applicable]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";
export declare const UPDATE_SUMMARIZATION_PROMPT = "The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\nUpdate the existing structured summary with new information. RULES:\n- PRESERVE all existing information from the previous summary\n- ADD new progress, decisions, and context from the new messages\n- UPDATE the Progress section: move items from \"In Progress\" to \"Done\" when completed\n- UPDATE \"Next Steps\" based on what was accomplished\n- PRESERVE exact file paths, function names, and error messages\n- If something is no longer relevant, you may remove it\n\nUse this EXACT format:\n\n## Goal\n[Preserve existing goals, add new ones if the task expanded]\n\n## Constraints & Preferences\n- [Preserve existing, add new ones discovered]\n\n## Progress\n### Done\n- [x] [Include previously done items AND newly completed items]\n\n### In Progress\n- [ ] [Current work - update based on progress]\n\n### Blocked\n- [Current blockers - remove if resolved]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n## Next Steps\n1. [Update based on current state]\n\n## Critical Context\n- [Preserve important context, add new if needed]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";
/** The summary a compaction message carries, or null for any other message. */
export declare function summaryOf(m: ChatMessage): string | null;
export declare function summaryMessage(summary: string): ChatMessage;
export declare function resolveSettings(window: number, s?: Partial<CompactionSettings>): CompactionSettings;
export declare function shouldCompact(contextTokens: number, window: number, s: CompactionSettings): boolean;
export interface CutPlan {
    /** Turns to summarise (whole turns, oldest first), minus any earlier summary message. */
    toSummarize: ChatMessage[];
    /** The earlier summary, when the transcript already had one. */
    previousSummary?: string;
    /** Turns kept verbatim. */
    kept: ChatMessage[];
}
/**
 * Splits the transcript at a turn boundary so that about
 * `keepRecentTokens` of the newest turns stay. Never splits a turn (a
 * tool call from its result); the newest turn always stays; null when
 * there is nothing older to summarise.
 */
export declare function planCut(messages: ChatMessage[], keepRecentTokens: number): CutPlan | null;
/** The conversation as text, so the summariser describes it instead of continuing it. */
export declare function serializeConversation(messages: ChatMessage[]): string;
/** The messages of a summarisation request. */
export declare function summarizationMessages(toSummarize: ChatMessage[], previousSummary?: string): ChatMessage[];
//# sourceMappingURL=compaction.d.ts.map