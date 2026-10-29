// defineTool: the one way to declare a tool for the agent; plus the
// helpers the loop uses to turn a tool into the chat schema and a tool's
// return value into what the model reads.
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_MAX_RESULT_CHARS = 32_000;
/**
 * Declares a tool. Checks the name and fills in an empty-object schema
 * when the tool takes no arguments. The JSON Schema in `parameters`
 * should close objects with `additionalProperties: false` and list
 * `required` fields: the model's arguments are checked against it before
 * `execute` runs, and a mismatch is reported back to the model.
 */
export function defineTool(def) {
    if (!NAME_RE.test(def.name)) {
        throw new Error(`runapps agent: tool name "${def.name}" must match ${NAME_RE}`);
    }
    if (!def.description || !def.description.trim()) {
        throw new Error(`runapps agent: tool "${def.name}" needs a description`);
    }
    const parameters = def.parameters ?? { type: "object", properties: {}, additionalProperties: false };
    return { ...def, parameters };
}
export function toChatTool(tool) {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    };
}
/** Turns whatever `execute` returned into the tool message. */
export function normalizeResult(value, maxChars = DEFAULT_MAX_RESULT_CHARS) {
    let content;
    let details;
    if (value === undefined || value === null) {
        content = "OK";
    }
    else if (typeof value === "string") {
        content = value.length ? value : "OK";
    }
    else if (Array.isArray(value) && value.every(isContentPart)) {
        content = value;
    }
    else if (isWrapped(value)) {
        content = value.content;
        details = value.details;
        if (typeof content === "string" && !content.length)
            content = "OK";
    }
    else {
        content = JSON.stringify(value);
    }
    let truncated = false;
    if (typeof content === "string") {
        const t = truncate(content, maxChars);
        truncated = t.truncated;
        content = t.text;
    }
    else {
        content = content.map((p) => {
            if (p.type !== "text")
                return p;
            const t = truncate(p.text, maxChars);
            if (t.truncated)
                truncated = true;
            return { type: "text", text: t.text };
        });
    }
    return { content, text: typeof content === "string" ? content : textOf(content), details, truncated };
}
function isContentPart(p) {
    return !!p && typeof p === "object" && typeof p.type === "string" &&
        ["text", "image_url", "video_url", "audio_url"].includes(p.type);
}
function isWrapped(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        return false;
    const c = v.content;
    const keys = Object.keys(v);
    return (typeof c === "string" || (Array.isArray(c) && c.every(isContentPart))) &&
        keys.every((k) => k === "content" || k === "details");
}
export function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return { text, truncated: false };
    const kept = text.slice(0, Math.max(0, maxChars - 120));
    const more = text.length - kept.length;
    return {
        text: `${kept}\n\n[... ${more} more characters not shown. Ask for a narrower range or a smaller result.]`,
        truncated: true,
    };
}
/** The text of a content-parts array (images noted, not included). */
export function textOf(content) {
    if (!content)
        return "";
    if (typeof content === "string")
        return content;
    return content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
}
//# sourceMappingURL=tool.js.map