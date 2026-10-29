import type { Workspace } from "./workspace.js";
export declare const PROMPTS_ROOT = "/prompts";
export interface PromptTemplate {
    name: string;
    description: string;
    argumentHint?: string;
    path: string;
}
/** Bash-style argument splitting: quotes group words, "" is an empty argument. */
export declare function parseCommandArgs(argsString: string): string[];
/**
 * `$1`…`$N`, `$@` / `$ARGUMENTS` (all), `${N:-default}`, `${@:-default}`,
 * `${@:N}` and `${@:N:L}` (slices). Values are not substituted again.
 */
export declare function substituteArgs(content: string, args: string[]): string;
/** The templates under /prompts (name = file name without .md). */
export declare function listTemplates(ws: Workspace): Promise<PromptTemplate[]>;
/**
 * Expands a prompt that starts with `/`: `/skill:name args` → the skill's
 * instructions (as pi words them) plus the arguments; `/name args` → the
 * template's body with its placeholders filled. Anything else is
 * returned unchanged.
 */
export declare function expandSlash(ws: Workspace | null, text: string): Promise<string>;
//# sourceMappingURL=templates.d.ts.map