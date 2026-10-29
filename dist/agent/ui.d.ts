import type { AgentUI, Tool } from "./types.js";
/** `AgentUI` on plain `<dialog>` elements; outside a document it refuses everything. */
export declare function domUI(): AgentUI;
/** An `AgentUI` with no user: every question is declined. */
export declare function nullUI(): AgentUI;
/** The `ask_user` tool: up to three questions, each with options or free text. */
export declare function askUserTool(): Tool;
//# sourceMappingURL=ui.d.ts.map