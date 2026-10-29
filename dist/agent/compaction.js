// Compaction: when the transcript nears the model's window, the older
// turns are summarised by the model into a structured checkpoint that
// replaces them, and the recent turns stay verbatim. Ported from pi
// (github.com/earendil-works/pi, MIT): the prompts, the serialisation
// of the conversation as text (so the model summarises instead of
// continuing it) and the cut-point rules are theirs.
import { estimateTokens, groupTurns } from "./context.js";
export const DEFAULT_COMPACTION = { reserveTokens: 16_384, keepRecentTokens: 20_000 };
export const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const TOOL_RESULT_MAX_CHARS = 2000;
/** The summary a compaction message carries, or null for any other message. */
export function summaryOf(m) {
    if (m.role !== "user" || typeof m.content !== "string")
        return null;
    if (!m.content.startsWith(COMPACTION_SUMMARY_PREFIX) || !m.content.endsWith(COMPACTION_SUMMARY_SUFFIX))
        return null;
    return m.content.slice(COMPACTION_SUMMARY_PREFIX.length, m.content.length - COMPACTION_SUMMARY_SUFFIX.length);
}
export function summaryMessage(summary) {
    return { role: "user", content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX };
}
export function resolveSettings(window, s = {}) {
    return {
        reserveTokens: Math.min(s.reserveTokens ?? DEFAULT_COMPACTION.reserveTokens, Math.floor(window * 0.2)),
        keepRecentTokens: Math.min(s.keepRecentTokens ?? DEFAULT_COMPACTION.keepRecentTokens, Math.floor(window * 0.4)),
    };
}
export function shouldCompact(contextTokens, window, s) {
    return contextTokens > window - s.reserveTokens;
}
/**
 * Splits the transcript at a turn boundary so that about
 * `keepRecentTokens` of the newest turns stay. Never splits a turn (a
 * tool call from its result); the newest turn always stays; null when
 * there is nothing older to summarise.
 */
export function planCut(messages, keepRecentTokens) {
    const turns = groupTurns(messages);
    if (turns.length < 2)
        return null;
    let acc = 0;
    let cut = turns.length - 1;
    for (let i = turns.length - 1; i >= 1; i--) {
        acc += estimateTokens(turns[i]);
        cut = i;
        if (acc >= keepRecentTokens)
            break;
    }
    const older = turns.slice(0, cut).flat();
    if (!older.length)
        return null;
    let previousSummary;
    const toSummarize = [];
    for (const m of older) {
        const s = summaryOf(m);
        if (s !== null && previousSummary === undefined)
            previousSummary = s;
        else
            toSummarize.push(m);
    }
    if (!toSummarize.length)
        return null;
    return { toSummarize, previousSummary, kept: turns.slice(cut).flat() };
}
/** The conversation as text, so the summariser describes it instead of continuing it. */
export function serializeConversation(messages) {
    const parts = [];
    for (const m of messages) {
        const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
        if (m.role === "user") {
            if (text)
                parts.push(`[User]: ${text}`);
        }
        else if (m.role === "assistant") {
            if (text)
                parts.push(`[Assistant]: ${text}`);
            if (m.tool_calls?.length) {
                parts.push(`[Assistant tool calls]: ${m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join("; ")}`);
            }
        }
        else if (m.role === "tool") {
            if (text)
                parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
        }
    }
    return parts.join("\n\n");
}
function truncateForSummary(text, max) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}\n\n[... ${text.length - max} more characters truncated]`;
}
/** The messages of a summarisation request. */
export function summarizationMessages(toSummarize, previousSummary) {
    let prompt = `<conversation>\n${serializeConversation(toSummarize)}\n</conversation>\n\n`;
    if (previousSummary)
        prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    prompt += previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    return [
        { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: "user", content: prompt },
    ];
}
//# sourceMappingURL=compaction.js.map