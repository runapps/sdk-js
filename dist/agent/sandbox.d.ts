import type { Tool } from "./types.js";
import type { Workspace } from "./workspace.js";
export interface SandboxOptions {
    /** Kill the run after this long (default 10 s, max 60 s). */
    timeoutMs?: number;
    /** Leave fetch/WebSocket available inside the sandbox (default false). */
    network?: boolean;
    /** Longest console output kept (default 20 000 chars). */
    maxLogChars?: number;
}
export interface SandboxResult {
    ok: boolean;
    /** The value the code returned, JSON-serialised. */
    result?: string;
    logs: string;
    error?: string;
    durationMs: number;
}
/** Runs `code` once in a fresh sandbox bound to `ws` (null: no fs). */
export declare function runInSandbox(ws: Workspace | null, code: string, input: unknown, opts?: SandboxOptions & {
    signal?: AbortSignal;
}): Promise<SandboxResult>;
/** The `run_js` tool. */
export declare function sandboxTool(ws: Workspace | null, opts?: SandboxOptions): Tool;
//# sourceMappingURL=sandbox.d.ts.map