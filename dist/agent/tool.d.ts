import type { ChatTool, ContentPart } from "../chat.js";
import type { Tool, ToolDefinition, ToolResultValue } from "./types.js";
export declare const DEFAULT_MAX_RESULT_CHARS = 32000;
/**
 * Declares a tool. Checks the name and fills in an empty-object schema
 * when the tool takes no arguments. The JSON Schema in `parameters`
 * should close objects with `additionalProperties: false` and list
 * `required` fields: the model's arguments are checked against it before
 * `execute` runs, and a mismatch is reported back to the model.
 */
export declare function defineTool<A = Record<string, unknown>>(def: ToolDefinition<A>): Tool<A>;
export declare function toChatTool(tool: Tool<unknown>): ChatTool;
export interface NormalizedResult {
    /** What the model gets as the tool message content. */
    content: string | ContentPart[];
    /** The text form (for events and the loop guard). */
    text: string;
    details?: unknown;
    truncated: boolean;
}
/** Turns whatever `execute` returned into the tool message. */
export declare function normalizeResult(value: ToolResultValue, maxChars?: number): NormalizedResult;
export declare function truncate(text: string, maxChars: number): {
    text: string;
    truncated: boolean;
};
/** The text of a content-parts array (images noted, not included). */
export declare function textOf(content: string | ContentPart[] | null | undefined): string;
//# sourceMappingURL=tool.d.ts.map